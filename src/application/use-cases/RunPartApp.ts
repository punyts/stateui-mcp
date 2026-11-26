import { nearestNames } from '../../domain/nearestNames.js';
import type { JsonObject } from '../../domain/JsonValue.js';
import type { UiPart } from '../../domain/UiPart.js';
import type { UiPreviewDto } from '../dtos/UiPreviewDto.js';
import { toPreviewDto } from '../dtos/UiPreviewDto.js';
import type { InstanceStates } from '../ports/InstanceStates.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UiPreviewLog } from '../ports/UiPreviewLog.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';
import type { RunCommand, RunCommandInput, RunCommandResult } from './RunCommand.js';

export type FindPartAppResult = { readonly kind: 'found'; readonly part: UiPart<'apps'> } | { readonly kind: 'not-found'; readonly nearest: readonly string[] };

/** The app part a run-time tool names, or the nearest app names */
export class FindPartApp {
    constructor(private readonly parts: Pick<UiPartRepository, 'findByName' | 'list'>) {}

    async execute(app: string): Promise<FindPartAppResult> {
        const part = await this.parts.findByName('apps', app);
        if (part !== undefined) return { kind: 'found', part };
        return { kind: 'not-found', nearest: nearestNames(app, (await this.parts.list('apps')).map((summary) => summary.name)) };
    }
}

/** What is at one state path: `found` is false when a step is missing, and `closest` is then the last step that exists */
export interface PartStateAt {
    readonly found: boolean;
    readonly value: unknown;
    readonly closest: string;
    /** Where the value was read: the instance, or the definition for a node property the instance has not changed */
    readonly source: 'instance' | 'definition';
}

export interface PartStateResult {
    readonly app: string;
    /** The app part's revision: using the app never raises it */
    readonly revision: number;
    /** The state of the owner's own running instance */
    readonly state: JsonObject;
    readonly source: 'instance';
    readonly preview: UiPreviewDto;
    /** What is at the path asked for; absent without a path */
    readonly at?: PartStateAt;
}

/** The steps of a state path such as `$.data.cart`; the leading `$.` is optional */
function stepsOf(path: string): string[] {
    return path
        .replace(/^\$\.?/, '')
        .split('.')
        .filter((step) => step !== '');
}

/** The value below `root` at `steps`, and the steps that exist when one is missing */
function walk(root: unknown, steps: readonly string[]): { found: boolean; value: unknown; walked: string[] } {
    let current: unknown = root;
    const walked: string[] = [];
    for (const step of steps) {
        if (current === null || typeof current !== 'object' || !Object.hasOwn(current, step)) return { found: false, value: undefined, walked };
        current = (current as Record<string, unknown>)[step];
        walked.push(step);
    }
    return { found: true, value: current, walked };
}

/**
 * The steps of a node path in the assembled document: `$.app…` is the app node and `$.screens.{name}…` the root of a
 * screen, which the document keeps under `root`. Undefined for a path that is not below a node
 */
function definitionSteps(steps: readonly string[]): string[] | undefined {
    if (steps[0] === 'app') return [...steps];
    if (steps[0] === 'screens' && steps.length >= 2) return ['screens', steps[1] as string, 'root', ...steps.slice(2)];
    return undefined;
}

const statePathOf = (steps: readonly string[]): string => (steps.length === 0 ? '$' : `$.${steps.join('.')}`);

/**
 * The state of the owner's own instance of an app part, read from its running authority (started over the
 * definition and the stored instance when nothing runs it yet), with what its views report.
 *
 * The instance keeps `$.app` and `$.screens` sparse: only what a user, a tool or the logic changed. With a `path`,
 * a node path the instance does not have is read from the definition, so a property that still has its definition
 * value (a window's `hidden: true` nothing has written yet) is found, as the running app has it
 */
export class GetPartState {
    constructor(
        private readonly states: Pick<InstanceStates, 'state' | 'shape'>,
        private readonly previewLog: UiPreviewLog,
        private readonly now: () => Date,
        private readonly report: UseCaseReport
    ) {}

    async execute(part: UiPart<'apps'>, path?: string): Promise<PartStateResult> {
        const state = await this.states.state(part);
        const preview = toPreviewDto(await this.previewLog.status(part.id, this.now()));
        const at = path === undefined ? undefined : await this.valueAt(part, state, path);
        this.report.info('Instance state read', { app: part.name, previewAttached: preview.attached, ...(at !== undefined && { found: at.found, from: at.source }) });
        return { app: part.name, revision: part.revision, state, source: 'instance', preview, ...(at !== undefined && { at }) };
    }

    private async valueAt(part: UiPart<'apps'>, state: JsonObject, path: string): Promise<PartStateAt> {
        const steps = stepsOf(path);
        const own = walk(state, steps);
        if (own.found) return { found: true, value: own.value, closest: path, source: 'instance' };
        const inDocument = definitionSteps(steps);
        if (inDocument === undefined) return { found: false, value: undefined, closest: statePathOf(own.walked), source: 'instance' };
        const defined = walk((await this.states.shape(part)).document, inDocument);
        if (defined.found) return { found: true, value: defined.value, closest: path, source: 'definition' };
        // The steps the definition has, counted as state path steps: a screen's `root` is not one
        const reached = defined.walked.length - (steps[0] === 'screens' && defined.walked.length > 2 ? 1 : 0);
        return { found: false, value: undefined, closest: statePathOf(steps.slice(0, Math.max(own.walked.length, reached))), source: 'instance' };
    }
}

/**
 * A component command or a navigate for the views of an app part's instance: checked as `RunCommand` checks one, on the
 * assembled document the instance runs, and issued for the views of the part's id
 */
export class RunPartCommand {
    constructor(
        private readonly states: Pick<InstanceStates, 'shape'>,
        private readonly runCommand: Pick<RunCommand, 'runOn'>
    ) {}

    async execute(part: UiPart<'apps'>, input: RunCommandInput): Promise<RunCommandResult> {
        const { document } = await this.states.shape(part);
        return this.runCommand.runOn(part.id, document, part.revision, input);
    }
}

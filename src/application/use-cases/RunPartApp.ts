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

export interface PartStateResult {
    readonly app: string;
    /** The app part's revision: using the app never raises it */
    readonly revision: number;
    /** The state of the default persona's running instance */
    readonly state: JsonObject;
    readonly source: 'instance';
    readonly preview: UiPreviewDto;
}

/**
 * The state of the default persona's instance of an app part, read from its running authority (started over the
 * definition and the stored instance when nothing runs it yet), with what its views report
 */
export class GetPartState {
    constructor(
        private readonly states: Pick<InstanceStates, 'state'>,
        private readonly previewLog: UiPreviewLog,
        private readonly now: () => Date,
        private readonly report: UseCaseReport
    ) {}

    async execute(part: UiPart<'apps'>): Promise<PartStateResult> {
        const state = await this.states.state(part);
        const preview = toPreviewDto(await this.previewLog.status(part.id, this.now()));
        this.report.info('Instance state read', { app: part.name, previewAttached: preview.attached });
        return { app: part.name, revision: part.revision, state, source: 'instance', preview };
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

import type { PatternKind } from '@punyts/stateui-app/core';
import type { JsonObject } from '../../domain/JsonValue.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import { nearestNames } from '../../domain/nearestNames.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { partNameProblem } from '../../domain/UiPart.js';
import type { UiPartBodies } from '../../domain/UiPart.js';
import type { PatternCatalog } from '../ports/PatternCatalog.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';
import type { WritePart } from './WritePart.js';

type PatternBody = UiPartBodies['patterns'];

/** The screen name `from` takes for the shell of an app */
export const SHELL_SOURCE = 'shell';

/** Where a pattern's tree is copied from: the shell (`screen: "shell"`) or one screen of an owner app */
export interface PatternSource {
    readonly app: string;
    readonly screen: string;
}

export interface WritePatternInput {
    readonly name: string;
    /** Absent: the first write, which creates the pattern. Present: the revision the caller read */
    readonly expectedRevision?: number;
    /** Required to create; kept when absent on an update */
    readonly kind?: PatternKind;
    /** Required to create; kept when absent on an update */
    readonly summary?: string;
    /** Required to create; kept when absent on an update */
    readonly purposes?: readonly string[];
    /** The tree, given directly; or `from`, never both. One of them is required to create; kept when both are absent */
    readonly tree?: JsonObject;
    readonly from?: PatternSource;
    /** Kept when absent on an update; none when absent on a create */
    readonly slots?: JsonObject;
    /** Kept when absent on an update; none when absent on a create */
    readonly params?: JsonObject;
}

export type WritePatternResult =
    | { readonly kind: 'written'; readonly created: boolean; readonly revision: number }
    | { readonly kind: 'invalid-name'; readonly reason: string }
    | { readonly kind: 'duplicate-name' }
    | { readonly kind: 'not-found'; readonly nearest: readonly string[] }
    | { readonly kind: 'conflict'; readonly currentRevision: number }
    /** `from` names an app or screen the owner does not have */
    | { readonly kind: 'source-not-found'; readonly argument: 'from.app' | 'from.screen'; readonly reason: string; readonly nearest: readonly string[] }
    | { readonly kind: 'invalid-argument'; readonly argument: string; readonly reason: string }
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] };

/**
 * Writes an owner pattern: a shell or screen to start from, in the format of the library's `*.pattern.json` files. The
 * tree is given, or copied once from the shell or a screen of an owner app (`from`), and the slots and params name
 * paths of that copy. The part is checked through `WritePart`, which runs the library build's pattern checks, so a
 * slot or param path that is not in the tree, a shell without exactly one outlet or a node that fails its shape fails
 * the write and nothing is stored. A name the library's patterns have is refused, so a `pattern` argument names one
 * pattern. Nothing here ranks or searches: `ui_patterns_search` reads the stored patterns (search epic 2 S2.8)
 */
export class WritePattern {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly writePart: WritePart,
        private readonly patterns: Pick<PatternCatalog, 'get'>,
        private readonly report: UseCaseReport
    ) {}

    async execute(input: WritePatternInput): Promise<WritePatternResult> {
        const result = await this.write(input);
        this.report.info('Pattern write', { outcome: result.kind, ...(result.kind === 'written' && { revision: result.revision, created: result.created }) });
        return result;
    }

    private async write(input: WritePatternInput): Promise<WritePatternResult> {
        if (input.tree !== undefined && input.from !== undefined) {
            return { kind: 'invalid-argument', argument: 'from', reason: 'give the tree or from, not both' };
        }

        let stored: PatternBody | undefined;
        if (input.expectedRevision === undefined) {
            const nameProblem = partNameProblem(input.name);
            if (nameProblem !== undefined) return { kind: 'invalid-name', reason: nameProblem };
            if (this.patterns.get(input.name) !== undefined) {
                return { kind: 'invalid-name', reason: `"${input.name}" is a library pattern; a pattern argument names one pattern, so pick another name` };
            }
            if ((await this.parts.findByName('patterns', input.name)) !== undefined) return { kind: 'duplicate-name' };
            for (const argument of ['kind', 'summary', 'purposes'] as const) {
                if (input[argument] === undefined) return { kind: 'invalid-argument', argument, reason: `${argument} is required to create a pattern` };
            }
            if (input.tree === undefined && input.from === undefined) return { kind: 'invalid-argument', argument: 'tree', reason: 'tree or from is required to create a pattern' };
        } else {
            const part = await this.parts.findByName('patterns', input.name);
            if (part === undefined) return { kind: 'not-found', nearest: nearestNames(input.name, (await this.parts.list('patterns')).map((summary) => summary.name)) };
            if (part.revision !== input.expectedRevision) return { kind: 'conflict', currentRevision: part.revision };
            stored = part.body;
        }

        let tree: JsonObject | undefined = input.tree;
        if (input.from !== undefined) {
            const copied = await this.copyFrom(input.from);
            if (!('tree' in copied)) return copied;
            tree = copied.tree;
        }

        const body = {
            kind: input.kind ?? stored?.kind,
            summary: input.summary ?? stored?.summary,
            purposes: input.purposes ?? stored?.purposes,
            tree: tree ?? stored?.tree,
            slots: input.slots ?? stored?.slots ?? {},
            params: input.params ?? stored?.params ?? {}
        } as unknown as PatternBody;
        const written = await this.writePart.execute({ kind: 'patterns', name: input.name, body, ...(input.expectedRevision !== undefined && { expectedRevision: input.expectedRevision }) });
        switch (written.kind) {
            case 'written':
                return { kind: 'written', created: input.expectedRevision === undefined, revision: written.revision };
            case 'not-found':
                return { kind: 'not-found', nearest: [] };
            default:
                return written;
        }
    }

    /** A copy of the shell or of one screen's root of an owner app */
    private async copyFrom(from: PatternSource): Promise<{ readonly tree: JsonObject } | Extract<WritePatternResult, { kind: 'source-not-found' }>> {
        const app = await this.parts.findByName('apps', from.app);
        if (app === undefined) {
            const nearest = nearestNames(from.app, (await this.parts.list('apps')).map((summary) => summary.name));
            return { kind: 'source-not-found', argument: 'from.app', reason: `the owner has no app "${from.app}"`, nearest };
        }
        const body = app.body as unknown as { shell?: unknown; screens?: Record<string, { root?: unknown }> };
        const source = from.screen === SHELL_SOURCE ? body.shell : body.screens?.[from.screen]?.root;
        if (!isJsonObject(source)) {
            const nearest = nearestNames(from.screen, [SHELL_SOURCE, ...Object.keys(body.screens ?? {})]);
            return { kind: 'source-not-found', argument: 'from.screen', reason: `the app "${from.app}" has no screen "${from.screen}" (use "${SHELL_SOURCE}" for its shell)`, nearest };
        }
        return { tree: structuredClone(source) };
    }
}

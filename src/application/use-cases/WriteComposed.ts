import { mergeSearch, isSearchable, searchFieldProblem } from '../../domain/composedSearch.js';
import type { ComposedSearch } from '../../domain/composedSearch.js';
import type { JsonObject } from '../../domain/JsonValue.js';
import { nearestNames } from '../../domain/nearestNames.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { partNameProblem } from '../../domain/UiPart.js';
import type { UiPartBodies } from '../../domain/UiPart.js';
import type { ComponentCatalog } from '../ports/ComponentCatalog.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';
import type { AppWarning, WritePart } from './WritePart.js';

type ComposedBody = UiPartBodies['components'];

/** One exposed path of a composed component: a path in its tree a user of the component may set or link */
export interface ExposedPathInput {
    readonly path: string;
    readonly description: string;
}

export interface WriteComposedInput {
    readonly name: string;
    /** Absent: the first write, which creates the component. Present: the revision the caller read */
    readonly expectedRevision?: number;
    /** Required to create; kept when absent on an update */
    readonly tree?: JsonObject;
    /** Kept when absent on an update; none when absent on a create */
    readonly exposes?: readonly ExposedPathInput[];
    /** Kept when absent; an empty string removes it */
    readonly summary?: string;
    /** Kept when absent; an empty string removes it */
    readonly category?: string;
    /** Kept when absent; an empty list removes them */
    readonly purposes?: readonly string[];
}

export type WriteComposedResult =
    | {
          readonly kind: 'written';
          readonly created: boolean;
          readonly revision: number;
          /** True when the component has a summary, a category and purposes, so the component search can find it */
          readonly searchable: boolean;
          /** The apps the write breaks, at most `MAX_WARNED_APPS` */
          readonly appWarnings: readonly AppWarning[];
          readonly moreApps: number;
      }
    | { readonly kind: 'invalid-name'; readonly reason: string }
    | { readonly kind: 'duplicate-name' }
    | { readonly kind: 'not-found'; readonly nearest: readonly string[] }
    | { readonly kind: 'conflict'; readonly currentRevision: number }
    /** A search field that breaks its rule, or a create without a tree */
    | { readonly kind: 'invalid-argument'; readonly argument: string; readonly reason: string }
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] };

/**
 * Writes an owner component: its tree and exposed paths, and the search fields `summary`, `category` and `purposes`
 * that the component search reads. The search fields are stored beside the tree, never in it, and a write that leaves
 * one out keeps the stored value. The first write creates the component. The part is checked through `WritePart`: the
 * tree resolves as a composed component (a component that contains itself is `SUI-NODE-CYCLE`), and the apps it breaks
 * come back as warnings. A name the library's catalog has is refused: the library reserves its component names
 */
export class WriteComposed {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly writePart: WritePart,
        private readonly catalog: Pick<ComponentCatalog, 'get'>,
        private readonly report: UseCaseReport
    ) {}

    async execute(input: WriteComposedInput): Promise<WriteComposedResult> {
        const result = await this.write(input);
        this.report.info('Composed component write', {
            outcome: result.kind,
            ...(result.kind === 'written' && { revision: result.revision, created: result.created, searchable: result.searchable })
        });
        return result;
    }

    private async write(input: WriteComposedInput): Promise<WriteComposedResult> {
        const problem = searchFieldProblem(input);
        if (problem !== undefined) return { kind: 'invalid-argument', argument: problem.field, reason: `${problem.field} ${problem.reason}` };

        let stored: ComposedBody | undefined;
        if (input.expectedRevision === undefined) {
            const nameProblem = partNameProblem(input.name);
            if (nameProblem !== undefined) return { kind: 'invalid-name', reason: nameProblem };
            if (this.catalog.get(input.name) !== undefined) {
                return { kind: 'invalid-name', reason: `"${input.name}" is a library component; the library reserves its component names, so pick another name` };
            }
            if ((await this.parts.findByName('components', input.name)) !== undefined) return { kind: 'duplicate-name' };
            if (input.tree === undefined) return { kind: 'invalid-argument', argument: 'tree', reason: 'tree is required to create a component' };
        } else {
            const part = await this.parts.findByName('components', input.name);
            if (part === undefined) return { kind: 'not-found', nearest: nearestNames(input.name, (await this.parts.list('components')).map((summary) => summary.name)) };
            if (part.revision !== input.expectedRevision) return { kind: 'conflict', currentRevision: part.revision };
            stored = part.body;
        }

        const search = mergeSearch((stored ?? {}) as ComposedSearch, input);
        const body = {
            tree: input.tree ?? stored?.tree,
            exposes: input.exposes ?? stored?.exposes ?? [],
            ...search
        } as unknown as ComposedBody;
        const written = await this.writePart.execute({ kind: 'components', name: input.name, body, ...(input.expectedRevision !== undefined && { expectedRevision: input.expectedRevision }) });
        switch (written.kind) {
            case 'written':
                return {
                    kind: 'written',
                    created: input.expectedRevision === undefined,
                    revision: written.revision,
                    searchable: isSearchable(search),
                    appWarnings: written.warnings,
                    moreApps: written.moreApps
                };
            case 'not-found':
                return { kind: 'not-found', nearest: [] };
            default:
                return written;
        }
    }
}

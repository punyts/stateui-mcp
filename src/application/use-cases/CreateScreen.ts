import type { JsonObject } from '../../domain/JsonValue.js';
import { nearestNames } from '../../domain/nearestNames.js';
import { hasScreen } from '../../domain/renameReferences.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { PART_SHAPE_CODE, partNameProblem } from '../../domain/UiPart.js';
import type { UiPartBodies } from '../../domain/UiPart.js';
import { withOwnerPatterns } from '../ownerPatterns.js';
import { checkPartApp, treeOf } from '../partAppCheck.js';
import type { MissingPart, PatternSlot, TreeChoice, TreeOutcome } from '../partAppCheck.js';
import type { PatternCatalog } from '../ports/PatternCatalog.js';
import type { UiAppValidator } from '../ports/UiAppValidator.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export interface CreateScreenInput {
    readonly app: string;
    readonly name: string;
    /** The app's revision: adding a screen is a write of its app */
    readonly expectedRevision: number;
    readonly title?: string;
    /** Typed params by name (`{ type, required? }`), which a `navigate` to the screen passes */
    readonly params?: JsonObject;
    readonly root: TreeChoice;
}

export type CreateScreenResult =
    /** `slots`: the slots of the screen pattern, empty for a node tree */
    | { readonly kind: 'created'; readonly revision: number; readonly warnings: readonly UiBuildError[]; readonly slots: readonly PatternSlot[] }
    /** The app does not exist; `nearest` are app names */
    | { readonly kind: 'not-found'; readonly nearest: readonly string[] }
    | { readonly kind: 'conflict'; readonly currentRevision: number }
    | { readonly kind: 'duplicate-name' }
    | { readonly kind: 'invalid-name'; readonly reason: string }
    | { readonly kind: 'missing-parts'; readonly missing: readonly MissingPart[] }
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] }
    | Exclude<TreeOutcome, { readonly kind: 'tree' }>;

/**
 * Adds a screen to an app: title, params and a root (a node tree, or a library or owner pattern). It is a write of the app, so the
 * app's revision is checked and raised, and the app is checked as a whole first (`checkPartApp`)
 */
export class CreateScreen {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly validator: UiAppValidator,
        private readonly patterns: PatternCatalog,
        private readonly report: UseCaseReport
    ) {}

    async execute(input: CreateScreenInput): Promise<CreateScreenResult> {
        const result = await this.create(input);
        this.report.info('Screen create', { outcome: result.kind, ...(result.kind === 'created' && { revision: result.revision }) });
        return result;
    }

    private async create(input: CreateScreenInput): Promise<CreateScreenResult> {
        const problem = partNameProblem(input.name);
        if (problem !== undefined) return { kind: 'invalid-name', reason: problem };
        const app = await this.parts.findByName('apps', input.app);
        if (app === undefined) return { kind: 'not-found', nearest: nearestNames(input.app, (await this.parts.list('apps')).map((summary) => summary.name)) };
        if (app.revision !== input.expectedRevision) return { kind: 'conflict', currentRevision: app.revision };
        if (hasScreen(app.body, input.name)) return { kind: 'duplicate-name' };
        const root = treeOf(input.root, 'screen', await withOwnerPatterns(this.patterns, this.parts), `$.screens.${input.name}`);
        if (root.kind !== 'tree') return root;
        const screen = {
            ...(input.title !== undefined && { title: input.title }),
            ...(input.params !== undefined && { params: input.params }),
            root: root.tree
        };
        const body = { ...app.body, screens: { ...app.body.screens, [input.name]: screen } } as unknown as UiPartBodies['apps'];
        const check = await checkPartApp(this.parts, this.validator, input.app, body);
        if (check.kind !== 'checked') return check;
        const written = await this.parts.write('apps', input.app, body, input.expectedRevision);
        switch (written.kind) {
            case 'written':
                return { kind: 'created', revision: written.revision, warnings: check.warnings, slots: root.slots };
            case 'conflict':
                return written;
            case 'not-found':
                return { kind: 'not-found', nearest: [] };
            case 'invalid':
                return { kind: 'invalid', errors: [{ code: PART_SHAPE_CODE, message: written.reason }] };
        }
    }
}

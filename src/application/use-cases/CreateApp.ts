import type { UiBuildError } from '../../domain/UiBuildError.js';
import type { JsonObject } from '../../domain/JsonValue.js';
import { partNameProblem } from '../../domain/UiPart.js';
import type { UiPartBodies } from '../../domain/UiPart.js';
import { withOwnerPatterns } from '../ownerPatterns.js';
import { checkPartApp, treeOf } from '../partAppCheck.js';
import type { MissingPart, PatternSlot, TreeChoice, TreeOutcome } from '../partAppCheck.js';
import type { PatternCatalog } from '../ports/PatternCatalog.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UiAppValidator } from '../ports/UiAppValidator.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

/** The screen a new app of parts starts with, so that `start` names a screen; `ui_screen_create` adds the rest */
export const FIRST_SCREEN = 'home';
const FIRST_SCREEN_TITLE = 'Home';
const FIRST_SCREEN_ROOT = { component: 'panel' };
/** The component of the app node */
const APP_COMPONENT = 'app';

export interface CreatePartAppInput {
    readonly name: string;
    readonly title?: string;
    /** `uses.themes`: theme names, the first the default */
    readonly themes?: readonly string[];
    /** `uses.data`: each name the app reads under `$.data` bound to `{ dataset }` or `{ model, scope: "persona" }` */
    readonly data?: JsonObject;
    /** `uses.logic`: each logic module by name with `{ params }` */
    readonly logic?: JsonObject;
    /** The app node's own properties (`layout`, `toasts`, `on`); its component is `app`, its `_title` the title */
    readonly app?: JsonObject;
    /** The root of the first screen `home`: a node tree or a screen pattern; a bare `panel` when absent */
    readonly home?: TreeChoice;
}

export type CreatePartAppResult =
    /** `slots`: the slots of the first screen's pattern, empty for a node tree */
    | {
          readonly kind: 'created';
          readonly name: string;
          readonly id: string;
          readonly revision: number;
          readonly warnings: readonly UiBuildError[];
          readonly slots: readonly PatternSlot[];
      }
    | { readonly kind: 'missing-parts'; readonly missing: readonly MissingPart[] }
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] }
    | { readonly kind: 'invalid-name'; readonly reason: string }
    | { readonly kind: 'duplicate-name' }
    | Exclude<TreeOutcome, { readonly kind: 'tree' }>;

/**
 * Creates an app of parts: its title, the `uses` it is given, the app node (`{ component: "app" }` with the title as
 * `_title` and the given `layout`, `toasts` or `on`) and a first screen `home` that is its `start` (a node tree, or a
 * library or owner screen pattern). An app is its screens: there is no frame around them, so a shared header or menu is
 * a node (or a composed component) each screen places. The app is checked as a whole first (`checkPartApp`); nothing
 * is stored on a missing part or a blocking error
 */
export class CreatePartApp {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly validator: UiAppValidator,
        private readonly patterns: PatternCatalog,
        private readonly report: UseCaseReport
    ) {}

    async execute(input: CreatePartAppInput): Promise<CreatePartAppResult> {
        const result = await this.create(input);
        this.report.info('Part app create', { outcome: result.kind, ...(result.kind === 'created' && { revision: result.revision }) });
        return result;
    }

    private async create(input: CreatePartAppInput): Promise<CreatePartAppResult> {
        const problem = partNameProblem(input.name);
        if (problem !== undefined) return { kind: 'invalid-name', reason: problem };
        const home = input.home === undefined
            ? ({ kind: 'tree', tree: structuredClone(FIRST_SCREEN_ROOT), slots: [] } as const)
            : treeOf(input.home, await withOwnerPatterns(this.patterns, this.parts), `$.screens.${FIRST_SCREEN}`);
        if (home.kind !== 'tree') return home;
        const app = {
            ...(input.title !== undefined && { _title: input.title }),
            ...input.app,
            component: APP_COMPONENT
        };
        const uses = {
            ...(input.themes !== undefined && { themes: [...input.themes] }),
            ...(input.data !== undefined && { data: input.data }),
            ...(input.logic !== undefined && { logic: input.logic })
        };
        const body = {
            ...(input.title !== undefined && { title: input.title }),
            ...(Object.keys(uses).length > 0 && { uses }),
            start: FIRST_SCREEN,
            app,
            screens: { [FIRST_SCREEN]: { title: FIRST_SCREEN_TITLE, root: home.tree } }
        } as unknown as UiPartBodies['apps'];
        const check = await checkPartApp(this.parts, this.validator, input.name, body);
        if (check.kind !== 'checked') return check;
        const created = await this.parts.create({ kind: 'apps', name: input.name, body });
        if (created.kind === 'invalid') return { kind: 'invalid-name', reason: created.reason };
        if (created.kind === 'duplicate-name') return created;
        return { kind: 'created', name: input.name, id: created.part.id, revision: created.part.revision, warnings: check.warnings, slots: home.slots };
    }
}

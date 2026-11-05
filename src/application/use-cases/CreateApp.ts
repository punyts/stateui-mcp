import type { UiBuildError } from '../../domain/UiBuildError.js';
import type { JsonObject } from '../../domain/JsonValue.js';
import { partNameProblem } from '../../domain/UiPart.js';
import type { UiPartBodies } from '../../domain/UiPart.js';
import { checkPartApp, treeOf } from '../partAppCheck.js';
import type { MissingPart, TreeChoice, TreeOutcome } from '../partAppCheck.js';
import type { PatternCatalog } from '../ports/PatternCatalog.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UiAppValidator } from '../ports/UiAppValidator.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

/** The screen a new app of parts starts with, so that `start` names a screen; `ui_screen_create` adds the rest */
export const FIRST_SCREEN = 'home';
const FIRST_SCREEN_BODY = { title: 'Home', root: { component: 'panel' } };

export interface CreatePartAppInput {
    readonly name: string;
    readonly title?: string;
    /** `uses.themes`: theme names, the first the default */
    readonly themes?: readonly string[];
    /** `uses.data`: each name the app reads under `$.data` bound to `{ dataset }` or `{ model, scope: "persona" }` */
    readonly data?: JsonObject;
    /** `uses.logic`: each logic module by name with `{ params }` */
    readonly logic?: JsonObject;
    readonly shell: TreeChoice;
}

export type CreatePartAppResult =
    | { readonly kind: 'created'; readonly name: string; readonly id: string; readonly revision: number; readonly warnings: readonly UiBuildError[] }
    | { readonly kind: 'missing-parts'; readonly missing: readonly MissingPart[] }
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] }
    | { readonly kind: 'invalid-name'; readonly reason: string }
    | { readonly kind: 'duplicate-name' }
    | Exclude<TreeOutcome, { readonly kind: 'tree' }>;

/**
 * Creates an app of parts: its title, the `uses` it is given, the shell (a node tree or a library pattern) and a first
 * screen `home` that is its `start`. The app is checked as a whole first (`checkPartApp`); nothing is stored on a missing
 * part or a blocking error
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
        const shell = treeOf(input.shell, 'shell', this.patterns);
        if (shell.kind !== 'tree') return shell;
        const uses = {
            ...(input.themes !== undefined && { themes: [...input.themes] }),
            ...(input.data !== undefined && { data: input.data }),
            ...(input.logic !== undefined && { logic: input.logic })
        };
        const body = {
            ...(input.title !== undefined && { title: input.title }),
            ...(Object.keys(uses).length > 0 && { uses }),
            start: FIRST_SCREEN,
            shell: shell.tree,
            screens: { [FIRST_SCREEN]: structuredClone(FIRST_SCREEN_BODY) }
        } as unknown as UiPartBodies['apps'];
        const check = await checkPartApp(this.parts, this.validator, input.name, body);
        if (check.kind !== 'checked') return check;
        const created = await this.parts.create({ kind: 'apps', name: input.name, body });
        if (created.kind === 'invalid') return { kind: 'invalid-name', reason: created.reason };
        if (created.kind === 'duplicate-name') return created;
        return { kind: 'created', name: input.name, id: created.part.id, revision: created.part.revision, warnings: check.warnings };
    }
}

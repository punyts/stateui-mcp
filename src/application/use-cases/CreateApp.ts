import { createEmptyDocument } from '../../domain/UiApp.js';
import type { UiDocument, UiSyncMode } from '../../domain/UiApp.js';
import { isValid } from '../../domain/UiBuildError.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { orderedMapKeyErrors } from '../../domain/orderedMap.js';
import type { JsonObject } from '../../domain/JsonValue.js';
import { partNameProblem } from '../../domain/UiPart.js';
import type { UiPartBodies } from '../../domain/UiPart.js';
import { checkPartApp, treeOf } from '../partAppCheck.js';
import type { MissingPart, TreeChoice, TreeOutcome } from '../partAppCheck.js';
import type { PatternCatalog } from '../ports/PatternCatalog.js';
import type { UiAppRepository } from '../ports/UiAppRepository.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UiAppValidator } from '../ports/UiAppValidator.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export interface CreateAppInput {
    readonly name: string;
    /** Absent: the app starts from an empty valid document */
    readonly document?: UiDocument;
    /** Absent: `full` */
    readonly sync?: UiSyncMode;
}

export type CreateAppResult =
    | { readonly kind: 'created'; readonly appId: string; readonly revision: number }
    /** The supplied document has blocking errors; nothing was created */
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] }
    | { readonly kind: 'invalid-name' }
    | { readonly kind: 'duplicate-name' }
    | { readonly kind: 'no-statenet' };

/** Creates an app, from an empty document or from a validated one */
export class CreateApp {
    constructor(
        private readonly repository: UiAppRepository,
        private readonly validator: UiAppValidator,
        private readonly report: UseCaseReport
    ) {}

    async execute(input: CreateAppInput): Promise<CreateAppResult> {
        const name = input.name.trim();
        if (name === '') return { kind: 'invalid-name' };

        let document = createEmptyDocument();
        if (input.document !== undefined) {
            const errors = [...orderedMapKeyErrors(input.document), ...this.validator.validate(input.document)];
            if (!isValid(errors)) {
                this.report.info('Create app rejected', { errorCount: errors.length });
                return { kind: 'invalid', errors };
            }
            document = input.document;
        }

        const created = await this.repository.create({ name, document, sync: input.sync ?? 'full' });
        if (created.kind !== 'created') {
            this.report.info('Create app rejected', { reason: created.kind });
            return { kind: created.kind };
        }
        this.report.info('App created', { appId: created.app.id, revision: created.app.revision, sync: created.app.sync });
        return { kind: 'created', appId: created.app.id, revision: created.app.revision };
    }
}

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
    /** Absent: `full`. An app of parts syncs through its instances, which are `full`; `persisted` is refused */
    readonly sync?: UiSyncMode;
    readonly shell: TreeChoice;
}

export type CreatePartAppResult =
    | { readonly kind: 'created'; readonly name: string; readonly id: string; readonly revision: number; readonly warnings: readonly UiBuildError[] }
    | { readonly kind: 'missing-parts'; readonly missing: readonly MissingPart[] }
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] }
    | { readonly kind: 'invalid-name'; readonly reason: string }
    | { readonly kind: 'duplicate-name' }
    | { readonly kind: 'persisted-unsupported' }
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
        if (input.sync === 'persisted') return { kind: 'persisted-unsupported' };
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

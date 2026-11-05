import type { JsonObject } from '../../domain/JsonValue.js';
import { nearestNames } from '../../domain/nearestNames.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { PART_SHAPE_CODE } from '../../domain/UiPart.js';
import type { UiPartBodies } from '../../domain/UiPart.js';
import { checkPartApp } from '../partAppCheck.js';
import type { MissingPart } from '../partAppCheck.js';
import type { UiAppValidator } from '../ports/UiAppValidator.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

/** The fields of an app that `ui_app_configure` changes; at least one is given and the others stay as they are */
export interface ConfigureAppInput {
    readonly name: string;
    readonly expectedRevision: number;
    readonly title?: string;
    /** Replaces the whole `uses` (themes, data bindings, logic modules with params) */
    readonly uses?: JsonObject;
    /** The screen the app opens on */
    readonly start?: string;
}

export type ConfigureAppResult =
    | { readonly kind: 'configured'; readonly revision: number; readonly warnings: readonly UiBuildError[] }
    | { readonly kind: 'not-found'; readonly nearest: readonly string[] }
    | { readonly kind: 'conflict'; readonly currentRevision: number }
    | { readonly kind: 'nothing-to-change' }
    | { readonly kind: 'missing-parts'; readonly missing: readonly MissingPart[] }
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] };

/**
 * Changes an app's title, `uses` or `start` and nothing else: the other fields are carried over as read. The changed app
 * is checked as a whole (`checkPartApp`), so a new `uses` is checked with every binding and module together
 */
export class ConfigureApp {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly validator: UiAppValidator,
        private readonly report: UseCaseReport
    ) {}

    async execute(input: ConfigureAppInput): Promise<ConfigureAppResult> {
        const result = await this.configure(input);
        this.report.info('Part app configure', { outcome: result.kind, ...(result.kind === 'configured' && { revision: result.revision }) });
        return result;
    }

    private async configure(input: ConfigureAppInput): Promise<ConfigureAppResult> {
        const { name, expectedRevision, title, uses, start } = input;
        if (title === undefined && uses === undefined && start === undefined) return { kind: 'nothing-to-change' };
        const app = await this.parts.findByName('apps', name);
        if (app === undefined) return { kind: 'not-found', nearest: nearestNames(name, (await this.parts.list('apps')).map((summary) => summary.name)) };
        if (app.revision !== expectedRevision) return { kind: 'conflict', currentRevision: app.revision };
        const body = {
            ...app.body,
            ...(title !== undefined && { title }),
            ...(uses !== undefined && { uses }),
            ...(start !== undefined && { start })
        } as unknown as UiPartBodies['apps'];
        const check = await checkPartApp(this.parts, this.validator, name, body);
        if (check.kind !== 'checked') return check;
        const written = await this.parts.write('apps', name, body, expectedRevision);
        switch (written.kind) {
            case 'written':
                return { kind: 'configured', revision: written.revision, warnings: check.warnings };
            case 'conflict':
                return written;
            case 'not-found':
                return { kind: 'not-found', nearest: [] };
            case 'invalid':
                return { kind: 'invalid', errors: [{ code: PART_SHAPE_CODE, message: written.reason }] };
        }
    }
}

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
    /** Replaces the state paths whose changes are shared but never stored (empty: none) */
    readonly ephemeral?: readonly string[];
    /** Every screen of the app once, in the order the app keeps them; a title sets that screen's title ('' removes it) */
    readonly screens?: readonly ScreenEntry[];
}

/** One screen in `ConfigureAppInput.screens`: its name, and a new title when given */
export interface ScreenEntry {
    readonly name: string;
    readonly title?: string;
}

export type ConfigureAppResult =
    | { readonly kind: 'configured'; readonly revision: number; readonly warnings: readonly UiBuildError[] }
    | { readonly kind: 'not-found'; readonly nearest: readonly string[] }
    | { readonly kind: 'conflict'; readonly currentRevision: number }
    | { readonly kind: 'nothing-to-change' }
    | { readonly kind: 'missing-parts'; readonly missing: readonly MissingPart[] }
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] };

/**
 * Changes an app's title (and the app node's `_title` with it), `uses`, `start`, ephemeral paths, or the order and titles of its screens, and nothing
 * else: the other fields are carried over as read. The changed app
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
        const { name, expectedRevision, title, uses, start, ephemeral, screens } = input;
        if (title === undefined && uses === undefined && start === undefined && ephemeral === undefined && screens === undefined) return { kind: 'nothing-to-change' };
        const app = await this.parts.findByName('apps', name);
        if (app === undefined) return { kind: 'not-found', nearest: nearestNames(name, (await this.parts.list('apps')).map((summary) => summary.name)) };
        if (app.revision !== expectedRevision) return { kind: 'conflict', currentRevision: app.revision };
        const ordered = screens === undefined ? undefined : orderScreens(app.body.screens as unknown as Record<string, Record<string, unknown>>, screens);
        if (typeof ordered === 'string') return { kind: 'invalid', errors: [{ code: PART_SHAPE_CODE, message: ordered }] };
        const appNode = (app.body as unknown as { app?: Record<string, unknown> }).app;
        const { ephemeral: _ephemeral, ...rest } = app.body as unknown as { ephemeral?: unknown };
        const body = {
            ...(ephemeral === undefined ? app.body : rest),
            // the title is also the app node's _title, the document title
            ...(title !== undefined && { title, ...(appNode !== undefined && { app: { ...appNode, _title: title } }) }),
            ...(uses !== undefined && { uses }),
            ...(start !== undefined && { start }),
            ...(ephemeral !== undefined && ephemeral.length > 0 && { ephemeral: [...ephemeral] }),
            ...(ordered !== undefined && { screens: ordered })
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

/**
 * The app's screens in the order of `entries`, each with its new title: `entries` names every screen once. A message
 * naming the screen that is unknown, repeated or left out when it does not
 */
function orderScreens(current: Record<string, Record<string, unknown>>, entries: readonly ScreenEntry[]): Record<string, Record<string, unknown>> | string {
    const ordered: Record<string, Record<string, unknown>> = {};
    for (const entry of entries) {
        const screen = current[entry.name];
        if (screen === undefined) return `screens names "${entry.name}", which is not a screen of the app`;
        if (entry.name in ordered) return `screens names "${entry.name}" twice`;
        if (entry.title === undefined) ordered[entry.name] = screen;
        else {
            const { title: _title, ...rest } = screen;
            ordered[entry.name] = entry.title === '' ? rest : { ...screen, title: entry.title };
        }
    }
    const missing = Object.keys(current).find((screen) => !(screen in ordered));
    if (missing !== undefined) return `screens leaves out "${missing}": name every screen of the app once`;
    return ordered;
}

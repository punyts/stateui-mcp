import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import { setCreatingParents } from '../../domain/documentOperations.js';
import { parseDocumentPath } from '../../domain/DocumentPath.js';
import { checkOperationLimit } from '../../domain/limits.js';
import { nearestNames } from '../../domain/nearestNames.js';
import { TREE_ROOT, removePruning, withTreeStatePath } from '../../domain/nodeOperations.js';
import type { TreeTarget } from '../../domain/nodeOperations.js';
import { isBlockingError } from '../../domain/UiBuildError.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { PART_SHAPE_CODE } from '../../domain/UiPart.js';
import type { UiPartBodies } from '../../domain/UiPart.js';
import { withoutRepeats } from '../documentChecks.js';
import { checkPartApp } from '../partAppCheck.js';
import type { MissingPart } from '../partAppCheck.js';
import type { UiAppValidator } from '../ports/UiAppValidator.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

/** A language code such as `de` or `pt-BR` */
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** Sets the text at a content path of the overlay, or removes it; paths are relative to the tree (`root.children.hero._text`) */
export type LocaleOperation = { readonly op: 'set'; readonly path: string; readonly value: JsonValue } | { readonly op: 'remove'; readonly path: string };

export interface WriteLocaleInput {
    readonly app: string;
    readonly language: string;
    readonly target: TreeTarget;
    readonly expectedRevision: number;
    readonly operations: readonly LocaleOperation[];
}

export type WriteLocaleResult =
    | { readonly kind: 'written'; readonly revision: number; readonly warnings: readonly UiBuildError[] }
    | { readonly kind: 'invalid-language' }
    | { readonly kind: 'not-found'; readonly nearest: readonly string[] }
    | { readonly kind: 'screen-not-found'; readonly nearest: readonly string[] }
    | { readonly kind: 'conflict'; readonly currentRevision: number }
    | { readonly kind: 'invalid-operation'; readonly index: number; readonly error: UiBuildError }
    | { readonly kind: 'missing-parts'; readonly missing: readonly MissingPart[] }
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] };

/** The overlays by language of the target: the app's `locales` for the shell, the screen's own for a screen */
function localesOf(body: UiPartBodies['apps'], target: TreeTarget): JsonObject | undefined {
    const holder = target.kind === 'shell' ? (body as unknown as JsonObject) : (body.screens[target.screen] as unknown as JsonObject | undefined);
    const locales = holder?.['locales'];
    return isJsonObject(locales) ? locales : undefined;
}

/** The app body with the target's overlay of `language` replaced, or removed when it is empty (and `locales` with it) */
function withOverlay(body: UiPartBodies['apps'], target: TreeTarget, language: string, overlay: JsonObject): UiPartBodies['apps'] {
    const { [language]: _old, ...others } = localesOf(body, target) ?? {};
    const locales = Object.keys(overlay).length > 0 ? { ...others, [language]: overlay } : others;
    const place = <T extends object>(holder: T): T => {
        const { locales: _locales, ...rest } = holder as T & { locales?: unknown };
        return (Object.keys(locales).length > 0 ? { ...rest, locales } : rest) as T;
    };
    if (target.kind === 'shell') return place(body);
    return { ...body, screens: { ...body.screens, [target.screen]: place(body.screens[target.screen] as object) } } as unknown as UiPartBodies['apps'];
}

/**
 * Writes the content overlay of one language for one tree of an app (the shell or a screen): texts set or removed at
 * content paths. The app is checked as a whole (the overlay's paths must be content of the tree), then the language is
 * checked with `validateAppLocale`: its untranslated paths come back as warnings
 */
export class WriteLocale {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly validator: UiAppValidator,
        private readonly report: UseCaseReport
    ) {}

    async execute(input: WriteLocaleInput): Promise<WriteLocaleResult> {
        const result = await this.write(input);
        this.report.info('Locale write', {
            target: input.target.kind,
            operationCount: input.operations.length,
            outcome: result.kind,
            ...(result.kind === 'written' && { revision: result.revision, warningCount: result.warnings.length })
        });
        return result;
    }

    private async write(input: WriteLocaleInput): Promise<WriteLocaleResult> {
        const { target, language, operations } = input;
        if (!LANGUAGE.test(language)) return { kind: 'invalid-language' };
        if (operations.length === 0) return { kind: 'invalid', errors: [{ code: 'SUI-DOC-OPERATION', message: 'A write needs at least one operation', statePath: '$' }] };
        const overLimit = checkOperationLimit(operations.length);
        if (overLimit !== undefined) return { kind: 'invalid', errors: [overLimit] };

        const app = await this.parts.findByName('apps', input.app);
        if (app === undefined) return { kind: 'not-found', nearest: nearestNames(input.app, (await this.parts.list('apps')).map((summary) => summary.name)) };
        if (app.revision !== input.expectedRevision) return { kind: 'conflict', currentRevision: app.revision };
        if (target.kind === 'screen' && !Object.hasOwn(app.body.screens, target.screen)) {
            return { kind: 'screen-not-found', nearest: nearestNames(target.screen, Object.keys(app.body.screens)) };
        }

        const current = localesOf(app.body, target)?.[language];
        let holder: JsonObject = { [TREE_ROOT]: isJsonObject(current) ? current : {} };
        for (const [index, operation] of operations.entries()) {
            const parsed = parseDocumentPath(operation.path);
            if (!parsed.ok || parsed.path[0] !== TREE_ROOT || parsed.path.length < 2) {
                return { kind: 'invalid-operation', index, error: { code: 'SUI-DOC-PATH', message: `"${operation.path}" is not a content path of the tree`, statePath: '$' } };
            }
            const result = operation.op === 'set' ? setCreatingParents(holder, parsed.path, operation.value) : removePruning(holder, parsed.path);
            if (!result.ok) return { kind: 'invalid-operation', index, error: withTreeStatePath(result.error, target) };
            holder = 'tree' in result ? result.tree : result.document;
        }
        const overlay = holder[TREE_ROOT];
        const body = withOverlay(app.body, target, language, isJsonObject(overlay) ? overlay : {});

        const check = await checkPartApp(this.parts, this.validator, app.name, body);
        if (check.kind !== 'checked') return check;
        const assembled = this.validator.assembleApp(body, check.source);
        const localeErrors = this.validator.validateLocale(assembled, language, target.kind === 'screen' ? target.screen : undefined);
        if (localeErrors.some(isBlockingError)) return { kind: 'invalid', errors: localeErrors };

        const written = await this.parts.write('apps', app.name, body, input.expectedRevision);
        switch (written.kind) {
            case 'written':
                return { kind: 'written', revision: written.revision, warnings: withoutRepeats([...check.warnings, ...localeErrors]) };
            case 'conflict':
                return written;
            case 'not-found':
                return { kind: 'not-found', nearest: [] };
            case 'invalid':
                return { kind: 'invalid', errors: [{ code: PART_SHAPE_CODE, message: written.reason }] };
        }
    }
}

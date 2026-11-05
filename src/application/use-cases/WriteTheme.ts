import { setCreatingParents } from '../../domain/documentOperations.js';
import { parseDocumentPath } from '../../domain/DocumentPath.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import { checkOperationLimit } from '../../domain/limits.js';
import { nearestNames } from '../../domain/nearestNames.js';
import { removePruning } from '../../domain/nodeOperations.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { partNameProblem } from '../../domain/UiPart.js';
import type { UiPartBodies } from '../../domain/UiPart.js';
import type { ComponentCatalog } from '../ports/ComponentCatalog.js';
import type { PatternCatalog } from '../ports/PatternCatalog.js';
import type { ContrastPair, UiAppValidator } from '../ports/UiAppValidator.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';
import { tokenReach } from '../tokenReach.js';
import type { TokenReach } from '../tokenReach.js';
import type { AppWarning, WritePart } from './WritePart.js';

type ThemeBody = UiPartBodies['themes'];

/** The overlay kinds a theme may hold */
export type ThemeOverlayKind = 'mode' | 'brand' | 'motion';

/** A change to a theme: a token at the base or in one overlay, or a whole overlay */
export type ThemeOperation =
    | { readonly op: 'set'; readonly path: string; readonly value: JsonValue; readonly overlay?: string }
    | { readonly op: 'remove'; readonly path: string; readonly overlay?: string }
    | { readonly op: 'add-overlay'; readonly overlay: string; readonly kind: ThemeOverlayKind }
    | { readonly op: 'remove-overlay'; readonly overlay: string };

/** What a theme write reports beside its revision */
export interface ThemeReport {
    readonly revision: number;
    /** The apps the write breaks, at most `MAX_WARNED_APPS` */
    readonly warnings: readonly AppWarning[];
    readonly moreApps: number;
    readonly contrast: readonly ContrastPair[];
    /** The components each written token reaches */
    readonly reaches: readonly TokenReach[];
}

export type CreateThemeResult =
    | ({ readonly kind: 'created' } & ThemeReport)
    | { readonly kind: 'invalid-name'; readonly reason: string }
    | { readonly kind: 'duplicate-name' }
    /** `from` names no theme of the owner */
    | { readonly kind: 'not-found'; readonly nearest: readonly string[] }
    | { readonly kind: 'unknown-preset'; readonly preset: string }
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] };

export type WriteThemeResult =
    | ({ readonly kind: 'written'; readonly created: boolean } & ThemeReport)
    | { readonly kind: 'not-found'; readonly nearest: readonly string[] }
    | { readonly kind: 'conflict'; readonly currentRevision: number }
    | { readonly kind: 'invalid-name'; readonly reason: string }
    | { readonly kind: 'invalid-operation'; readonly index: number; readonly error: UiBuildError }
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] };

function report(written: { revision: number; warnings: readonly AppWarning[]; moreApps: number }, body: ThemeBody, validator: UiAppValidator, reaches: readonly TokenReach[]): ThemeReport {
    return { revision: written.revision, warnings: written.warnings, moreApps: written.moreApps, contrast: validator.themeContrast(body), reaches };
}

/** Creates a theme as a copy of another theme of the owner (`from`) or of a library preset; the base tokens and overlays are copied whole */
export class CreateTheme {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly writePart: WritePart,
        private readonly validator: UiAppValidator,
        private readonly patterns: PatternCatalog,
        private readonly log: UseCaseReport
    ) {}

    async execute(input: { readonly name: string; readonly from: string } | { readonly name: string; readonly preset: string }): Promise<CreateThemeResult> {
        const result = await this.create(input);
        this.log.info('Theme create', { source: 'from' in input ? 'theme' : 'preset', outcome: result.kind });
        return result;
    }

    private async create(input: { readonly name: string; readonly from: string } | { readonly name: string; readonly preset: string }): Promise<CreateThemeResult> {
        const problem = partNameProblem(input.name);
        if (problem !== undefined) return { kind: 'invalid-name', reason: problem };
        let body: ThemeBody;
        if ('from' in input) {
            const source = await this.parts.findByName('themes', input.from);
            if (source === undefined) return { kind: 'not-found', nearest: nearestNames(input.from, (await this.parts.list('themes')).map((summary) => summary.name)) };
            body = structuredClone(source.body);
        } else {
            const preset = this.patterns.preset(input.preset);
            if (preset === undefined) return { kind: 'unknown-preset', preset: input.preset };
            const { name: _name, ...part } = structuredClone(preset);
            body = part as ThemeBody;
        }
        const written = await this.writePart.execute({ kind: 'themes', name: input.name, body });
        switch (written.kind) {
            case 'written':
                return { kind: 'created', ...report(written, body, this.validator, []) };
            case 'duplicate-name':
            case 'invalid':
                return written;
            default:
                return { kind: 'invalid', errors: [{ code: 'SUI-PART-SHAPE', message: `The theme could not be created (${written.kind})` }] };
        }
    }
}

function failure(index: number, code: string, message: string, statePath = '$'): WriteThemeResult {
    return { kind: 'invalid-operation', index, error: { code, message, statePath } };
}

/** The holder path of a token: `tokens...` at the base, `overlays.{name}.tokens...` in an overlay */
function tokenPrefix(overlay: string | undefined): string[] {
    return overlay === undefined ? ['tokens'] : ['overlays', overlay, 'tokens'];
}

/**
 * Writes a theme token by token: tokens set or removed at the base or in one overlay, overlays added with their kind or
 * removed. The theme is checked on its own (token names and values, the groups each overlay kind may touch) and every
 * app that uses it is checked after; the result reports the contrast of the text tokens and the components each token reaches.
 * Without `expectedRevision` the write creates the theme, starting from no tokens, so a first theme needs no preset
 */
export interface WriteThemeInput {
    readonly theme: string;
    /** The revision the caller read; absent, the write creates the theme */
    readonly expectedRevision?: number;
    readonly operations: readonly ThemeOperation[];
}

export class WriteTheme {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly writePart: WritePart,
        private readonly validator: UiAppValidator,
        private readonly catalog: ComponentCatalog,
        private readonly log: UseCaseReport
    ) {}

    async execute(input: WriteThemeInput): Promise<WriteThemeResult> {
        const result = await this.write(input);
        this.log.info('Theme write', {
            operationCount: input.operations.length,
            outcome: result.kind,
            ...(result.kind === 'written' && { revision: result.revision, brokenApps: result.warnings.length + result.moreApps })
        });
        return result;
    }

    private async write(input: WriteThemeInput): Promise<WriteThemeResult> {
        const { operations } = input;
        if (operations.length === 0) return { kind: 'invalid', errors: [{ code: 'SUI-DOC-OPERATION', message: 'A write needs at least one operation', statePath: '$' }] };
        const overLimit = checkOperationLimit(operations.length);
        if (overLimit !== undefined) return { kind: 'invalid', errors: [overLimit] };
        const theme = await this.parts.findByName('themes', input.theme);
        if (input.expectedRevision === undefined) {
            if (theme !== undefined) return { kind: 'conflict', currentRevision: theme.revision };
            const problem = partNameProblem(input.theme);
            if (problem !== undefined) return { kind: 'invalid-name', reason: problem };
        } else {
            if (theme === undefined) return { kind: 'not-found', nearest: nearestNames(input.theme, (await this.parts.list('themes')).map((summary) => summary.name)) };
            if (theme.revision !== input.expectedRevision) return { kind: 'conflict', currentRevision: theme.revision };
        }

        let body = (theme === undefined ? { tokens: {} } : structuredClone(theme.body)) as unknown as JsonObject;
        const written: string[] = [];
        for (const [index, operation] of operations.entries()) {
            const applied = this.apply(body, operation, index);
            if ('kind' in applied) return applied;
            body = applied.body;
            if (operation.op === 'set' || operation.op === 'remove') written.push(operation.path);
        }
        const next = body as unknown as ThemeBody;
        const stored = await this.writePart.execute({
            kind: 'themes',
            name: input.theme,
            body: next,
            ...(input.expectedRevision !== undefined && { expectedRevision: input.expectedRevision })
        });
        switch (stored.kind) {
            case 'written':
                return { kind: 'written', created: theme === undefined, ...report(stored, next, this.validator, tokenReach(this.catalog, written)) };
            case 'conflict':
            case 'invalid':
                return stored;
            case 'not-found':
                return { kind: 'not-found', nearest: [] };
            case 'duplicate-name': {
                // Another write created the theme meanwhile
                const current = await this.parts.findByName('themes', input.theme);
                return { kind: 'conflict', currentRevision: current?.revision ?? 1 };
            }
        }
    }

    private apply(body: JsonObject, operation: ThemeOperation, index: number): { readonly body: JsonObject } | WriteThemeResult {
        const overlays = isJsonObject(body['overlays']) ? body['overlays'] : {};
        const overlay = operation.overlay;
        if (overlay !== undefined && operation.op !== 'add-overlay' && !Object.hasOwn(overlays, overlay)) {
            const nearest = nearestNames(overlay, Object.keys(overlays));
            return failure(index, 'SUI-DOC-PATH', `The theme has no overlay "${overlay}"${nearest.length > 0 ? `; nearest: ${nearest.join(', ')}` : ''}`, `$.overlays.${overlay}`);
        }
        switch (operation.op) {
            case 'add-overlay': {
                if (Object.hasOwn(overlays, operation.overlay)) return failure(index, 'SUI-DOC-PATH', `The theme already has an overlay "${operation.overlay}"`, `$.overlays.${operation.overlay}`);
                return { body: { ...body, overlays: { ...overlays, [operation.overlay]: { kind: operation.kind, tokens: {} } } } };
            }
            case 'remove-overlay': {
                const { [operation.overlay]: _removed, ...rest } = overlays;
                const { overlays: _old, ...others } = body;
                return { body: Object.keys(rest).length > 0 ? { ...others, overlays: rest } : others };
            }
            default: {
                const parsed = parseDocumentPath(operation.path);
                if (!parsed.ok || parsed.path.length === 0) return failure(index, 'SUI-DOC-PATH', `"${operation.path}" is not a token path such as "color.accent.base"`);
                const prefix = tokenPrefix(operation.overlay);
                const result =
                    operation.op === 'set' ? setCreatingParents(body, [...prefix, ...parsed.path], operation.value) : removePruning(body, [...prefix, ...parsed.path], prefix.length);
                if (!result.ok) return { kind: 'invalid-operation', index, error: result.error };
                return { body: 'tree' in result ? result.tree : result.document };
            }
        }
    }
}

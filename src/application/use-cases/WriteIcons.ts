import type { AppIconPath } from '@punyts/stateui-app/core';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import { checkOperationLimit } from '../../domain/limits.js';
import { nearestNames } from '../../domain/nearestNames.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { PART_SHAPE_CODE } from '../../domain/UiPart.js';
import type { UiPartBodies } from '../../domain/UiPart.js';
import { checkPartApp } from '../partAppCheck.js';
import type { MissingPart } from '../partAppCheck.js';
import type { UiAppValidator } from '../ports/UiAppValidator.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

/** Sets one of the app's own icons (its outline paths, and optionally a filled variant), or removes it */
export type IconOperation =
    | { readonly op: 'set'; readonly name: string; readonly outline: readonly AppIconPath[]; readonly filled?: readonly AppIconPath[] }
    | { readonly op: 'remove'; readonly name: string };

export interface WriteIconsInput {
    readonly app: string;
    readonly expectedRevision: number;
    readonly operations: readonly IconOperation[];
}

export type WriteIconsResult =
    | { readonly kind: 'written'; readonly revision: number; readonly icons: readonly string[]; readonly warnings: readonly UiBuildError[] }
    | { readonly kind: 'not-found'; readonly nearest: readonly string[] }
    | { readonly kind: 'conflict'; readonly currentRevision: number }
    | { readonly kind: 'invalid-operation'; readonly index: number; readonly error: UiBuildError }
    | { readonly kind: 'missing-parts'; readonly missing: readonly MissingPart[] }
    | { readonly kind: 'invalid'; readonly errors: readonly UiBuildError[] };

/** The app body with `icons` replaced, or without the key when no icon is left */
function withIcons(body: UiPartBodies['apps'], icons: Readonly<Record<string, JsonValue>>): UiPartBodies['apps'] {
    const { icons: _old, ...rest } = body as UiPartBodies['apps'] & { icons?: unknown };
    return (Object.keys(icons).length > 0 ? { ...rest, icons } : rest) as UiPartBodies['apps'];
}

/**
 * Writes the app's own icons: each operation sets an icon by name (its outline paths in a 24×24 view box, and a filled
 * variant when given) or removes one. The operations apply in order; the app is then checked as a whole (the icons
 * are path data only, and every icon name the app sets is its own or in the icon set) and written as one change
 */
export class WriteIcons {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly validator: UiAppValidator,
        private readonly report: UseCaseReport
    ) {}

    async execute(input: WriteIconsInput): Promise<WriteIconsResult> {
        const result = await this.write(input);
        this.report.info('Icons write', {
            operationCount: input.operations.length,
            outcome: result.kind,
            ...(result.kind === 'written' && { revision: result.revision, iconCount: result.icons.length })
        });
        return result;
    }

    private async write(input: WriteIconsInput): Promise<WriteIconsResult> {
        const { operations } = input;
        if (operations.length === 0) return { kind: 'invalid', errors: [{ code: 'SUI-DOC-OPERATION', message: 'A write needs at least one operation', statePath: '$' }] };
        const overLimit = checkOperationLimit(operations.length);
        if (overLimit !== undefined) return { kind: 'invalid', errors: [overLimit] };

        const app = await this.parts.findByName('apps', input.app);
        if (app === undefined) return { kind: 'not-found', nearest: nearestNames(input.app, (await this.parts.list('apps')).map((summary) => summary.name)) };
        if (app.revision !== input.expectedRevision) return { kind: 'conflict', currentRevision: app.revision };

        const current = (app.body as unknown as JsonObject)['icons'];
        const icons: Record<string, JsonValue> = isJsonObject(current) ? { ...current } : {};
        for (const [index, operation] of operations.entries()) {
            if (operation.op === 'remove') {
                if (!Object.hasOwn(icons, operation.name)) {
                    const nearest = nearestNames(operation.name, Object.keys(icons));
                    const near = nearest.length > 0 ? `; nearest: ${nearest.join(', ')}` : '';
                    return { kind: 'invalid-operation', index, error: { code: 'SUI-DOC-PATH', message: `The app has no icon "${operation.name}"${near}`, statePath: `$.icons.${operation.name}` } };
                }
                delete icons[operation.name];
            } else {
                icons[operation.name] = { outline: [...operation.outline], ...(operation.filled !== undefined && { filled: [...operation.filled] }) } as unknown as JsonObject;
            }
        }
        const body = withIcons(app.body, icons);

        const check = await checkPartApp(this.parts, this.validator, app.name, body);
        if (check.kind !== 'checked') return check;

        const written = await this.parts.write('apps', app.name, body, input.expectedRevision);
        switch (written.kind) {
            case 'written':
                return { kind: 'written', revision: written.revision, icons: Object.keys(icons), warnings: check.warnings };
            case 'conflict':
                return written;
            case 'not-found':
                return { kind: 'not-found', nearest: [] };
            case 'invalid':
                return { kind: 'invalid', errors: [{ code: PART_SHAPE_CODE, message: written.reason }] };
        }
    }
}

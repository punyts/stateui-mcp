import { parseDocumentPath, resolveDocumentPath } from '../../domain/DocumentPath.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonValue } from '../../domain/JsonValue.js';
import { nearestNames } from '../../domain/nearestNames.js';
import { limitNodeDepth } from '../../domain/nodeDepth.js';
import type { PartKind } from '../../domain/partName.js';
import { partReferences } from '../../domain/partReferences.js';
import { loadPartSource } from '../partSource.js';
import type { UiAppValidator } from '../ports/UiAppValidator.js';
import type { UiPartRepository } from '../ports/UiPartRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

interface ReadOptions {
    /** A dotted path inside the body; absent or empty is the whole body */
    readonly path?: string;
    /** How many `children` levels of each node to include; deeper nodes come back as `{ component, childCount }` */
    readonly depth?: number;
}

export type GetPartInput =
    | (ReadOptions & {
          readonly kind: PartKind;
          readonly name: string;
          /** Apps only: the assembled app the runtime mounts (themes, data, components and modules in). Read only */
          readonly resolved?: boolean;
      })
    | (ReadOptions & { readonly kind: 'screens'; readonly app: string; readonly name: string; readonly resolved?: boolean });

export const ASSEMBLED_READ_NOTE =
    'Resolved read: the assembled app the runtime mounts, with the themes, data, components and logic modules it uses merged in. It is read only; write the parts themselves.';

export type GetPartResult =
    | {
          readonly kind: 'found';
          /** The part's id; for a screen, the app's */
          readonly id: string;
          /** The part's revision; for a screen, the app's (the one a screen write checks) */
          readonly revision: number;
          readonly path: string;
          readonly value: JsonValue;
          readonly resolved: boolean;
          readonly note?: string;
      }
    /** `nearest`: the names closest to the one asked for: of the kind, the app's screens, or the apps when `missingApp` (a screen's app) is set */
    | { readonly kind: 'not-found'; readonly nearest: readonly string[]; readonly missingApp?: string }
    | { readonly kind: 'invalid-path'; readonly reason: string }
    | { readonly kind: 'missing-path'; readonly path: string; readonly missingAt: string }
    | { readonly kind: 'invalid-input'; readonly message: string };

/**
 * Reads one part, or one screen of an app, with its id and revision: the whole body or the value at a path, to a
 * depth. `resolved` on an app reads the assembled app (`assembleApp` of the library) instead of the blueprint; on any
 * other kind it is invalid
 */
export class GetPart {
    constructor(
        private readonly parts: UiPartRepository,
        private readonly validator: Pick<UiAppValidator, 'assembleApp'>,
        private readonly report: UseCaseReport
    ) {}

    async execute(input: GetPartInput): Promise<GetPartResult> {
        const result = await this.read(input);
        this.report.info('Part read', { kind: input.kind, outcome: result.kind });
        return result;
    }

    private async read(input: GetPartInput): Promise<GetPartResult> {
        const { depth } = input;
        if (depth !== undefined && (!Number.isInteger(depth) || depth < 0)) return { kind: 'invalid-input', message: 'depth must be a whole number of zero or more' };
        if (input.resolved === true && input.kind !== 'apps') {
            return { kind: 'invalid-input', message: 'resolved reads an assembled app: it takes kind "apps" only' };
        }
        const parsed = parseDocumentPath(input.path ?? '');
        if (!parsed.ok) return { kind: 'invalid-path', reason: parsed.reason };

        let id: string;
        let revision: number;
        let body: JsonValue;
        if (input.kind === 'screens') {
            const app = await this.parts.findByName('apps', input.app);
            if (app === undefined) return { kind: 'not-found', missingApp: input.app, nearest: nearestNames(input.app, (await this.parts.list('apps')).map((part) => part.name)) };
            const screens = app.body.screens ?? {};
            if (!Object.hasOwn(screens, input.name)) return { kind: 'not-found', nearest: nearestNames(input.name, Object.keys(screens)) };
            ({ id, revision } = app);
            body = screens[input.name] as unknown as JsonValue;
        } else {
            const part = await this.parts.findByName(input.kind, input.name);
            if (part === undefined) return { kind: 'not-found', nearest: nearestNames(input.name, (await this.parts.list(input.kind)).map((summary) => summary.name)) };
            ({ id, revision } = part);
            body = part.body as unknown as JsonValue;
            if (input.resolved === true && input.kind === 'apps') {
                const app = part.body as Parameters<UiAppValidator['assembleApp']>[0];
                body = this.validator.assembleApp(app, await loadPartSource(this.parts, partReferences('apps', app))) as unknown as JsonValue;
            }
        }

        const found = resolveDocumentPath(body, parsed.path);
        if (!found.found) return { kind: 'missing-path', path: input.path ?? '', missingAt: parsed.path.slice(0, found.missingAt + 1).join('.') };
        const value = depth !== undefined && isJsonObject(found.value) ? limitNodeDepth(found.value, depth) : found.value;
        const resolved = input.resolved === true;
        return { kind: 'found', id, revision, path: input.path ?? '', value, resolved, ...(resolved && { note: ASSEMBLED_READ_NOTE }) };
    }
}

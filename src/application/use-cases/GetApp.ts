import { parseDocumentPath, resolveDocumentPath } from '../../domain/DocumentPath.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import { isNodeValue, limitNodeDepth } from '../../domain/nodeDepth.js';
import type { UiDocument } from '../../domain/UiApp.js';
import type { UiAppRepository } from '../ports/UiAppRepository.js';
import type { UiAppValidator } from '../ports/UiAppValidator.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export interface GetAppInput {
    /** A dotted document path; absent or empty is the document root */
    readonly path?: string;
    /** How many `children` levels to include; a node below the limit comes back as `{ component, childCount }` */
    readonly depth?: number;
    /** Nodes merged with their component defaults. Read only */
    readonly resolved?: boolean;
}

export const RESOLVED_READ_NOTE =
    'Resolved read: component defaults are merged in. It is read only and must not be written back as it is; write only the values you change.';

export type GetAppResult =
    | {
          readonly kind: 'found';
          readonly appId: string;
          readonly revision: number;
          readonly path: string;
          readonly value: JsonValue;
          /** True when `value` is merged with component defaults; then `note` says it cannot be written back as is */
          readonly resolved: boolean;
          readonly note?: string;
      }
    | { readonly kind: 'not-found'; readonly appId: string }
    | { readonly kind: 'invalid-path'; readonly appId: string; readonly reason: string }
    /** `missingAt` is the path up to and including the first segment that does not exist */
    | { readonly kind: 'missing-path'; readonly appId: string; readonly path: string; readonly missingAt: string }
    | { readonly kind: 'invalid-input'; readonly appId: string; readonly message: string };

/** `app` and every composed tree are the nodes of a document; `data` and the rest are left as they are */
function mapTrees(document: UiDocument, change: (node: JsonObject) => JsonObject): UiDocument {
    const entries = Object.entries(document).map(([key, value]): [string, JsonValue] => {
        if (key === 'app' && isNodeValue(value)) return [key, change(value)];
        if (key === 'composed' && isJsonObject(value)) {
            return [key, Object.fromEntries(Object.entries(value).map(([name, tree]): [string, JsonValue] => [name, isNodeValue(tree) ? change(tree) : tree]))];
        }
        return [key, value];
    });
    return Object.fromEntries(entries);
}

/** Reads part of an app: one path, a limited depth, optionally merged with component defaults */
export class GetApp {
    constructor(
        private readonly repository: UiAppRepository,
        private readonly validator: UiAppValidator,
        private readonly report: UseCaseReport
    ) {}

    async execute(appId: string, input: GetAppInput = {}): Promise<GetAppResult> {
        const { depth } = input;
        if (depth !== undefined && (!Number.isInteger(depth) || depth < 0)) {
            return { kind: 'invalid-input', appId, message: 'depth must be a whole number of zero or more' };
        }
        const app = await this.repository.findById(appId);
        if (app === undefined) return this.finish(appId, { kind: 'not-found', appId });

        const text = input.path ?? '';
        const parsed = parseDocumentPath(text);
        if (!parsed.ok) return this.finish(appId, { kind: 'invalid-path', appId, reason: parsed.reason });
        const segments = parsed.path;

        const found = resolveDocumentPath(app.document, segments);
        if (!found.found) {
            return this.finish(appId, {
                kind: 'missing-path',
                appId,
                path: text,
                missingAt: segments.slice(0, found.missingAt + 1).join('.')
            });
        }

        let value = found.value;
        let resolved = false;
        if (input.resolved === true) {
            if (segments.length === 0) {
                const node = this.validator.resolveNode(app.document, ['app']);
                if (node !== undefined) {
                    value = { ...app.document, app: node };
                    resolved = true;
                }
            } else if (isNodeValue(value)) {
                const node = this.validator.resolveNode(app.document, segments);
                if (node !== undefined) {
                    value = node;
                    resolved = true;
                }
            }
        }
        if (depth !== undefined) {
            if (segments.length === 0) value = mapTrees(value as UiDocument, (node) => limitNodeDepth(node, depth));
            else if (isNodeValue(value)) value = limitNodeDepth(value, depth);
        }

        return this.finish(appId, {
            kind: 'found',
            appId,
            revision: app.revision,
            path: text,
            value,
            resolved,
            ...(resolved ? { note: RESOLVED_READ_NOTE } : {})
        });
    }

    private finish(appId: string, result: GetAppResult): GetAppResult {
        this.report.info('App read', { appId, outcome: result.kind });
        return result;
    }
}

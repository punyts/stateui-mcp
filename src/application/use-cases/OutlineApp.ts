import { parseDocumentPath, resolveDocumentPath } from '../../domain/DocumentPath.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import { isNodeValue } from '../../domain/nodeDepth.js';
import { formatLogic } from '../outline/formatLogic.js';
import { formatOutline } from '../outline/formatOutline.js';
import { formatTree } from '../outline/formatTree.js';
import type { UiAppRepository } from '../ports/UiAppRepository.js';
import type { UiAppValidator } from '../ports/UiAppValidator.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export interface OutlineAppInput {
    /** A dotted document path to a node; absent or empty is the application root (`app`) */
    readonly path?: string;
    /** How many `children` levels to show below the first node; deeper nodes are one line with a child count */
    readonly depth?: number;
    /** Content is shown in this language when the app has an overlay for it */
    readonly locale?: string;
    /** tree: only the structure, as a nested list of key, component and state path (formatTree) */
    readonly format?: 'outline' | 'tree';
    /** For the tree: false leaves the state paths off the lines. Default true */
    readonly paths?: boolean;
}

export type OutlineAppResult =
    | {
          readonly kind: 'outline';
          readonly appId: string;
          readonly revision: number;
          readonly text: string;
          readonly lineCount: number;
          /** Lines left out by the 400-line cap */
          readonly cutLines: number;
          /** False when `locale` was asked for and the app has no overlay for it: the base content is shown */
          readonly localeApplied: boolean;
          /** For the tree: how many nodes it shows */
          readonly nodeCount?: number;
      }
    | { readonly kind: 'not-found'; readonly appId: string }
    | { readonly kind: 'invalid-path'; readonly appId: string; readonly reason: string }
    | { readonly kind: 'missing-path'; readonly appId: string; readonly path: string; readonly missingAt: string }
    /** The path exists but holds no node the library can resolve */
    | { readonly kind: 'not-a-node'; readonly appId: string; readonly path: string }
    | { readonly kind: 'invalid-input'; readonly appId: string; readonly message: string };

const DATA_PREFIX = '$.data.';

/**
 * A text outline of what the user will see, from the resolved document and the latest state snapshot: no browser.
 * Record counts and the `open` and `hidden` marks follow the snapshot when it has them. The outline of the root
 * ends with the document's logic: machines with their current state, rules and guards
 */
export class OutlineApp {
    constructor(
        private readonly repository: UiAppRepository,
        private readonly validator: UiAppValidator,
        private readonly report: UseCaseReport
    ) {}

    async execute(appId: string, input: OutlineAppInput = {}): Promise<OutlineAppResult> {
        const { depth, locale } = input;
        if (depth !== undefined && (!Number.isInteger(depth) || depth < 0)) {
            return { kind: 'invalid-input', appId, message: 'depth must be a whole number of zero or more' };
        }
        const app = await this.repository.findById(appId);
        if (app === undefined) return this.finish(appId, { kind: 'not-found', appId });

        const text = input.path ?? '';
        const parsed = parseDocumentPath(text);
        if (!parsed.ok) return this.finish(appId, { kind: 'invalid-path', appId, reason: parsed.reason });
        const segments = parsed.path.length === 0 ? ['app'] : parsed.path;

        const found = resolveDocumentPath(app.document, segments);
        if (!found.found) {
            return this.finish(appId, {
                kind: 'missing-path',
                appId,
                path: text,
                missingAt: segments.slice(0, found.missingAt + 1).join('.')
            });
        }
        const root = this.validator.resolveNode(app.document, segments);
        if (root === undefined || !isNodeValue(root)) return this.finish(appId, { kind: 'not-a-node', appId, path: text });

        const overlay = locale === undefined ? undefined : this.validator.localeOverlay(app.document, locale);
        const snapshotApp = isJsonObject(app.stateSnapshot['app']) ? app.stateSnapshot['app'] : undefined;
        const snapshotData = app.stateSnapshot['data'];
        const data: JsonValue | undefined = isJsonObject(snapshotData) ? snapshotData : app.document['data'];

        const isRoot = segments.length === 1 && segments[0] === 'app';
        if (input.format === 'tree') {
            const tree = formatTree({
                root,
                rootKey: segments[segments.length - 1] as string,
                rootPath: segments[0] === 'app' ? `$.${segments.join('.')}` : segments.join('.'),
                depth,
                paths: input.paths !== false
            });
            return this.finish(appId, {
                kind: 'outline',
                appId,
                revision: app.revision,
                text: tree.text,
                lineCount: tree.lineCount,
                cutLines: tree.cutLines,
                localeApplied: true,
                nodeCount: tree.nodeCount
            });
        }
        const snapshot = { app: snapshotApp ?? {}, data: data ?? {} } as JsonObject;
        const trailer = isRoot ? formatLogic(app.document['logic'], (path) => this.stateAt(snapshot, path)) : [];
        const outline = formatOutline({
            root,
            rootKey: isRoot ? undefined : segments[segments.length - 1],
            appPath: segments[0] === 'app' ? segments.slice(1) : undefined,
            overlay,
            snapshotApp,
            recordCount: (target) => this.countRecords(data, target),
            depth,
            trailer
        });
        return this.finish(appId, {
            kind: 'outline',
            appId,
            revision: app.revision,
            text: outline.text,
            lineCount: outline.lineCount,
            cutLines: outline.cutLines,
            localeApplied: locale === undefined || overlay !== undefined
        });
    }

    /** A `$.app` or `$.data` path read from the snapshot */
    private stateAt(snapshot: JsonObject, path: string): JsonValue | undefined {
        if (!path.startsWith('$.')) return undefined;
        const found = resolveDocumentPath(snapshot, path.slice(2).split('.'));
        return found.found ? found.value : undefined;
    }

    private countRecords(data: JsonValue | undefined, target: string): number | undefined {
        if (data === undefined || !target.startsWith(DATA_PREFIX)) return undefined;
        const found = resolveDocumentPath(data, target.slice(DATA_PREFIX.length).split('.'));
        if (!found.found) return undefined;
        if (Array.isArray(found.value)) return (found.value as readonly JsonValue[]).length;
        return isJsonObject(found.value) ? Object.keys(found.value as JsonObject).length : undefined;
    }

    private finish(appId: string, result: OutlineAppResult): OutlineAppResult {
        this.report.info('App outline', {
            appId,
            outcome: result.kind,
            ...(result.kind === 'outline' ? { lineCount: result.lineCount } : {})
        });
        return result;
    }
}

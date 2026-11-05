import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonValue } from '../../domain/JsonValue.js';
import { isNodeValue } from '../../domain/nodeDepth.js';
import type { UiDocument } from '../../domain/UiApp.js';
import type { UiAppResponse } from '../dtos/UiAppResponse.js';
import type { ComponentCatalog } from '../ports/ComponentCatalog.js';
import type { UiAppRepository } from '../ports/UiAppRepository.js';
import type { UiPreviewLog } from '../ports/UiPreviewLog.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export type GetUiAppResult =
    | { readonly kind: 'found'; readonly app: UiAppResponse }
    | { readonly kind: 'not-found'; readonly appId: string };

/** Names of the properties of a root component whose shape type is `icon` */
function iconProperties(catalog: ComponentCatalog, component: string): ReadonlySet<string> {
    const entry = catalog.get(component);
    const properties = entry?.tier === 'root' ? entry.shape['properties'] : undefined;
    if (!isJsonObject(properties)) return new Set();
    return new Set(
        Object.entries(properties)
            .filter(([, shape]) => isJsonObject(shape) && shape['type'] === 'icon')
            .map(([name]) => name)
    );
}

/**
 * The icon names a document sets: a property the component's shape types as `icon`, and any `icon` key (the
 * placement, option and item entries that carry one). Strings that are not icon names drop out later, when the
 * catalog is asked for path data
 */
export function collectIconNames(document: UiDocument, catalog: ComponentCatalog): Set<string> {
    const names = new Set<string>();
    const stack: JsonValue[] = [document];
    while (stack.length > 0) {
        const current = stack.pop() as JsonValue;
        if (Array.isArray(current)) {
            stack.push(...(current as readonly JsonValue[]));
        } else if (isJsonObject(current)) {
            const typed = isNodeValue(current) ? iconProperties(catalog, current.component) : new Set<string>();
            for (const [key, value] of Object.entries(current)) {
                if (typeof value === 'string' && value !== '' && (key === 'icon' || typed.has(key))) names.add(value);
                else stack.push(value);
            }
        }
    }
    return names;
}

/** An app with its previews' status and the path data of the icons it needs, for the minion UI */
export class GetUiApp {
    constructor(
        private readonly repository: UiAppRepository,
        private readonly catalog: ComponentCatalog,
        private readonly previewLog: UiPreviewLog,
        private readonly coreIconNames: readonly string[],
        private readonly now: () => Date,
        private readonly report: UseCaseReport
    ) {}

    async execute(appId: string): Promise<GetUiAppResult> {
        const app = await this.repository.findById(appId);
        if (app === undefined) {
            this.report.info('App read for UI', { appId, outcome: 'not-found' });
            return { kind: 'not-found', appId };
        }
        const core = new Set(this.coreIconNames);
        const wanted = [...collectIconNames(app.document, this.catalog)].filter((name) => !core.has(name)).sort();
        const icons = { ...this.catalog.iconPaths(wanted) };
        const status = await this.previewLog.status(appId, this.now());
        this.report.info('App read for UI', { appId, outcome: 'found', iconCount: Object.keys(icons).length });
        return {
            kind: 'found',
            app: {
                id: app.id,
                name: app.name,
                revision: app.revision,
                document: app.document,
                stateSnapshot: app.stateSnapshot,
                sync: app.sync,
                preview: {
                    attached: status.attached,
                    lastSeenAt: status.lastSeenAt?.toISOString() ?? null,
                    revision: status.revision ?? null,
                    errors: [...status.errors]
                },
                icons,
                createdAt: app.createdAt.toISOString(),
                updatedAt: app.updatedAt.toISOString()
            }
        };
    }
}

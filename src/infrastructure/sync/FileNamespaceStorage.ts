import { access } from 'node:fs/promises';
import { initialRoute, layInstance } from '@punyts/stateui-app/core';
import type { AppDocument, AppInstance, JsonObject as LibraryJsonObject } from '@punyts/stateui-app/core';
import type { JsonValue as SyncValue } from '@punyts/state-sync';
import type { NamespaceStorage, StoredNamespace } from '@punyts/state-sync/authority';
import type { UiInstanceRepository } from '../../application/ports/UiInstanceRepository.js';
import { instanceKeyText } from '../../domain/InstanceKey.js';
import type { InstanceKey } from '../../domain/InstanceKey.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import type { PartFolders } from '../storage/PartFolders.js';
import { isAppId } from '../storage/PartFolders.js';
import { readJson, writeJsonAtomic } from '../storage/atomicFile.js';
import type { InstanceStart } from './InstanceStart.js';

const NAMESPACE_PREFIX = 'apps.';
const INSTANCE_PREFIX = 'instances.';

/**
 * The sync namespace of an old app document, `apps.<appId>`, or of a running instance of an owner app,
 * `instances.<persona>.<ownerId>.<appId>`
 */
export function appNamespace(app: string | InstanceKey): string {
    return typeof app === 'string' ? `${NAMESPACE_PREFIX}${app.toLowerCase()}` : `${INSTANCE_PREFIX}${instanceKeyText(app)}`;
}

function appIdOf(namespace: string): string {
    const appId = namespace.slice(NAMESPACE_PREFIX.length);
    if (!namespace.startsWith(NAMESPACE_PREFIX) || !isAppId(appId)) throw new Error(`${namespace} is not the namespace of an app`);
    return appId;
}

function isStoredNamespace(value: unknown): value is StoredNamespace {
    return (
        isJsonObject(value) &&
        isJsonObject(value['state']) &&
        typeof value['revision'] === 'number' &&
        Array.isArray(value['log']) &&
        Array.isArray(value['applied'])
    );
}

/**
 * The state of each old app's authority as `state.json` in the app's folder: the state, its revision, the change log
 * and the applied change ids. A save after the app was deleted is dropped, so a delete that races a save leaves no
 * folder. Instances of owner apps are kept by `InstanceNamespaceStorage`
 */
export class FileNamespaceStorage implements NamespaceStorage {
    constructor(private readonly folders: PartFolders) {}

    async load(namespace: string): Promise<StoredNamespace | undefined> {
        const parsed = await readJson(this.folders.stateFile(appIdOf(namespace)));
        if (parsed === undefined) return undefined;
        if (!isStoredNamespace(parsed)) throw new Error(`state.json of ${namespace} is damaged`);
        return parsed;
    }

    async save(namespace: string, stored: StoredNamespace): Promise<void> {
        const appId = appIdOf(namespace);
        try {
            await access(this.folders.appFile(appId));
        } catch {
            return;
        }
        await writeJsonAtomic(this.folders.stateFile(appId), stored);
    }
}

/** Reports a stored instance or persona dataset that was ignored, or a value of the instance that no longer fits */
export type InstanceProblemReport = (message: string, fields: Readonly<Record<string, string>>) => void;

function without(data: JsonObject, keys: readonly string[]): JsonObject {
    return Object.fromEntries(Object.entries(data).filter(([key]) => !keys.includes(key)));
}

function objectOr(value: unknown): JsonObject {
    return isJsonObject(value) ? value : {};
}

/**
 * The state of one running instance, kept as the persona's instance (`UiInstanceRepository`), not as a sync log.
 *
 * `load` builds the starting state: the assembled view (`$.app` and `$.screens` empty, as sparse as for old apps, the
 * start `$.route`, the document's `$.data` by binding) with the persona's records and its diff laid over it; the route
 * and the active theme are checked by `layInstance`, and what no longer fits is reported and dropped. `save` stores the
 * diff of the state over that view, leaving out the bound data and `$.server`, and the records of each persona
 * binding that changed. The copies of shared datasets under `$.data` are not the instance's, so they are never saved.
 *
 * Nothing of the authority's log is kept, so a loaded instance's revision is the clock in milliseconds: a view that
 * reconnects with a revision from before the server started is behind it and gets a snapshot
 */
export class InstanceNamespaceStorage implements NamespaceStorage {
    readonly namespace: string;
    private readonly bound: readonly string[];
    private readonly persona: readonly string[];
    /** The records of each persona binding as last loaded or saved, as JSON text */
    private readonly saved = new Map<string, string>();

    constructor(
        private readonly start: InstanceStart,
        private readonly instances: UiInstanceRepository,
        private readonly report: InstanceProblemReport,
        private readonly now: () => number = Date.now
    ) {
        this.namespace = appNamespace(start.key);
        this.bound = Object.keys(start.bindings);
        this.persona = this.bound.filter((name) => start.bindings[name]?.scope === 'persona');
    }

    async load(namespace: string): Promise<StoredNamespace> {
        this.check(namespace);
        const { appId } = this.start.key;
        const read = await this.instances.get(appId);
        if (read.problem !== undefined) this.report('Instance ignored', { app: appId, reason: read.problem });
        const diff = read.value;

        const data: Record<string, JsonValue> = { ...objectOr(this.start.document['data']) };
        for (const binding of this.persona) {
            const records = await this.instances.getData(appId, binding);
            if (records.problem !== undefined) this.report('Persona records ignored', { app: appId, binding, reason: records.problem });
            if (records.value !== undefined) data[binding] = records.value.records;
            this.saved.set(binding, JSON.stringify(data[binding] ?? null));
        }
        const laid = layInstance(
            { app: {}, data: { ...data, ...without(objectOr(diff['data']), this.bound) } as LibraryJsonObject },
            {
                app: {},
                screens: {},
                ...(diff['route'] !== undefined && { route: diff['route'] as unknown as NonNullable<AppInstance['route']> }),
                ...(diff['theme'] !== undefined && { theme: diff['theme'] as unknown as NonNullable<AppInstance['theme']> })
            },
            this.start.document as unknown as AppDocument
        );
        for (const warning of laid.warnings) this.report('Instance value dropped', { app: appId, path: warning.statePath ?? '$', code: warning.code });

        const state: Record<string, SyncValue> = {
            app: objectOr(diff['app']) as SyncValue,
            screens: objectOr(diff['screens']) as SyncValue,
            data: laid.data as SyncValue
        };
        if (laid.route !== undefined) state['route'] = laid.route as unknown as SyncValue;
        if (Object.keys(laid.active).length > 0) state['theme'] = { active: laid.active };
        return { state, revision: this.now(), log: [], applied: [] };
    }

    async save(namespace: string, stored: StoredNamespace): Promise<void> {
        this.check(namespace);
        const { appId } = this.start.key;
        const { server: _server, data, route, ...rest } = stored.state as JsonObject;
        const allData = objectOr(data);
        // The route and the theme are kept whole, so a stored route always has its screen and params together
        const start = initialRoute(this.start.document as unknown as AppDocument);
        const moved = route !== undefined && JSON.stringify(route) !== JSON.stringify(start ?? null);
        await this.instances.write(appId, { app: {}, screens: {}, data: {} }, { ...rest, ...(moved && { route }), data: without(allData, this.bound) });

        for (const binding of this.persona) {
            const records = allData[binding];
            const text = JSON.stringify(records ?? null);
            const model = this.start.bindings[binding]?.model;
            if (text === this.saved.get(binding) || !isJsonObject(records) || model === undefined) continue;
            await this.instances.writeData(appId, binding, { model, records });
            this.saved.set(binding, text);
        }
    }

    private check(namespace: string): void {
        if (namespace !== this.namespace) throw new Error(`${namespace} is not the namespace of this instance`);
    }
}

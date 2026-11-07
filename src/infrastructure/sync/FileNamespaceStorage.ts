import { initialRoute, layInstance } from '@punyts/stateui-app/core';
import type { AppDocument, AppInstance, JsonObject as LibraryJsonObject } from '@punyts/stateui-app/core';
import type { JsonValue as SyncValue } from '@punyts/state-sync';
import type { NamespaceStorage, StoredNamespace } from '@punyts/state-sync/authority';
import type { UiInstanceRepository } from '../../application/ports/UiInstanceRepository.js';
import { instanceKeyText } from '../../domain/InstanceKey.js';
import type { InstanceKey } from '../../domain/InstanceKey.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import type { InstanceStart } from './InstanceStart.js';

const INSTANCE_PREFIX = 'instances.';

/** The sync namespace of a running instance of an owner app, `instances.<persona>.<ownerId>.<appId>` */
export function appNamespace(key: InstanceKey): string {
    return `${INSTANCE_PREFIX}${instanceKeyText(key)}`;
}

/** Reports a stored instance or persona dataset that was ignored, or a value of the instance that no longer fits */
export type InstanceProblemReport = (message: string, fields: Readonly<Record<string, string>>) => void;

function without(data: JsonObject, keys: readonly string[]): JsonObject {
    return Object.fromEntries(Object.entries(data).filter(([key]) => !keys.includes(key)));
}

function objectOr(value: unknown): JsonObject {
    return isJsonObject(value) ? value : {};
}

/** A control that switches a theme kind: its `on.change` sets `$.theme.active.<kind>` from its own `.value` */
interface ThemeSwitch {
    /** The node's path in the state, without the `$` */
    readonly path: readonly string[];
    readonly kind: string;
    /** The control's starting value in the definition */
    readonly initial: JsonValue | undefined;
}

const SWITCH_TARGET = /^\$\.theme\.active\.([^.]+)$/;

function switchKind(node: JsonObject): string | undefined {
    const change = objectOr(objectOr(node['on'])['change']);
    if (change['command'] !== 'set' || change['from'] !== '.value' || typeof change['target'] !== 'string') return undefined;
    return SWITCH_TARGET.exec(change['target'])?.[1];
}

function collectSwitches(value: JsonValue, path: readonly string[], found: ThemeSwitch[]): void {
    if (!isJsonObject(value)) return;
    const kind = switchKind(value);
    if (kind !== undefined) found.push({ path, kind, initial: value['value'] });
    for (const [key, child] of Object.entries(value)) if (key !== 'on') collectSwitches(child, [...path, key], found);
}

/** The theme switch controls of the app's tree and of each screen's tree */
function themeSwitches(document: JsonObject): ThemeSwitch[] {
    const found: ThemeSwitch[] = [];
    collectSwitches(document['app'] ?? null, ['app'], found);
    for (const [name, screen] of Object.entries(objectOr(document['screens']))) collectSwitches(objectOr(screen)['root'] ?? null, ['screens', name], found);
    return found;
}

/** The stored node of a switch in the diff, created along the path when `create` */
function storedNode(diff: Record<string, JsonValue>, path: readonly string[], create: boolean): Record<string, JsonValue> | undefined {
    let at: Record<string, JsonValue> = diff;
    for (const key of path) {
        const next = at[key];
        if (!isJsonObject(next)) {
            if (!create) return undefined;
            at[key] = {};
        }
        at = at[key] as Record<string, JsonValue>;
    }
    return at;
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
        // A copy: the switch controls are brought in line with the theme below
        const diff = JSON.parse(JSON.stringify(read.value)) as Record<string, JsonValue>;
        const switches = themeSwitches(this.start.document as unknown as JsonObject);
        const theme = objectOr(diff['theme']);
        const active: Record<string, JsonValue> = { ...objectOr(theme['active']) };
        // An instance saved before the theme choice was kept has the user's pick only in its switch control
        for (const control of switches) {
            const picked = storedNode(diff, control.path, false)?.['value'];
            if (active[control.kind] === undefined && typeof picked === 'string') active[control.kind] = picked;
        }
        if (Object.keys(active).length > 0) diff['theme'] = { ...theme, active };

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

        // A switch control shows the theme the page shows: the chosen one, or its own starting value when none is chosen
        for (const control of switches) {
            const shown = laid.active[control.kind];
            const node = storedNode(diff, control.path, false);
            if (shown === undefined || shown === control.initial) {
                if (node !== undefined) delete node['value'];
            } else if (node?.['value'] !== shown) {
                (storedNode(diff, control.path, true) as Record<string, JsonValue>)['value'] = shown;
            }
        }

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

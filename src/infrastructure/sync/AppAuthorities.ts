import type { Report } from '@punyts/core';
import type { ComponentLibrary, LogicTraceRun } from '@punyts/stateui-app/core';
import type { JsonValue as SyncValue } from '@punyts/state-sync';
import { createAuthority } from '@punyts/state-sync/authority';
import type { Authority, NamespaceStorage, ServerWrite } from '@punyts/state-sync/authority';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { InstanceKey } from '../../domain/InstanceKey.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import type { UiDocument } from '../../domain/UiApp.js';
import { AppCalls } from './AppCalls.js';
import type { AppProcedure } from './AppCalls.js';
import type { DataGate } from './AppLogic.js';
import { AppLogic } from './AppLogic.js';
import { dataWrites } from './dataWrites.js';
import type { DataWrite } from './dataWrites.js';
import { appNamespace } from './FileNamespaceStorage.js';
import type { InstanceStart } from './InstanceStart.js';

/** A client emit, with the app and the id of the view that raised it */
export type AppEmitHandler = (appId: string, name: string, value: JsonValue | undefined, viewId: string) => void;

/** More data changes than this in one document write set `$.data` whole */
const MAX_DATA_WRITES = 200;

/** The `DataGate` of every namespace: checks and follows the server writes to the shared datasets an instance binds */
export interface InstanceDataGate {
    check(namespace: string, writes: readonly ServerWrite[]): string | undefined;
    applied(namespace: string, writes: readonly ServerWrite[]): void;
}

/** The view id the events of an app's own logic (`emit`, `logic.failed`) are recorded under */
export const LOGIC_VIEW_ID = 'logic';

/** What Full-mode apps need to run their `logic` on the server */
export interface AppLogicOptions {
    library: ComponentLibrary;
    report: Pick<Report, 'info'>;
    /** The server procedures a `call` runs by name; a call to any other name waits for the agent (`ui_call_answer`) */
    procedures?: Readonly<Record<string, AppProcedure>>;
}

/**
 * One state-sync authority per running app, made when its state is first needed (Full mode), keyed by its sync
 * namespace (`appNamespace`). It owns the order of the state changes: the views' changes over their sockets and the
 * tools' writes. `$.app` stays sparse (only the articulation a user or a tool changed), so changes create missing
 * parents. With `logic` options the app's `logic` runs on its authority (`AppLogic`).
 *
 * - An old app document (`apps.<appId>`): the state starts as the document's `data` and an empty `app`, kept by the
 *   storage given to the constructor.
 * - An instance of an owner app (`instances.<persona>.<ownerId>.<appId>`): the state is the assembled view with the
 *   persona's instance laid over it, kept by the instance's own storage (`InstanceNamespaceStorage`), and the logic is
 *   the assembled logic (the app's units and its bound modules)
 */
export class AppAuthorities {
    /** By namespace */
    private readonly authorities = new Map<string, Promise<Authority>>();
    /** By namespace */
    private readonly logics = new Map<string, AppLogic>();
    /** The app id each namespace records its events and calls under */
    private readonly appIds = new Map<string, string>();
    /** The answers to the apps' `call` commands */
    readonly calls: AppCalls;

    constructor(
        private readonly storage: NamespaceStorage,
        private readonly onEmit: AppEmitHandler,
        /** The key that encrypts `$.server` at rest; without it an app whose state has `$.server` is refused */
        private readonly serverKey?: Uint8Array,
        private readonly logic?: AppLogicOptions,
        /** Shared datasets (`DatasetHub`): asked before each server write of an instance and told after */
        private readonly dataGate?: InstanceDataGate
    ) {
        this.calls = new AppCalls((appId, name, payload) => this.onEmit(appId.toLowerCase(), name, payload, LOGIC_VIEW_ID), logic?.procedures);
    }

    /** The authority of an app; `document` gives the state at revision 0 when nothing is stored */
    authority(appId: string, document: UiDocument): Promise<Authority> {
        const data = document['data'];
        return this.open(appNamespace(appId), appId.toLowerCase(), document, this.storage, { data: (isJsonObject(data) ? data : {}) as SyncValue, app: {} });
    }

    /** The authority of a running instance, over the instance's own storage, which gives the starting state */
    instance(start: InstanceStart, storage: NamespaceStorage): Promise<Authority> {
        return this.open(appNamespace(start.key), start.key.appId.toLowerCase(), start.document, storage, {});
    }

    /** A tool's write to a running instance, as `write` is for an old app */
    async writeInstance(start: InstanceStart, storage: NamespaceStorage, path: string, value: JsonValue | undefined, options: { logic?: boolean } = {}): Promise<string | undefined> {
        return this.writeTo(appNamespace(start.key), await this.instance(start, storage), path, value, options);
    }

    /** A copy of a running instance's state, without `$.server` */
    async instanceState(start: InstanceStart, storage: NamespaceStorage): Promise<JsonObject> {
        const { server: _server, ...state } = (await this.instance(start, storage)).state() as JsonObject;
        return state;
    }

    /**
     * Writes from outside a running instance (a shared dataset changed) applied to its authority as one push, then
     * looked up by its logic
     */
    receiveInstance(key: InstanceKey, authority: Authority, writes: readonly ServerWrite[]): void {
        const logic = this.logics.get(appNamespace(key));
        if (logic !== undefined) logic.receive(writes);
        else authority.writeAll(writes);
    }

    /** Closes a running instance's connections, waits for its saves and forgets it */
    forgetInstance(key: InstanceKey): Promise<void> {
        return this.forgetNamespace(appNamespace(key));
    }

    /** The authority of a namespace, made on first use; its emits and its logic's events are recorded under `appId` */
    private open(namespace: string, appId: string, document: UiDocument, storage: NamespaceStorage, initial: Record<string, SyncValue>): Promise<Authority> {
        let authority = this.authorities.get(namespace);
        if (authority === undefined) {
            authority = createAuthority({
                namespace,
                storage,
                initial,
                createParents: true,
                ...(this.serverKey !== undefined && { serverKey: this.serverKey })
            }).then((created) => {
                created.onEmit((name, value, clientId) => this.onEmit(appId, name, value as JsonValue | undefined, clientId));
                this.startLogic(namespace, appId, created, document);
                return created;
            }, (error: unknown) => {
                throw this.explain(appId, error);
            });
            authority.catch(() => this.authorities.delete(namespace));
            this.authorities.set(namespace, authority);
            this.appIds.set(namespace, appId);
        }
        return authority;
    }

    private startLogic(namespace: string, appId: string, authority: Authority, document: UiDocument): void {
        if (this.logic === undefined) return;
        const { library, report } = this.logic;
        const logic = new AppLogic(
            authority,
            library,
            (name, payload) => this.onEmit(appId, name, payload, LOGIC_VIEW_ID),
            (message, failure) => report.info(message, { app: appId, kind: failure.kind, name: failure.name, from: failure.from, command: failure.command, reason: failure.reason }),
            (name, payload) => this.calls.ask(appId, name, payload),
            this.gateOf(namespace)
        );
        this.logics.set(namespace, logic);
        try {
            logic.setDocument(document);
        } catch (error) {
            report.info('App logic did not start', { app: appId, reason: error instanceof Error ? error.message : String(error) });
        }
    }

    /**
     * The app's document changed. When its authority runs, what changed in the document's `data` is written into the
     * state at the paths that changed (no guard asks, no rule fires, as for a reset), so the open views show it; the
     * rest of `$.data` keeps what users and tools changed. Then its logic is rebuilt
     */
    async documentChanged(appId: string, document: UiDocument, previous?: UiDocument): Promise<void> {
        const key = appNamespace(appId);
        const authority = this.authorities.get(key);
        if (authority !== undefined && previous !== undefined) {
            const writes: DataWrite[] = [];
            const before = isJsonObject(previous['data']) ? previous['data'] : {};
            const after = isJsonObject(document['data']) ? document['data'] : {};
            dataWrites('$.data', before, after, writes);
            const created = await authority.catch(() => undefined);
            if (created !== undefined && writes.length > 0) {
                created.writeAll(writes.length > MAX_DATA_WRITES ? [{ path: '$.data', op: 'set', value: after as SyncValue }] : writes);
            }
        }
        const logic = this.logics.get(key);
        if (logic === undefined) return;
        try {
            logic.setDocument(document);
        } catch (error) {
            this.logic?.report.info('App logic did not start', { app: appId, reason: error instanceof Error ? error.message : String(error) });
        }
    }

    /**
     * A tool's write to an app's state: asked of the guards, written, and looked up by the logic. Returns the reason
     * when a guard refused it
     */
    async write(appId: string, document: UiDocument, path: string, value: JsonValue | undefined, options: { logic?: boolean } = {}): Promise<string | undefined> {
        return this.writeTo(appNamespace(appId), await this.authority(appId, document), path, value, options);
    }

    private writeTo(namespace: string, authority: Authority, path: string, value: JsonValue | undefined, options: { logic?: boolean }): string | undefined {
        const logic = this.logics.get(namespace);
        if (logic !== undefined) return logic.write(path, value, options.logic !== false);
        const write: ServerWrite = value === undefined ? { path, op: 'delete' } : { path, op: 'set', value: value as SyncValue };
        const refused = this.dataGate?.check(namespace, [write]);
        if (refused !== undefined) return refused;
        authority.write(write);
        this.dataGate?.applied(namespace, [write]);
        return undefined;
    }

    private gateOf(namespace: string): DataGate | undefined {
        const gate = this.dataGate;
        if (gate === undefined) return undefined;
        return { check: (writes) => gate.check(namespace, writes), applied: (writes) => gate.applied(namespace, writes) };
    }

    /**
     * Puts the app's state back to the document: `$.data` becomes the document's data and `$.app` loses every
     * articulation a user or a tool changed. No guard asks and no rule fires; then the logic starts again, so machines
     * are in their initial states, timers re-arm and the trace is empty. `$.server` is kept
     */
    async reset(appId: string, document: UiDocument): Promise<void> {
        const authority = await this.authority(appId, document);
        const data = document['data'];
        authority.writeAll([
            { path: '$.data', op: 'set', value: (isJsonObject(data) ? data : {}) as SyncValue },
            { path: '$.app', op: 'set', value: {} }
        ]);
        const logic = this.logics.get(appNamespace(appId));
        if (logic === undefined) return;
        try {
            logic.setDocument(document);
        } catch (error) {
            this.logic?.report.info('App logic did not start', { app: appId, reason: error instanceof Error ? error.message : String(error) });
        }
    }

    /** The app's logic trace, oldest run first; undefined when its logic does not run on the server */
    trace(appId: string): LogicTraceRun[] | undefined {
        return this.logics.get(appNamespace(appId))?.trace();
    }

    clearTrace(appId: string): void {
        this.logics.get(appNamespace(appId))?.clearTrace();
    }

    /** A stored `$.server` without a key is the one failure the operator can fix; it gets a message that says how */
    private explain(appId: string, error: unknown): Error {
        const message = error instanceof Error ? error.message : String(error);
        if (this.serverKey === undefined && message.includes('$.server')) {
            return new Error(`App ${appId} keeps $.server state, which is encrypted: start the server with --secret-key-file or STATEUI_MCP_SECRET_KEY`, { cause: error });
        }
        return error instanceof Error ? error : new Error(message);
    }

    /** A copy of the app's state: `{ data, app }` */
    async state(appId: string, document: UiDocument): Promise<JsonObject> {
        const { server: _server, ...state } = (await this.authority(appId, document)).state() as JsonObject;
        return state;
    }

    /** Closes the app's connections, waits for its saves and forgets it; for a deleted app */
    async forget(appId: string): Promise<void> {
        await this.forgetNamespace(appNamespace(appId));
    }

    private async forgetNamespace(namespace: string): Promise<void> {
        const authority = this.authorities.get(namespace);
        if (authority === undefined) return;
        this.authorities.delete(namespace);
        this.logics.get(namespace)?.dispose();
        this.logics.delete(namespace);
        this.calls.forget(this.appIds.get(namespace) ?? '');
        this.appIds.delete(namespace);
        const created = await authority.catch(() => undefined);
        if (created === undefined) return;
        created.close();
        await created.flush();
    }

    /** Closes every connection and waits for every save */
    async close(): Promise<void> {
        await Promise.all([...this.authorities.keys()].map((namespace) => this.forgetNamespace(namespace)));
    }
}

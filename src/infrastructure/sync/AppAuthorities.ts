import type { Report } from '@punyts/core';
import type { ComponentLibrary, LogicEffectInfo, LogicFunctions, LogicTraceRun } from '@punyts/stateui-app/core';
import type { JsonValue as SyncValue } from '@punyts/state-sync';
import { createAuthority } from '@punyts/state-sync/authority';
import type { Authority, NamespaceStorage, ServerWrite } from '@punyts/state-sync/authority';
import type { InstanceKey } from '../../domain/InstanceKey.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import type { UiDocument } from '../../domain/UiApp.js';
import { AppCalls } from './AppCalls.js';
import type { AppProcedure } from './AppCalls.js';
import { AppEffects } from './AppEffects.js';
import type { AppLogicLimits, DataGate } from './AppLogic.js';
import { AppLogic } from './AppLogic.js';
import { appNamespace } from './FileNamespaceStorage.js';
import type { InstanceStart } from './InstanceStart.js';

/** A client emit, with the app and the id of the view that raised it */
export type AppEmitHandler = (appId: string, name: string, value: JsonValue | undefined, viewId: string) => void;

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
    /** The compute, expression and effect functions the logic runs by name */
    functions?: LogicFunctions;
    /**
     * Whether a `call` with no procedure and an effect with no function wait for the agent (`ui_call_answer`,
     * `ui_effect_answer`); false: they fail at once, as on a server where no agent answers them. Default true
     */
    agentAnswers?: boolean;
    /** Bounds on each instance's logic */
    limits?: AppLogicLimits;
}

/**
 * One state-sync authority per running instance of an owner app (`instances.<persona>.<ownerId>.<appId>`), made when
 * its state is first needed, keyed by its sync namespace (`appNamespace`). It owns the order of the state changes: the
 * views' changes over their sockets and the tools' writes. `$.app` stays sparse (only the articulation a user or a tool
 * changed), so changes create missing parents. The state is the assembled view with the persona's instance laid over
 * it, kept by the instance's own storage (`InstanceNamespaceStorage`), and with `logic` options the logic is the
 * assembled logic (the app's units and its bound modules), run by `AppLogic`
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
    /** The effects of Full-mode logic that wait for the agent's answer */
    readonly effects: AppEffects;

    constructor(
        private readonly onEmit: AppEmitHandler,
        /** The key that encrypts `$.server` at rest; without it an app whose state has `$.server` is refused */
        private readonly serverKey?: Uint8Array,
        private readonly logic?: AppLogicOptions,
        /** Shared datasets (`DatasetHub`): asked before each server write of an instance and told after */
        private readonly dataGate?: InstanceDataGate
    ) {
        this.calls = new AppCalls((appId, name, payload) => this.onEmit(appId.toLowerCase(), name, payload, LOGIC_VIEW_ID), logic?.procedures);
        this.effects = new AppEffects((appId, name, payload) => this.onEmit(appId.toLowerCase(), name, payload, LOGIC_VIEW_ID));
    }

    /** The authority of a running instance, over the instance's own storage, which gives the starting state */
    instance(start: InstanceStart, storage: NamespaceStorage): Promise<Authority> {
        return this.open(appNamespace(start.key), start.key.appId.toLowerCase(), start.document, storage, {}, this.dataGate === undefined);
    }

    /**
     * Runs a running instance's deriving rules: with shared datasets its logic starts without them, and the instance
     * side runs them once the instance is attached, so their writes reach the datasets
     */
    deriveInstance(key: InstanceKey): void {
        if (this.dataGate !== undefined) this.logics.get(appNamespace(key))?.derive();
    }

    /** A tool's write to a running instance: asked of the guards, written, and looked up by the logic. Returns the reason when a guard refused it */
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
    private open(namespace: string, appId: string, document: UiDocument, storage: NamespaceStorage, initial: Record<string, SyncValue>, derive = true): Promise<Authority> {
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
                this.startLogic(namespace, appId, created, document, derive);
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

    private startLogic(namespace: string, appId: string, authority: Authority, document: UiDocument, derive = true): void {
        if (this.logic === undefined) return;
        const { library, report, procedures, agentAnswers = true } = this.logic;
        const logic = new AppLogic(
            authority,
            library,
            (name, payload) => this.onEmit(appId, name, payload, LOGIC_VIEW_ID),
            (message, failure) => report.info(message, { app: appId, kind: failure.kind, name: failure.name, from: failure.from, command: failure.command, reason: failure.reason }),
            agentAnswers || procedures !== undefined
                ? (name, payload) =>
                      agentAnswers || procedures?.[name] !== undefined ? this.calls.ask(appId, name, payload) : Promise.resolve({ status: 'rejected' as const, reason: `no server answers "${name}"` })
                : undefined,
            this.gateOf(namespace),
            this.logic.functions,
            agentAnswers ? (request, signal) => this.effects.ask(appId, request, signal) : undefined,
            this.logic.limits
        );
        this.logics.set(namespace, logic);
        try {
            logic.setDocument(document, { derive });
        } catch (error) {
            report.info('App logic did not start', { app: appId, reason: error instanceof Error ? error.message : String(error) });
        }
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

    /** The logic trace of the authority of a namespace (an instance's: `InstanceViews.namespace`), oldest run first; undefined when no logic runs there */
    traceOf(namespace: string): LogicTraceRun[] | undefined {
        return this.logics.get(namespace)?.trace();
    }

    /** The effects of the logic of a namespace: token, running and cache size; undefined when no logic runs there */
    effectsOf(namespace: string): LogicEffectInfo[] | undefined {
        return this.logics.get(namespace)?.effects();
    }

    clearTraceOf(namespace: string): void {
        this.logics.get(namespace)?.clearTrace();
    }

    /** A stored `$.server` without a key is the one failure the operator can fix; it gets a message that says how */
    private explain(appId: string, error: unknown): Error {
        const message = error instanceof Error ? error.message : String(error);
        if (this.serverKey === undefined && message.includes('$.server')) {
            return new Error(`App ${appId} keeps $.server state, which is encrypted: start the server with --secret-key-file or STATEUI_MCP_SECRET_KEY`, { cause: error });
        }
        return error instanceof Error ? error : new Error(message);
    }

    private async forgetNamespace(namespace: string): Promise<void> {
        const authority = this.authorities.get(namespace);
        if (authority === undefined) return;
        this.authorities.delete(namespace);
        this.logics.get(namespace)?.dispose();
        this.logics.delete(namespace);
        this.calls.forget(this.appIds.get(namespace) ?? '');
        this.effects.forget(this.appIds.get(namespace) ?? '');
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

import { LOGIC_FAILED_EVENT, NOTIFY_PREFIX, ROUTE_PATH, cloneJson, createLogicEngine, createLogicIndex, readLogic, resolveNode } from '@punyts/stateui-app/core';
import type {
    ComponentLibrary,
    JsonValue as AppValue,
    LogicAnswer,
    LogicChange,
    LogicEngine,
    LogicEffectInfo,
    LogicFailure,
    LogicFunctions,
    LogicHost,
    LogicTraceRun,
    LogicWrite,
    Node,
    ResolvedTree,
    RouteScreens
} from '@punyts/stateui-app/core';
import type { JsonValue as SyncValue } from '@punyts/state-sync';
import type { Authority, ChangeContext, ChangeVerdict, ServerWrite } from '@punyts/state-sync/authority';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import type { UiDocument } from '../../domain/UiApp.js';

/** The roots logic watches; guards are registered on each */
const ROOTS = ['$.app', '$.data', '$.server', '$.screens', ROUTE_PATH];
const APP_ROOT = '$.app';

/** What the app server learns from an app's logic: an `emit` or a failure, for `ui_events_read` */
export type AppLogicEvent = (name: string, payload: JsonValue | undefined) => void;

/** Answers an app's effects whose function the server does not have (`LogicHost.effect`) */
export type AppLogicEffect = NonNullable<LogicHost['effect']>;

/** Answers an app's `call` commands */
export type AppLogicCall = (name: string, payload: JsonValue) => Promise<LogicAnswer>;

function covers(outer: string, inner: string): boolean {
    return outer === inner || inner.startsWith(`${outer}.`);
}

/** The authority's sparse value laid over the document's value: objects merge key by key, anything else replaces */
function overlay(base: AppValue | undefined, top: AppValue | undefined): AppValue | undefined {
    if (top === undefined) return base;
    if (!isJsonObject(base as JsonValue) || !isJsonObject(top as JsonValue)) return top;
    const merged: Record<string, AppValue> = { ...(base as Record<string, AppValue>) };
    for (const [key, value] of Object.entries(top as Record<string, AppValue>)) merged[key] = overlay(merged[key], value) as AppValue;
    return merged;
}

function toServerWrite(write: LogicWrite): ServerWrite {
    return write.value === undefined ? { path: write.path, op: 'delete' } : { path: write.path, op: 'set', value: write.value as SyncValue };
}

/**
 * Checks and follows the server writes of one instance (its logic's commits and the tools' writes) for the shared
 * datasets it binds (`DatasetHub`): `check` is asked before the writes are applied and refuses them with a reason;
 * `applied` is told after
 */
export interface DataGate {
    check(writes: readonly ServerWrite[]): string | undefined;
    applied(writes: readonly ServerWrite[]): void;
}

/**
 * Runs one Full-mode app's `logic` on its authority. Client changes reach the engine after they are applied and
 * acknowledged (`onApplied`); guard rules answer before (`onChange`), so a refused change is an authority reject and
 * the view gets `sync.rejected`. Tool writes go through `write`, which asks the guards and runs the logic the same way.
 * A transition's writes are pushed as one `changes` message (`writeAll`).
 *
 * The authority keeps `$.app` sparse, so `$.app` is read through the document: the authority's value laid over the
 * document's value with the shape defaults. `notify` and `logic.failed` are sent to the views as app events;
 * `emit` and failures also go to `onEvent`, for the agent. The value a client change replaces is read before it is
 * applied (`onChange`), for `$previous`. Timers run on `setTimeout` without keeping the process alive; `call` goes to
 * `onCall`
 */
export class AppLogic {
    private engine: LogicEngine | undefined;
    private read: (path: string) => AppValue | undefined = (path) => this.authority.get(path) as AppValue | undefined;
    private readonly removers: (() => void)[] = [];
    /** The value each client change replaced, by path, from `onChange` until `onApplied` */
    private readonly previous = new Map<string, AppValue | undefined>();

    constructor(
        private readonly authority: Authority,
        private readonly library: ComponentLibrary,
        private readonly onEvent: AppLogicEvent,
        private readonly report: (message: string, failure: LogicFailure) => void,
        private readonly onCall?: AppLogicCall,
        private readonly gate?: DataGate,
        private readonly functions?: LogicFunctions,
        private readonly onEffect?: AppLogicEffect
    ) {
        this.removers.push(
            authority.onApplied((change) => {
                const previous = this.previous.get(change.path);
                this.previous.delete(change.path);
                const applied: LogicChange = change.op === 'delete' ? { path: change.path } : { path: change.path, value: change.value as AppValue };
                if (previous !== undefined) applied.previous = previous;
                this.engine?.changes([applied]);
            })
        );
        for (const root of ROOTS) this.removers.push(authority.onChange(root, (context) => this.guardClient(context)));
    }

    /**
     * Builds the engine from the document's `logic` (only its valid machines and rules), writes missing initial states
     * and runs the rules that only derive values; with `derive` false that pass waits for `derive()` (an instance runs it
     * once it is attached to its shared datasets, so the derived writes reach them)
     */
    setDocument(document: UiDocument, options: { derive?: boolean } = {}): void {
        this.engine?.stop();
        this.engine = undefined;
        const logic = document['logic'];
        if (!isJsonObject(logic)) return;
        const app = document['app'];
        const composed = isJsonObject(document['composed']) ? (document['composed'] as unknown as Record<string, Node>) : {};
        const resolved = resolveNode(cloneJson(app as AppValue) as unknown as Node, this.library, composed);
        const screens = isJsonObject(document['screens']) ? (document['screens'] as unknown as Record<string, { root: Node }>) : {};
        const trees: Record<string, ResolvedTree> = {};
        for (const [name, screen] of Object.entries(screens)) {
            const result = resolveNode(cloneJson(screen.root as unknown as AppValue) as unknown as Node, this.library, composed, { path: `$.screens.${name}` });
            trees[name] = { node: result.node, instances: result.instances };
        }
        const index = createLogicIndex(resolved, this.library, document['data'] as AppValue | undefined, {
            trees,
            current: () => {
                const screen = this.authority.get(`${ROUTE_PATH}.screen`);
                return typeof screen === 'string' ? screen : undefined;
            }
        });
        const { logic: valid } = readLogic(logic, { resolve: index.resolve, ...(this.functions === undefined ? {} : { functions: this.functions }) });
        const read = (path: string): AppValue | undefined => {
            const stored = this.authority.get(path) as AppValue | undefined;
            return covers(APP_ROOT, path) ? overlay(index.initial(path), stored) : stored;
        };
        this.read = read;
        const host: LogicHost = {
            get: read,
            commit: (writes) => {
                const server = writes.map(toServerWrite);
                const refused = this.gate?.check(server);
                if (refused !== undefined) throw new Error(refused);
                this.authority.writeAll(server);
                this.gate?.applied(server);
            },
            ...(this.gate !== undefined && { guard: (change: LogicChange) => (this.gate as DataGate).check([toServerWrite(change)]) }),
            resolve: index.resolve,
            ...(this.functions === undefined ? {} : { functions: this.functions }),
            screens: () => (isJsonObject(document['screens']) ? (document['screens'] as unknown as RouteScreens) : undefined),
            fields: index.fields,
            initial: index.initial,
            records: index.records,
            notify: (name, payload) => this.authority.emit(`${NOTIFY_PREFIX}${name}`, payload as SyncValue),
            emit: (name, payload) => this.onEvent(name, payload as JsonValue),
            schedule: (ms, run) => {
                const timer = setTimeout(run, ms);
                timer.unref?.();
                return () => clearTimeout(timer);
            },
            ...(this.onEffect === undefined ? {} : { effect: this.onEffect }),
            ...(this.onCall === undefined ? {} : { call: (name: string, payload: AppValue) => (this.onCall as AppLogicCall)(name, payload as JsonValue) }),
            failed: (failure) => {
                this.report('Logic failed', failure);
                const payload = { ...failure } as unknown as JsonObject;
                this.authority.emit(LOGIC_FAILED_EVENT, payload as SyncValue);
                this.onEvent(LOGIC_FAILED_EVENT, payload);
            }
        };
        this.engine = createLogicEngine(valid, host);
        this.engine.start({ derive: options.derive !== false });
    }

    /** Runs the rules that only derive values, once, as at start (`LogicEngine.derive`) */
    derive(): void {
        this.engine?.derive();
    }

    /**
     * A tool's write: refused with the guard's reason, or written and looked up like a client change. Returns the
     * reason when a guard refused it. With `logic` false it is written as it is: no guard asks, no rule fires
     */
    write(path: string, value: JsonValue | undefined, logic = true): string | undefined {
        const write: ServerWrite = value === undefined ? { path, op: 'delete' } : { path, op: 'set', value: value as SyncValue };
        const refused = this.gate?.check([write]);
        if (refused !== undefined) return refused;
        if (!logic) {
            this.authority.write(write);
            this.gate?.applied([write]);
            return undefined;
        }
        const change: LogicChange = value === undefined ? { path } : { path, value: value as AppValue };
        const reason = this.engine?.guard(change);
        if (reason !== undefined) return reason;
        const previous = this.read(path);
        if (previous !== undefined) change.previous = previous;
        this.authority.write(write);
        this.gate?.applied([write]);
        this.engine?.changes([change]);
        return undefined;
    }

    /**
     * Writes that come from outside the instance (a shared dataset changed): applied as one push without a guard, then
     * looked up by the logic like client changes
     */
    receive(writes: readonly ServerWrite[]): void {
        const changes = writes.map((write): LogicChange => {
            const change: LogicChange = write.op === 'delete' ? { path: write.path } : { path: write.path, value: write.value as AppValue };
            const previous = this.read(write.path);
            if (previous !== undefined) change.previous = previous;
            return change;
        });
        this.authority.writeAll(writes);
        this.engine?.changes(changes);
    }

    /** The engine's last runs: what started each and what every unit whose trigger matched did; empty without logic */
    /** Each effect: the token it last acted on, whether a call is running, and how many answers its cache holds */
    effects(): LogicEffectInfo[] {
        return this.engine?.effects() ?? [];
    }

    trace(): LogicTraceRun[] {
        return this.engine?.trace() ?? [];
    }

    clearTrace(): void {
        this.engine?.clearTrace();
    }

    dispose(): void {
        for (const remove of this.removers.splice(0)) remove();
        this.engine?.stop();
        this.engine = undefined;
    }

    private guardClient(context: ChangeContext): ChangeVerdict {
        if (this.engine === undefined) return undefined;
        const { change } = context;
        this.previous.set(change.path, this.read(change.path));
        let value = change.value as AppValue | undefined;
        if (change.op === 'merge' && isJsonObject(value as JsonValue)) {
            const current = context.get(change.path);
            value = { ...(isJsonObject(current as JsonValue) ? (current as Record<string, AppValue>) : {}), ...(value as Record<string, AppValue>) };
        }
        const reason = this.engine.guard(change.op === 'delete' ? { path: change.path } : { path: change.path, value: value as AppValue });
        return reason === undefined ? undefined : { result: 'reject', reason };
    }
}

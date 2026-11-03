import { LOGIC_FAILED_EVENT, NOTIFY_PREFIX, cloneJson, createLogicEngine, createLogicIndex, readLogic, resolveNode } from '@punyts/stateui-app/core';
import type { ComponentLibrary, JsonValue as AppValue, LogicEngine, LogicFailure, LogicHost, LogicWrite, Node } from '@punyts/stateui-app/core';
import type { JsonValue as SyncValue } from '@punyts/state-sync';
import type { Authority, ChangeContext, ChangeVerdict, ServerWrite } from '@punyts/state-sync/authority';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import type { UiDocument } from '../../domain/UiApp.js';

/** The roots logic watches; guards are registered on each */
const ROOTS = ['$.app', '$.data', '$.server'];
const APP_ROOT = '$.app';

/** What the app server learns from an app's logic: an `emit` or a failure, for `ui_events_read` */
export type AppLogicEvent = (name: string, payload: JsonValue | undefined) => void;

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
 * Runs one Full-mode app's `logic` on its authority. Client changes reach the engine after they are applied and
 * acknowledged (`onApplied`); guard rules answer before (`onChange`), so a refused change is an authority reject and
 * the view gets `sync.rejected`. Tool writes go through `write`, which asks the guards and runs the logic the same way.
 * A transition's writes are pushed as one `changes` message (`writeAll`).
 *
 * The authority keeps `$.app` sparse, so `$.app` is read through the document: the authority's value laid over the
 * document's value with the shape defaults. `notify` and `logic.failed` are sent to the views as app events;
 * `emit` and failures also go to `onEvent`, for the agent
 */
export class AppLogic {
    private engine: LogicEngine | undefined;
    private readonly removers: (() => void)[] = [];

    constructor(
        private readonly authority: Authority,
        private readonly library: ComponentLibrary,
        private readonly onEvent: AppLogicEvent,
        private readonly report: (message: string, failure: LogicFailure) => void
    ) {
        this.removers.push(
            authority.onApplied((change) => {
                this.engine?.changes([change.op === 'delete' ? { path: change.path } : { path: change.path, value: change.value as AppValue }]);
            })
        );
        for (const root of ROOTS) this.removers.push(authority.onChange(root, (context) => this.guardClient(context)));
    }

    /** Builds the engine from the document's `logic` (only its valid machines and rules) and writes missing initial states */
    setDocument(document: UiDocument): void {
        const logic = document['logic'];
        if (!isJsonObject(logic)) {
            this.engine = undefined;
            return;
        }
        const app = document['app'];
        const composed = isJsonObject(document['composed']) ? (document['composed'] as unknown as Record<string, Node>) : {};
        const resolved = resolveNode(cloneJson(app as AppValue) as unknown as Node, this.library, composed);
        const index = createLogicIndex(resolved, this.library, document['data'] as AppValue | undefined);
        const { logic: valid } = readLogic(logic, { resolve: index.resolve });
        const host: LogicHost = {
            get: (path) => {
                const stored = this.authority.get(path) as AppValue | undefined;
                return covers(APP_ROOT, path) ? overlay(index.initial(path), stored) : stored;
            },
            commit: (writes) => {
                this.authority.writeAll(writes.map(toServerWrite));
            },
            resolve: index.resolve,
            fields: index.fields,
            initial: index.initial,
            records: index.records,
            notify: (name, payload) => this.authority.emit(`${NOTIFY_PREFIX}${name}`, payload as SyncValue),
            emit: (name, payload) => this.onEvent(name, payload as JsonValue),
            failed: (failure) => {
                this.report('Logic failed', failure);
                const payload = { ...failure } as unknown as JsonObject;
                this.authority.emit(LOGIC_FAILED_EVENT, payload as SyncValue);
                this.onEvent(LOGIC_FAILED_EVENT, payload);
            }
        };
        this.engine = createLogicEngine(valid, host);
        this.engine.start();
    }

    /**
     * A tool's write: refused with the guard's reason, or written and looked up like a client change. Returns the
     * reason when a guard refused it
     */
    write(path: string, value: JsonValue | undefined): string | undefined {
        const change = value === undefined ? { path } : { path, value: value as AppValue };
        const reason = this.engine?.guard(change);
        if (reason !== undefined) return reason;
        this.authority.write(value === undefined ? { path, op: 'delete' } : { path, op: 'set', value: value as SyncValue });
        this.engine?.changes([change]);
        return undefined;
    }

    dispose(): void {
        for (const remove of this.removers.splice(0)) remove();
        this.engine = undefined;
    }

    private guardClient(context: ChangeContext): ChangeVerdict {
        if (this.engine === undefined) return undefined;
        const { change } = context;
        let value = change.value as AppValue | undefined;
        if (change.op === 'merge' && isJsonObject(value as JsonValue)) {
            const current = context.get(change.path);
            value = { ...(isJsonObject(current as JsonValue) ? (current as Record<string, AppValue>) : {}), ...(value as Record<string, AppValue>) };
        }
        const reason = this.engine.guard(change.op === 'delete' ? { path: change.path } : { path: change.path, value: value as AppValue });
        return reason === undefined ? undefined : { result: 'reject', reason };
    }
}

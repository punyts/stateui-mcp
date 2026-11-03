import { randomUUID } from 'node:crypto';
import type { LogicAnswer } from '@punyts/stateui-app/core';
import type { JsonValue } from '../../domain/JsonValue.js';

/** The app event a call the agent answers is queued as, for `ui_events_read` */
export const CALL_EVENT = 'logic.call';

/** The most calls waiting for the agent per app; a call past it is rejected at once */
export const MAX_PENDING_CALLS = 100;

/** A server procedure a `call` runs: the payload and the app in, the answer out */
export type AppProcedure = (payload: JsonValue, context: { appId: string }) => LogicAnswer | Promise<LogicAnswer>;

/** Queues a call for the agent: the app, the event name and its payload `{ id, name, payload }` */
export type CallQueue = (appId: string, name: string, payload: JsonValue) => void;

interface Pending {
    appId: string;
    resolve(answer: LogicAnswer): void;
}

/**
 * The answers to the `call` commands of Full-mode apps. A call whose name is a registered procedure runs it; any other
 * call is queued for the agent as a `logic.call` event (`{ id, name, payload }`) and waits until `answer` gets its id.
 * Waiting calls live in memory: a restart or `forget` drops them, and the machine keeps waiting unless it has an
 * `after` row
 */
export class AppCalls {
    private readonly pending = new Map<string, Pending>();

    constructor(
        private readonly queue: CallQueue,
        private readonly procedures: Readonly<Record<string, AppProcedure>> = {},
        private readonly newId: () => string = randomUUID
    ) {}

    ask(appId: string, name: string, payload: JsonValue): Promise<LogicAnswer> {
        const procedure = Object.hasOwn(this.procedures, name) ? this.procedures[name] : undefined;
        if (procedure !== undefined) return Promise.resolve().then(() => procedure(payload, { appId }));
        const key = appId.toLowerCase();
        if ([...this.pending.values()].filter((call) => call.appId === key).length >= MAX_PENDING_CALLS) {
            return Promise.resolve({ status: 'rejected', reason: `more than ${MAX_PENDING_CALLS} calls are waiting for an answer` });
        }
        const id = this.newId();
        return new Promise((resolve) => {
            this.pending.set(id, { appId: key, resolve });
            this.queue(appId, CALL_EVENT, { id, name, payload });
        });
    }

    /** Gives a waiting call its answer; false when the app has no call with this id waiting */
    answer(appId: string, id: string, answer: LogicAnswer): boolean {
        const call = this.pending.get(id);
        if (call === undefined || call.appId !== appId.toLowerCase()) return false;
        this.pending.delete(id);
        call.resolve(answer);
        return true;
    }

    /** Drops the waiting calls of an app, unanswered */
    forget(appId: string): void {
        const key = appId.toLowerCase();
        for (const [id, call] of this.pending) if (call.appId === key) this.pending.delete(id);
    }
}

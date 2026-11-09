import { randomUUID } from 'node:crypto';
import type { LogicEffectAnswer, LogicEffectRequest } from '@punyts/stateui-app/core';
import type { JsonValue } from '../../domain/JsonValue.js';

/** The app event an effect the agent answers is queued as, for `ui_events_read` */
export const EFFECT_EVENT = 'logic.effect';

/** The most effects waiting for the agent per app; an effect past it fails at once */
export const MAX_PENDING_EFFECTS = 100;

/** Queues an effect for the agent: the app, the event name and its payload `{ id, name, token, request }` */
export type EffectQueue = (appId: string, name: string, payload: JsonValue) => void;

/** What the agent answers: the answer of an effect function, or an error */
export type AgentEffectAnswer = { answer: LogicEffectAnswer } | { error: string };

interface Pending {
    appId: string;
    resolve(answer: LogicEffectAnswer): void;
    reject(error: Error): void;
}

/**
 * The effects of Full-mode apps whose function the server does not have (`LogicHost.effect`): each is queued for the
 * agent as a `logic.effect` event (`{ id, name, token, request }`) and waits until `answer` gets its id. A newer
 * request of the same effect aborts the waiting one, which leaves the queue, so its id is no longer waiting. Waiting
 * effects live in memory: a restart or `forget` drops them, and the status stays `loading` until the request changes
 */
export class AppEffects {
    private readonly pending = new Map<string, Pending>();

    constructor(
        private readonly queue: EffectQueue,
        private readonly newId: () => string = randomUUID
    ) {}

    ask(appId: string, request: LogicEffectRequest, signal: AbortSignal): Promise<LogicEffectAnswer> {
        const key = appId.toLowerCase();
        if ([...this.pending.values()].filter((effect) => effect.appId === key).length >= MAX_PENDING_EFFECTS) {
            return Promise.reject(new Error(`more than ${MAX_PENDING_EFFECTS} effects are waiting for an answer`));
        }
        const id = this.newId();
        return new Promise((resolve, reject) => {
            this.pending.set(id, { appId: key, resolve, reject });
            signal.addEventListener('abort', () => {
                if (this.pending.delete(id)) reject(new Error('a newer request replaced it'));
            });
            this.queue(appId, EFFECT_EVENT, { id, name: request.name, token: request.token, request: request.request as JsonValue });
        });
    }

    /** Gives a waiting effect its answer or error; false when the app has no effect with this id waiting */
    answer(appId: string, id: string, answer: AgentEffectAnswer): boolean {
        const effect = this.pending.get(id);
        if (effect === undefined || effect.appId !== appId.toLowerCase()) return false;
        this.pending.delete(id);
        if ('error' in answer) effect.reject(new Error(answer.error));
        else effect.resolve(answer.answer);
        return true;
    }

    /** Drops the waiting effects of an app, unanswered */
    forget(appId: string): void {
        const key = appId.toLowerCase();
        for (const [id, effect] of this.pending) if (effect.appId === key) this.pending.delete(id);
    }
}

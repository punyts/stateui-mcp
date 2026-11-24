import { randomUUID } from 'node:crypto';
import { createSyncClient } from '@punyts/state-sync';
import type { ChangeOp, JsonValue, LocalChange, StoreBridge, SyncClient, SyncState, SyncStatus } from '@punyts/state-sync';
import { WebSocket } from 'ws';

/** One write to the statenet: `value` undefined deletes the path */
export interface LinkWrite {
    readonly path: string;
    readonly op?: ChangeOp;
    readonly value?: JsonValue;
}

export interface StatenetLinkEvents {
    /** Online with the namespace's state loaded: at the first welcome and after every reconnect */
    readonly onWelcome?: () => void;
    /** Another client changed a path (after the welcome): the value the path now has, undefined when it was deleted */
    readonly onRemote?: (path: string, value: JsonValue | undefined) => void;
    readonly onEmit?: (name: string, value: JsonValue | undefined) => void;
    readonly onStatus?: (status: SyncStatus) => void;
}

const isObject = (value: unknown): value is Record<string, JsonValue> => typeof value === 'object' && value !== null && !Array.isArray(value);
const copy = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

/** Applies a change to a plain state in place, as the sync client applies it: missing parents are created, a delete below one does nothing */
export function applyToState(state: SyncState, path: string, op: ChangeOp, value: JsonValue | undefined): void {
    const keys = path.split('.').slice(1);
    const last = keys.pop();
    if (last === undefined) return;
    let target: Record<string, JsonValue> = state;
    for (const key of keys) {
        const next = target[key];
        if (!isObject(next)) {
            if (op === 'delete') return;
            target[key] = {};
        }
        target = target[key] as Record<string, JsonValue>;
    }
    if (op === 'delete' || value === undefined) {
        delete target[last];
        return;
    }
    const current = target[last];
    if (op === 'merge' && isObject(current) && isObject(value)) Object.assign(current, copy(value));
    else target[last] = copy(value);
}

/**
 * A client of one statenet namespace for a Node server (`@punyts/state-sync`'s sync client over a `ws` WebSocket,
 * reconnecting with its backoff). It keeps the namespace's state as a plain object (`state`), writes to it
 * (`write`, sent in order and resent after a reconnect) and tells of other clients' changes and of emits
 */
export class StatenetLink {
    /** The namespace's state as this client shows it: the statenet's with this client's unacknowledged writes on top */
    state: SyncState = {};
    private readonly client: SyncClient;
    private sendLocal: ((changes: LocalChange[]) => void) | undefined;
    private online = false;

    constructor(
        readonly url: string,
        readonly namespace: string,
        private readonly events: StatenetLinkEvents,
        clientId: string = `stateui-mcp-${randomUUID()}`
    ) {
        const bridge: StoreBridge = {
            load: (state) => {
                this.state = copy(state);
            },
            write: (path, value) => {
                applyToState(this.state, path, value === undefined ? 'delete' : 'set', value);
                if (this.online) this.events.onRemote?.(path, value);
            },
            subscribe: (onChanges) => {
                this.sendLocal = onChanges;
                return () => {
                    this.sendLocal = undefined;
                };
            }
        };
        this.client = createSyncClient({
            namespace,
            bridge,
            clientId,
            transport: {
                connect: (handlers) => {
                    const socket = new WebSocket(url);
                    let closed = false;
                    socket.on('open', () => handlers.onOpen());
                    socket.on('message', (data, isBinary) => {
                        const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
                        handlers.onMessage(isBinary ? new Uint8Array(buffer) : buffer.toString('utf8'));
                    });
                    const close = (): void => {
                        if (closed) return;
                        closed = true;
                        handlers.onClose();
                    };
                    socket.on('close', close);
                    socket.on('error', () => {
                        socket.terminate();
                        close();
                    });
                    return {
                        send: (data) => {
                            if (socket.readyState === WebSocket.OPEN) socket.send(data);
                        },
                        // A close, not a terminate: what was sent just before (a last emit) still goes out first
                        close: () => {
                            if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
                            else socket.close();
                        }
                    };
                }
            },
            onStatus: (report) => {
                const wasOnline = this.online;
                this.online = report.status === 'online';
                this.events.onStatus?.(report.status);
                if (this.online && !wasOnline) this.events.onWelcome?.();
            },
            onEmit: (name, value) => this.events.onEmit?.(name, value)
        });
    }

    get isOnline(): boolean {
        return this.online;
    }

    start(): void {
        this.client.start();
    }

    stop(): void {
        this.online = false;
        this.client.stop();
    }

    /** Writes to the namespace: applied to `state` at once and sent in order (kept while offline) */
    write(writes: readonly LinkWrite[]): void {
        if (writes.length === 0) return;
        const changes: LocalChange[] = writes.map((write) => {
            const op: ChangeOp = write.value === undefined ? 'delete' : (write.op ?? 'set');
            applyToState(this.state, write.path, op, write.value);
            return { id: randomUUID(), path: write.path, op, ...(op !== 'delete' && { value: copy(write.value) as JsonValue }) };
        });
        this.sendLocal?.(changes);
    }

    /** Sends an emit; false when not online (it is not kept) */
    emit(name: string, value?: JsonValue): boolean {
        return this.client.emit(name, value);
    }
}

/** A key a path may name as one segment */
const SAFE_KEY = /^[A-Za-z0-9_-]+$/;

const deepEqual = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    // The order of keys matters: children and record maps are ordered
    return aKeys.every((key, index) => key === bKeys[index] && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
};

/**
 * The writes that turn `before` into `after` below `path`: it descends while both are objects with the same keys in the
 * same order, so a change deep in a large state is one small write, and writes a value whole otherwise
 */
export function diffWrites(before: JsonValue | undefined, after: JsonValue | undefined, path: string, out: LinkWrite[] = []): LinkWrite[] {
    if (deepEqual(before, after)) return out;
    if (isObject(before) && isObject(after)) {
        const beforeKeys = Object.keys(before);
        const afterKeys = Object.keys(after);
        const kept = beforeKeys.filter((key) => key in after);
        const sameOrder = kept.every((key, index) => afterKeys.filter((name) => name in before)[index] === key);
        // A new key goes after the others when it is set, so an order that changed otherwise is written whole
        const appendedOnly = afterKeys.slice(0, kept.length).every((key, index) => key === kept[index]);
        if (sameOrder && appendedOnly && [...beforeKeys, ...afterKeys].every((key) => SAFE_KEY.test(key))) {
            for (const key of beforeKeys) if (!(key in after)) out.push({ path: `${path}.${key}` });
            for (const key of afterKeys) diffWrites(before[key], after[key], `${path}.${key}`, out);
            return out;
        }
    }
    out.push(after === undefined ? { path } : { path, value: after });
    return out;
}

/** The writes that turn the whole state `before` into `after` (top-level branches; `runtime` and `server` never) */
export function diffState(before: SyncState, after: SyncState): LinkWrite[] {
    const out: LinkWrite[] = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
        if (key === 'runtime' || key === 'server' || !SAFE_KEY.test(key)) continue;
        diffWrites(before[key], after[key], `$.${key}`, out);
    }
    return out;
}

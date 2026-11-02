import { randomUUID } from 'node:crypto';
import { copyJson, createMemoryLocalStore, createSyncClient } from '@punyts/state-sync';
import type { JsonValue, LocalChange, SyncClient, SyncState } from '@punyts/state-sync';
import { createWsTransport } from './wsTransport.js';

/** How long the first connection to the statenet may take before a read or a load fails */
export const STATENET_TIMEOUT_MS = 5000;

const isRecord = (value: unknown): value is Record<string, JsonValue> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Applies one write to a plain state in place: a set creates missing parents, undefined deletes */
function writePath(state: SyncState, path: string, value: JsonValue | undefined): void {
    const segments = path.split('.').slice(1);
    const last = segments.pop();
    if (last === undefined) return;
    let container: Record<string, JsonValue> = state;
    for (const segment of segments) {
        const child = container[segment];
        if (!isRecord(child)) {
            if (value === undefined) return;
            container[segment] = {};
        }
        container = container[segment] as Record<string, JsonValue>;
    }
    if (value === undefined) delete container[last];
    else container[last] = copyJson(value);
}

/**
 * A sync client of one statenet namespace held in memory: it keeps the namespace's state as the statenet pushes it, and
 * sends the changes given to `send` in order, each once (a change resent after a reconnect keeps its id, so the
 * statenet applies it once). The client reconnects on its own while it runs
 */
export class StatenetClient {
    private readonly client: SyncClient;
    private readonly listeners = new Set<(changes: LocalChange[]) => void>();
    private state: SyncState = {};
    private welcomed = false;
    private readonly waiting = new Set<() => void>();

    constructor(
        readonly url: string,
        readonly namespace: string
    ) {
        this.client = createSyncClient({
            namespace,
            transport: createWsTransport(url),
            localStore: createMemoryLocalStore(),
            clientId: `stateui-mcp-${randomUUID()}`,
            bridge: {
                load: (state) => {
                    this.state = copyJson(state);
                },
                write: (path, value) => writePath(this.state, path, value),
                subscribe: (onChanges) => {
                    this.listeners.add(onChanges);
                    return () => this.listeners.delete(onChanges);
                }
            },
            onStatus: (report) => {
                if (report.status !== 'online' || this.welcomed) return;
                this.welcomed = true;
                for (const resolve of this.waiting) resolve();
                this.waiting.clear();
            }
        });
        this.client.start();
    }

    /** Resolves once the statenet has welcomed the client; fails after `STATENET_TIMEOUT_MS` */
    ready(): Promise<void> {
        if (this.welcomed) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const done = (): void => {
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(() => {
                this.waiting.delete(done);
                reject(new Error(`The statenet at ${this.url} did not answer for ${this.namespace}`));
            }, STATENET_TIMEOUT_MS);
            this.waiting.add(done);
        });
    }

    /** The statenet's revision as the client confirmed it */
    revision(): number {
        return this.client.state().revision;
    }

    /** A copy of the namespace's state with the changes not yet acknowledged */
    current(): SyncState {
        return copyJson(this.state);
    }

    /** The changes not yet acknowledged */
    waitingCount(): number {
        return this.client.status().waiting;
    }

    /** Queues changes for the statenet, applied to the local copy at once */
    send(changes: readonly LocalChange[]): void {
        if (changes.length === 0) return;
        for (const change of changes) {
            const before = change.op === 'merge' ? this.valueAt(change.path) : undefined;
            const value = isRecord(before) && isRecord(change.value) ? { ...before, ...change.value } : change.value;
            writePath(this.state, change.path, change.op === 'delete' ? undefined : value);
        }
        for (const listener of [...this.listeners]) listener([...changes]);
    }

    private valueAt(path: string): JsonValue | undefined {
        let value: JsonValue | undefined = this.state;
        for (const segment of path.split('.').slice(1)) value = isRecord(value) ? value[segment] : undefined;
        return value;
    }

    /** Waits up to `timeoutMs` for the queued changes to be acknowledged */
    async drain(timeoutMs: number): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (this.waitingCount() > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    }

    stop(): void {
        this.client.stop();
    }
}

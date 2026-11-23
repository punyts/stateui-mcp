import { isDeepStrictEqual } from 'node:util';
import { createSyncClient, randomId } from '@punyts/state-sync';
import type { JsonValue as SyncJson, LocalChange, StoreBridge, SyncClient, SyncRequest, SyncState, SyncTransport } from '@punyts/state-sync';
import { readGrant } from '@punyts/state-sync/authority';
import type { Access, AuthorityConnection, AuthoritySession } from '@punyts/state-sync/authority';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import { applyAt } from './DatasetModels.js';
import { RECORDS_PATH, syncNamespaceOf } from './DatasetNamespaces.js';

/** Opens a session with a namespace's authority, wherever it runs, as `access` */
export type NamespaceConnect = (address: string, connection: AuthorityConnection, access: Access | undefined) => Promise<AuthoritySession>;

/** A record write of a binding: the key's record, undefined to remove it, or the whole map */
export type RecordChange = { readonly key: string; readonly value: JsonValue | undefined } | { readonly whole: JsonObject };

/**
 * A sync transport in the same process: each connection opens a session with `open`, and messages each way are passed
 * on in a later microtask, as a socket would, so neither side runs inside the other's call
 */
export function sessionTransport(open: (connection: AuthorityConnection) => Promise<AuthoritySession>): SyncTransport {
    return {
        connect: (handlers) => {
            let session: AuthoritySession | undefined;
            let closed = false;
            const early: string[] = [];
            const end = (): void => {
                if (closed) return;
                closed = true;
                session?.close();
                queueMicrotask(() => handlers.onClose());
            };
            open({
                send: (text) => queueMicrotask(() => !closed && handlers.onMessage(text)),
                close: end
            }).then(
                (opened) => {
                    if (closed) {
                        opened.close();
                        return;
                    }
                    session = opened;
                    handlers.onOpen();
                    for (const text of early.splice(0)) opened.receive(text);
                },
                () => end()
            );
            return {
                send: (text) => {
                    if (closed) return;
                    if (session === undefined) early.push(text);
                    else {
                        const target = session;
                        queueMicrotask(() => !closed && target.receive(text));
                    }
                },
                close: end
            };
        }
    };
}

/** How long before its grant expires a session reconnects with a fresh access, by default */
export const RENEW_BEFORE_MS = 10 * 60_000;

/** The shortest wait before a renewal, so a grant about to expire does not make the session reconnect in a loop */
const RENEW_MIN_MS = 1_000;

/** The longest wait a timer takes */
const TIMER_MAX_MS = 2 ** 31 - 1;

export interface DatasetSessionOptions {
    readonly address: string;
    /** The person's access, read again on every connection; undefined connects unchecked */
    readonly access: () => Promise<Access | undefined>;
    readonly connect: NamespaceConnect;
    /** How long before the grant expires the session reconnects with a fresh access; default `RENEW_BEFORE_MS` */
    readonly renewBeforeMs?: number;
    /** The records changed: the authority's, or the visible ones after a refusal or a request put them back */
    readonly onRecords: (records: JsonObject) => void;
    readonly onRequests: (requests: readonly SyncRequest[]) => void;
    /** The authority refused a change of this session, with its reason */
    readonly onRejected: (reason: string) => void;
}

/**
 * One instance binding's sync session with a dataset's namespace (docs/design/statenet-requests.md, R3b): a sync
 * client in the server, as the person the instance acts for, so the dataset's authority checks their access. Its
 * visible state is the namespace's records with the binding's own changes on top until they are acked; a change kept
 * as a request is taken out again, and so is a refused one. Each connection reads the access again, and one made with a
 * grant closes before the grant expires, so the client reconnects with a fresh one and sends what was unanswered again
 */
export class DatasetSession {
    private state: SyncState = {};
    private send: ((changes: LocalChange[]) => void) | undefined;
    private readonly client: SyncClient;
    private readonly waiters: Array<() => void> = [];
    private rejected: string | undefined;
    private loaded!: () => void;
    private readonly first = new Promise<void>((resolve) => (this.loaded = resolve));

    constructor(private readonly options: DatasetSessionOptions) {
        const bridge: StoreBridge = {
            load: (state) => {
                this.state = JSON.parse(JSON.stringify(state)) as SyncState;
                this.changed();
                this.loaded();
            },
            write: (path, value) => {
                this.apply(path, value);
                this.changed();
            },
            subscribe: (onChanges) => {
                this.send = onChanges;
                return () => {
                    this.send = undefined;
                };
            }
        };
        this.client = createSyncClient({
            namespace: syncNamespaceOf(options.address),
            bridge,
            transport: sessionTransport((connection) => this.open(connection)),
            onStatus: (report) => {
                if (report.waiting === 0 && report.pending === 0) for (const resolve of this.waiters.splice(0)) resolve();
            },
            onRejected: (rejection) => {
                this.rejected ??= rejection.reason;
                options.onRejected(rejection.reason);
            },
            onRequests: (requests) => options.onRequests(requests)
        });
        this.client.start();
    }

    /** Resolves once the session has the namespace's records, or after `waitMs` without them, or when it closes */
    ready(waitMs: number): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)));
        return Promise.race([this.first, late]).finally(() => clearTimeout(timer));
    }

    /** The records as this session shows them */
    records(): JsonObject {
        const data = this.state['data'];
        const records = isJsonObject(data as JsonValue) ? (data as JsonObject)['records'] : undefined;
        return isJsonObject(records) ? records : {};
    }

    /** Sends the binding's record changes to the dataset; a record as the session already shows it is not sent again */
    write(changes: readonly RecordChange[]): void {
        const local: LocalChange[] = [];
        for (const change of changes) {
            const shown = 'whole' in change ? this.records() : this.records()[change.key];
            if (isDeepStrictEqual(shown, 'whole' in change ? change.whole : change.value)) continue;
            if ('whole' in change) local.push({ id: randomId(), path: RECORDS_PATH, op: 'set', value: change.whole as SyncJson });
            else if (change.value === undefined) local.push({ id: randomId(), path: `${RECORDS_PATH}.${change.key}`, op: 'delete' });
            else local.push({ id: randomId(), path: `${RECORDS_PATH}.${change.key}`, op: 'set', value: change.value as SyncJson });
        }
        if (local.length === 0) return;
        for (const change of local) this.apply(change.path, change.op === 'delete' ? undefined : (change.value as JsonValue));
        this.send?.(local);
    }

    /** The requests this session knows */
    requests(): SyncRequest[] {
        return this.client.requests();
    }

    /** Sends a decision on a request this session knows; false when it does not know it or is offline */
    decide(action: 'approve' | 'reject' | 'withdraw', id: string, note?: string): boolean {
        if (!this.client.requests().some((request) => request.id === id)) return false;
        if (action === 'approve') return this.client.approve(id);
        if (action === 'reject') return this.client.reject(id, note);
        return this.client.withdraw(id);
    }

    /**
     * Resolves once every change sent so far is answered (kept as a request or refused) or applied and saved, with the
     * reason of the first refusal since the last call, or undefined
     */
    async settled(): Promise<string | undefined> {
        const { waiting, pending } = this.client.status();
        if (waiting > 0 || pending > 0) await new Promise<void>((resolve) => this.waiters.push(resolve));
        const reason = this.rejected;
        this.rejected = undefined;
        return reason;
    }

    close(): void {
        this.client.stop();
        this.loaded();
        for (const resolve of this.waiters.splice(0)) resolve();
    }

    /** Connects with the access as it is now, and closes the connection before its grant expires */
    private async open(connection: AuthorityConnection): Promise<AuthoritySession> {
        const access = await this.options.access();
        const session = await this.options.connect(this.options.address, connection, access);
        const expires = access?.grant === undefined ? undefined : readGrant(access.grant)?.expires;
        if (expires === undefined || !Number.isFinite(expires)) return session;
        const wait = Math.min(TIMER_MAX_MS, Math.max(RENEW_MIN_MS, expires - Date.now() - (this.options.renewBeforeMs ?? RENEW_BEFORE_MS)));
        const timer = setTimeout(() => connection.close(), wait);
        timer.unref?.();
        return {
            receive: (text) => session.receive(text),
            close: () => {
                clearTimeout(timer);
                session.close();
            }
        };
    }

    private apply(path: string, value: JsonValue | undefined): void {
        const next = applyAt(this.state as JsonObject, path.slice(2).split('.'), value === undefined ? 'delete' : 'set', value);
        this.state = (isJsonObject(next) ? next : {}) as SyncState;
    }

    private changed(): void {
        this.options.onRecords(this.records());
    }
}

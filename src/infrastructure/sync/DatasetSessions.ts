import type { SyncRequest } from '@punyts/state-sync';
import type { Access } from '@punyts/state-sync/authority';
import type { JsonObject } from '../../domain/JsonValue.js';
import { DatasetSession, type NamespaceConnect } from './DatasetSession.js';

/** How long a page waits for a dataset's records, and for the answer to a decision */
export const ANSWER_MS = 5_000;

/** A dataset's records and the pending requests someone may decide */
export interface DatasetRequestList {
    readonly records: JsonObject;
    readonly requests: readonly SyncRequest[];
}

/** What follows a dataset's records: called with the records now and after every change */
export type DatasetRecordsListener = (records: JsonObject) => void;

/**
 * Sessions with the owner's datasets as a given access, here or through the placement, wherever the dataset's
 * namespace is held (docs/design/statenet-requests.md): `follow` keeps one open and passes the records on as they
 * change, for a read that must see every write; `list` and `decide` open one for a page where a person decides
 * requests (R3c) and close it after. The authority lists only the requests the access may decide, and decides as it
 * would for any session
 */
export class DatasetSessions {
    constructor(
        private readonly addressOf: (dataset: string) => string,
        private readonly exists: (dataset: string) => Promise<boolean>,
        private readonly connect: NamespaceConnect,
        private readonly waitMs = ANSWER_MS
    ) {}

    /**
     * Follows a dataset's records as `access` (read again on every connection): the listener gets them once the
     * session has them and after every change, until `close`. Undefined when there is no such dataset
     */
    async follow(dataset: string, access: () => Promise<Access | undefined>, listener: DatasetRecordsListener): Promise<{ close(): void } | undefined> {
        if (!(await this.exists(dataset))) return undefined;
        let loaded = false;
        let closed = false;
        const session = new DatasetSession({
            address: this.addressOf(dataset),
            access,
            connect: this.connect,
            onRecords: (records) => {
                if (loaded && !closed) listener(records);
            },
            onRequests: () => undefined,
            onRejected: () => undefined
        });
        // the first records come from the authority's welcome, not the session's empty start
        void session.ready(2 ** 31 - 1).then(() => {
            if (closed) return;
            loaded = true;
            listener(session.records());
        });
        return {
            close: () => {
                closed = true;
                session.close();
            }
        };
    }

    /** The dataset's records and the pending requests `access` may decide; undefined when there is no such dataset */
    async list(dataset: string, access: Access): Promise<DatasetRequestList | undefined> {
        if (!(await this.exists(dataset))) return undefined;
        const session = this.open(dataset, access, () => undefined);
        try {
            await session.ready(this.waitMs);
            return { records: session.records(), requests: session.requests().filter((request) => !request.mine && request.status === 'pending') };
        } finally {
            session.close();
        }
    }

    /**
     * Approves or rejects a request as `access` and resolves with the request as decided (an approval the dataset's
     * logic refused ends rejected with its code); undefined when the dataset or the request is not there for this
     * access, or no answer came in time
     */
    async decide(dataset: string, access: Access, action: 'approve' | 'reject', id: string, note?: string): Promise<SyncRequest | undefined> {
        if (!(await this.exists(dataset))) return undefined;
        let answered!: (request: SyncRequest) => void;
        const answer = new Promise<SyncRequest>((resolve) => (answered = resolve));
        const session = this.open(dataset, access, (requests) => {
            const found = requests.find((request) => request.id === id);
            if (found !== undefined && found.status !== 'pending') answered(found);
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await session.ready(this.waitMs);
            const known = session.requests().find((request) => request.id === id);
            if (known === undefined) return undefined;
            if (known.status !== 'pending') return known;
            if (!session.decide(action, id, note)) return undefined;
            const late = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), this.waitMs)));
            return await Promise.race([answer, late]);
        } finally {
            clearTimeout(timer);
            session.close();
        }
    }

    private open(dataset: string, access: Access, onRequests: (requests: readonly SyncRequest[]) => void): DatasetSession {
        return new DatasetSession({
            address: this.addressOf(dataset),
            access: async () => access,
            connect: this.connect,
            onRecords: () => undefined,
            onRequests,
            onRejected: () => undefined
        });
    }
}

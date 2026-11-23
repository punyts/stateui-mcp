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

/**
 * The requests of the owner's datasets, for a page where a person decides them (docs/design/statenet-requests.md, R3c):
 * each call opens a session with the dataset's authority as that person, here or through the placement, and closes it
 * after. The authority lists only the requests the access may decide, and decides as it would for any session
 */
export class DatasetRequests {
    constructor(
        private readonly addressOf: (dataset: string) => string,
        private readonly exists: (dataset: string) => Promise<boolean>,
        private readonly connect: NamespaceConnect,
        private readonly waitMs = ANSWER_MS
    ) {}

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

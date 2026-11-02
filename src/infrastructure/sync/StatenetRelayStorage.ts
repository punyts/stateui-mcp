import { randomUUID } from 'node:crypto';
import { copyJson } from '@punyts/state-sync';
import type { JsonValue, LocalChange, SyncState } from '@punyts/state-sync';
import { decryptServerBranch } from '@punyts/state-sync/authority';
import type { NamespaceStorage, StoredNamespace } from '@punyts/state-sync/authority';
import { StatenetClient } from './statenetClient.js';

/** The key of `$.server` in a stored state, which the authority hands over encrypted */
const SERVER_KEY = 'server';
/**
 * Where the encrypted `$.server` lives in the statenet. The statenet, like every authority, refuses client changes to
 * `$.server`, and it cannot read the ciphertext anyway, so the relay keeps it under its own top-level key
 */
export const SEALED_KEY = 'sealed';
/** How long `close` waits for the relayed changes to be acknowledged */
const DRAIN_MS = 3000;

interface Relay {
    readonly client: StatenetClient;
    /** The authority revision the statenet has every change up to */
    authorityRevision: number;
    /** What the statenet holds, as the relay last sent it, with `$.server` sealed */
    relayed: SyncState;
    /**
     * Whether the statenet holds the state the authority's log starts from. Not after an empty namespace was loaded:
     * the authority then starts from its initial state, which no log entry carries
     */
    based: boolean;
}

const isRecord = (value: unknown): value is Record<string, JsonValue> => typeof value === 'object' && value !== null && !Array.isArray(value);

function deepEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The storage of the app authorities when a statenet is configured: each app's namespace is loaded from the statenet
 * and every save relays what changed to it. A save sends the authority's logged changes in order, with their ids, so
 * the statenet numbers them as the authority did; when the log does not cover what changed (the first save into an empty namespace, a gap) it
 * sends each changed top-level branch whole. `$.server` arrives encrypted from the authority and goes to the statenet
 * as `$.sealed`; it is compared decrypted, since every save encrypts with a fresh nonce
 */
export class StatenetRelayStorage implements NamespaceStorage {
    private readonly relays = new Map<string, Relay>();

    constructor(
        private readonly url: string,
        private readonly serverKey: Uint8Array | undefined
    ) {}

    async load(namespace: string): Promise<StoredNamespace | undefined> {
        this.relays.get(namespace)?.client.stop();
        const client = new StatenetClient(this.url, namespace);
        try {
            await client.ready();
        } catch (error) {
            client.stop();
            throw error;
        }
        const revision = client.revision();
        const relayed = client.current();
        this.relays.set(namespace, { client, authorityRevision: revision, relayed, based: revision > 0 });
        if (revision === 0) return undefined;
        const { [SEALED_KEY]: sealed, ...state } = relayed;
        return {
            state: sealed === undefined ? state : { ...state, [SERVER_KEY]: sealed },
            revision,
            log: [],
            applied: []
        };
    }

    async save(namespace: string, stored: StoredNamespace): Promise<void> {
        const relay = this.relays.get(namespace);
        if (relay === undefined) throw new Error(`${namespace} was saved before it was loaded`);
        const { [SERVER_KEY]: server, ...rest } = stored.state;
        const outgoing: SyncState = server === undefined ? rest : { ...rest, [SEALED_KEY]: server };

        const entries = stored.log.filter((change) => change.revision > relay.authorityRevision);
        const covered =
            relay.based &&
            entries.length === stored.revision - relay.authorityRevision &&
            entries.every((change, index) => change.revision === relay.authorityRevision + index + 1) &&
            (entries.length > 0 || deepEqual(withoutSealed(outgoing), withoutSealed(relay.relayed)));
        const changes: LocalChange[] = covered
            ? entries.map((change) => ({ id: change.id, path: change.path, op: change.op, ...(change.value !== undefined && { value: change.value }) }))
            : branchChanges(withoutSealed(relay.relayed), withoutSealed(outgoing));
        if (!this.sameServer(namespace, relay.relayed[SEALED_KEY], outgoing[SEALED_KEY])) {
            const sealed = outgoing[SEALED_KEY];
            changes.push(sealed === undefined ? { id: randomUUID(), path: `$.${SEALED_KEY}`, op: 'delete' } : { id: randomUUID(), path: `$.${SEALED_KEY}`, op: 'set', value: sealed });
        }

        relay.client.send(changes);
        relay.authorityRevision = stored.revision;
        relay.based = true;
        relay.relayed = copyJson(outgoing);
    }

    /** Stops relaying a namespace, after its changes are acknowledged or `DRAIN_MS` passed */
    async forget(namespace: string): Promise<void> {
        const relay = this.relays.get(namespace);
        if (relay === undefined) return;
        this.relays.delete(namespace);
        await relay.client.drain(DRAIN_MS);
        relay.client.stop();
    }

    async close(): Promise<void> {
        await Promise.all([...this.relays.keys()].map((namespace) => this.forget(namespace)));
    }

    private sameServer(namespace: string, before: JsonValue | undefined, after: JsonValue | undefined): boolean {
        if (deepEqual(before, after)) return true;
        if (!isRecord(before) || !isRecord(after) || this.serverKey === undefined) return false;
        try {
            return deepEqual(decryptServerBranch(before, this.serverKey, namespace), decryptServerBranch(after, this.serverKey, namespace));
        } catch {
            return false;
        }
    }
}

function withoutSealed(state: SyncState): SyncState {
    const { [SEALED_KEY]: _sealed, ...rest } = state;
    return rest;
}

/** A whole-branch write for each top-level branch that differs, and a delete for each one that is gone */
function branchChanges(before: SyncState, after: SyncState): LocalChange[] {
    const changes: LocalChange[] = [];
    for (const key of Object.keys(before)) {
        if (!(key in after)) changes.push({ id: randomUUID(), path: `$.${key}`, op: 'delete' });
    }
    for (const [key, value] of Object.entries(after)) {
        if (!deepEqual(before[key], value)) changes.push({ id: randomUUID(), path: `$.${key}`, op: 'set', value });
    }
    return changes;
}

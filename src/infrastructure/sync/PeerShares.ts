import { peersPath } from '@punyts/stateui-app/core';
import type { PeerShare } from '@punyts/stateui-app/core';
import type { JsonValue as SyncValue } from '@punyts/state-sync';
import type { Authority, ServerWrite } from '@punyts/state-sync/authority';
import type { JsonValue } from '../../domain/JsonValue.js';
import type { UiDocument } from '../../domain/UiApp.js';

/** Where an instance holds what its peers have: written here only, never by a client, never stored */
const PEERS_ROOT = '$.peers';

/** One running instance of an app, as its peers see it */
interface Member {
    readonly person: string;
    readonly authority: Authority;
    readonly shares: readonly PeerShare[];
}

/** The `@share` branches of an assembled document (`share`) */
export function sharesOf(document: UiDocument): PeerShare[] {
    const share = (document as { share?: unknown }).share;
    if (!Array.isArray(share)) return [];
    return share.filter((entry): entry is PeerShare => typeof entry === 'object' && entry !== null && typeof (entry as PeerShare).path === 'string' && typeof (entry as PeerShare).by === 'string');
}

/** True when a path is at, below or above another */
function touches(path: string, other: string): boolean {
    return path === other || path.startsWith(`${other}.`) || other.startsWith(`${path}.`);
}

/** The key a person goes by in a peers map: their id, with `o` before one that is integer-like (ordered maps refuse those) */
function peerKey(person: string): string {
    return /^[0-9]+$/.test(person) ? `o${person}` : person;
}

function sameJson(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Peers' state (docs/design/state-definitions-and-instances.md, "Seeing other people's app state"). The running
 * instances of one app form a group; for each branch the definition shares (`@share`, `{ path, by }`), an instance's
 * peers are the other instances whose value at `by` is the same as its own and not empty (the same board open). Each
 * instance's `$.peers.<path>` (`peersPath`) holds `{ <person>: <their value at path> }` for its peers, rewritten as
 * server writes whenever a member's shared branch or `by` value changes, a member joins or a member leaves. `$.peers`
 * is ephemeral (assembly lists it) and a client's write under it is refused.
 *
 * Peers are the instances running on this server: an instance on another server of a placement is not seen. Every
 * person running the app reads the shared data it binds, so a peer may read the data its `by` names
 */
export class PeerShares {
    /** By group (the owner and app, `<ownerId>/<appId>`), by namespace */
    private readonly groups = new Map<string, Map<string, Member>>();
    /** The groups whose peers are rewritten at the next microtask: never from inside an authority's own listener */
    private readonly pending = new Set<string>();

    /** Adds a running instance to its app's group; returns the function that takes it out */
    join(group: string, namespace: string, person: string, authority: Authority, document: UiDocument): () => void {
        const shares = sharesOf(document);
        if (shares.length === 0) return () => undefined;
        const members = this.groups.get(group) ?? new Map<string, Member>();
        this.groups.set(group, members);
        members.set(namespace, { person, authority, shares });
        const refusing = authority.onChange(PEERS_ROOT, (context) =>
            context.change.path === PEERS_ROOT || context.change.path.startsWith(`${PEERS_ROOT}.`) ? { result: 'reject', reason: '$.peers is written by the server' } : undefined
        );
        const watched = shares.flatMap((share) => [share.path, share.by]);
        const listening = authority.onChanges((changes) => {
            if (changes.some((change) => !touches(change.path, PEERS_ROOT) && watched.some((path) => touches(change.path, path)))) this.schedule(group);
        });
        this.schedule(group);
        return () => {
            refusing();
            listening();
            if (members.get(namespace)?.authority !== authority) return;
            members.delete(namespace);
            if (members.size === 0) this.groups.delete(group);
            else this.schedule(group);
        };
    }

    /** Resolves once the peers scheduled so far are written */
    settled(): Promise<void> {
        return new Promise((resolve) => queueMicrotask(resolve));
    }

    private schedule(group: string): void {
        if (this.pending.has(group)) return;
        this.pending.add(group);
        queueMicrotask(() => {
            this.pending.delete(group);
            this.update(group);
        });
    }

    /** Rewrites the peers of every member of a group whose peers changed */
    private update(group: string): void {
        const members = [...(this.groups.get(group)?.values() ?? [])];
        for (const member of members) {
            const writes: ServerWrite[] = [];
            for (const share of member.shares) {
                const by = member.authority.get(share.by) as JsonValue | undefined;
                const peers: Record<string, JsonValue> = {};
                if (by !== undefined && by !== null) {
                    for (const other of members) {
                        if (other === member || other.person === member.person) continue;
                        if (!other.shares.some((theirs) => theirs.path === share.path && theirs.by === share.by)) continue;
                        if (!sameJson(other.authority.get(share.by) as JsonValue | undefined, by)) continue;
                        peers[peerKey(other.person)] = (other.authority.get(share.path) as JsonValue | undefined) ?? null;
                    }
                }
                const path = peersPath(share.path);
                if (!sameJson(member.authority.get(path) as JsonValue | undefined, peers)) writes.push({ path, op: 'set', value: peers as SyncValue });
            }
            if (writes.length > 0) member.authority.writeAll(writes);
        }
    }
}

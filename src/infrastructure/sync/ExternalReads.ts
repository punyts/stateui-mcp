import type { RevisedChange, JsonValue as SyncJson } from '@punyts/state-sync';
import type { Authority, RelaySubscription, ServerWrite, Upstream } from '@punyts/state-sync/authority';
import type { InstanceKey } from '../../domain/InstanceKey.js';
import { instanceKeyText } from '../../domain/InstanceKey.js';
import { userStateAddress } from '../../domain/StateAddress.js';
import type { OwnerNames } from '../../domain/StateAddress.js';

/** Where an instance shows what it reads of other apps, read only */
export const EXTERNAL_PATH = '$.external';

/** Another app's state, the person's own, under a path */
export interface ExternalAppUse {
    readonly app: string;
    readonly path: string;
}

/** A dataset another owner shared with this one: the owner's workspace id and the dataset's name */
export interface ExternalDataUse {
    readonly owner: string;
    readonly dataset: string;
}

/** What an app's document says it reads: alias to another app's state, or to another owner's shared dataset */
export type ExternalUses = Readonly<Record<string, ExternalAppUse | ExternalDataUse>>;

/** What a read of a shared dataset hears: its records now and after each change, and when the read ended */
export interface SharedDataListener {
    records(records: Readonly<Record<string, unknown>>): void;
    /** The share was revoked, ran out or was never made: the alias is cleared and nothing more comes */
    ended(reason: string): void;
}

/**
 * Datasets other owners shared with this owner (the server's, such as Magnetic's grants): `open` checks the share and
 * follows the dataset until `close`
 */
export interface SharedData {
    open(owner: string, dataset: string, listener: SharedDataListener): { close(): void };
}

const isDataUse = (use: ExternalAppUse | ExternalDataUse): use is ExternalDataUse => 'dataset' in use;

/** Gives writes to a running instance as if they came from outside: applied, then looked up by its logic */
export type InstanceReceive = (key: InstanceKey, authority: Authority, writes: readonly ServerWrite[]) => void;

export interface ExternalReadsOptions {
    /** The names owners go by in addresses; their ids by default */
    readonly owners?: OwnerNames;
    /** Where another owner's shared datasets are read; without it, an alias naming one reads nothing */
    readonly sharedData?: SharedData;
    /** How often each subscription's lease is renewed; 10 seconds by default (a third of the relay's default lease) */
    readonly renewEveryMs?: number;
    readonly report?: (message: string, fields: Record<string, string>) => void;
}

interface Attached {
    readonly subscriptions: RelaySubscription[];
    readonly reads: { close(): void }[];
    readonly removers: (() => void)[];
    timer?: ReturnType<typeof setInterval>;
}

/** A change under the subscribed path as a write under the alias: `$.data.notes.n1` read at `$.data.notes` as `notes` is `$.external.notes.n1` */
function toWrite(alias: string, path: string, change: RevisedChange): ServerWrite {
    const at = `${EXTERNAL_PATH}.${alias}${change.path.slice(path.length)}`;
    return change.op === 'delete' ? { path: at, op: 'delete' } : { path: at, op: change.op, value: change.value as SyncJson };
}

/**
 * Logic that reads another app's paths (docs/design/statenet-relays.md, S3). For each alias of an app's
 * `uses.external`, the running instance subscribes through the relay to the person's own state of the other app
 * (`<owner>/apps/<appId>`) under the path, and what it reads is written into the instance at `$.external.<alias>`,
 * so the instance's logic runs on it as on any change. `$.external` is read only (a client's write there is refused)
 * and ephemeral (never stored: the subscription gives it again when the instance starts). The leases are renewed while
 * the instance runs, and the subscriptions closed when it stops.
 *
 * An alias may instead name a dataset another owner shared with this one (`{ owner, dataset }`): its records are read
 * through `sharedData`, written whole at `$.external.<alias>` on each change, and cleared when the share ends
 */
export class ExternalReads {
    private readonly attached = new Map<string, Attached>();

    constructor(
        private readonly relay: Upstream,
        private readonly receive: InstanceReceive,
        private readonly options: ExternalReadsOptions = {}
    ) {}

    attach(key: InstanceKey, authority: Authority, external: ExternalUses | undefined): void {
        this.detach(key);
        const all = Object.entries(external ?? {});
        const datasets = all.filter((entry): entry is [string, ExternalDataUse] => isDataUse(entry[1]));
        const uses = all.filter((entry): entry is [string, ExternalAppUse] => !isDataUse(entry[1]) && entry[1].app.toLowerCase() !== key.appId.toLowerCase());
        if (uses.length === 0 && datasets.length === 0) return;
        const attached: Attached = { subscriptions: [], reads: [], removers: [] };
        const text = instanceKeyText(key);
        this.attached.set(text, attached);
        attached.removers.push(authority.onChange(EXTERNAL_PATH, () => ({ result: 'reject', reason: `${EXTERNAL_PATH} is read only: it shows what the app reads of other apps and owners` })));
        for (const [alias, use] of datasets) {
            const shared = this.options.sharedData;
            if (shared === undefined) {
                this.options.report?.('A shared dataset cannot be read here', { app: key.appId, alias });
                continue;
            }
            const at = `${EXTERNAL_PATH}.${alias}`;
            // Nothing reaches an instance after it stopped, even from a read that answers late
            const live = (): boolean => this.attached.get(text) === attached;
            attached.reads.push(
                shared.open(use.owner, use.dataset, {
                    records: (records) => {
                        if (live()) this.receive(key, authority, [{ path: at, op: 'set', value: records as SyncJson }]);
                    },
                    ended: (reason) => {
                        if (live()) this.receive(key, authority, [{ path: at, op: 'delete' }]);
                        this.options.report?.('A shared dataset read ended', { app: key.appId, alias, reason });
                    }
                })
            );
        }
        for (const [alias, use] of uses) {
            const address = userStateAddress(key.ownerId, key.persona, use.app, this.options.owners);
            attached.subscriptions.push(
                this.relay.subscribe(address, use.path, undefined, {
                    welcome: (welcome) => {
                        const writes = 'value' in welcome ? [{ path: `${EXTERNAL_PATH}.${alias}`, op: 'set' as const, value: (welcome.value ?? null) as SyncJson }] : welcome.changes.map((change) => toWrite(alias, use.path, change));
                        if (writes.length > 0) this.receive(key, authority, writes);
                    },
                    changes: (batch) => this.receive(key, authority, batch.changes.map((change) => toWrite(alias, use.path, change))),
                    closed: (reason) => this.options.report?.('An external read ended', { app: key.appId, alias, reason })
                })
            );
        }
        if (attached.subscriptions.length === 0) return;
        attached.timer = setInterval(() => {
            for (const subscription of attached.subscriptions) subscription.renew();
        }, this.options.renewEveryMs ?? 10_000);
        attached.timer.unref?.();
    }

    /** Stops every read, of every instance: the server is closing */
    detachAll(): void {
        for (const text of [...this.attached.keys()]) this.detachText(text);
    }

    detach(key: InstanceKey): void {
        this.detachText(instanceKeyText(key));
    }

    private detachText(text: string): void {
        const attached = this.attached.get(text);
        if (attached === undefined) return;
        this.attached.delete(text);
        if (attached.timer !== undefined) clearInterval(attached.timer);
        for (const subscription of attached.subscriptions) subscription.close();
        for (const read of attached.reads) read.close();
        for (const remove of attached.removers) remove();
    }
}

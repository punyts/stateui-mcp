import type { RevisedChange, JsonValue as SyncJson } from '@punyts/state-sync';
import type { Authority, RelaySubscription, ServerWrite, Upstream } from '@punyts/state-sync/authority';
import type { InstanceKey } from '../../domain/InstanceKey.js';
import { instanceKeyText } from '../../domain/InstanceKey.js';
import { userStateAddress } from '../../domain/StateAddress.js';

/** Where an instance shows what it reads of other apps, read only */
export const EXTERNAL_PATH = '$.external';

/** What an app's document says it reads: alias to another app's id and the path under which it reads */
export type ExternalUses = Readonly<Record<string, { readonly app: string; readonly path: string }>>;

/** Gives writes to a running instance as if they came from outside: applied, then looked up by its logic */
export type InstanceReceive = (key: InstanceKey, authority: Authority, writes: readonly ServerWrite[]) => void;

export interface ExternalReadsOptions {
    /** How often each subscription's lease is renewed; 10 seconds by default (a third of the relay's default lease) */
    readonly renewEveryMs?: number;
    readonly report?: (message: string, fields: Record<string, string>) => void;
}

interface Attached {
    readonly subscriptions: RelaySubscription[];
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
 * (`<persona>/<appId>/user`) under the path, and what it reads is written into the instance at `$.external.<alias>`,
 * so the instance's logic runs on it as on any change. `$.external` is read only (a client's write there is refused)
 * and ephemeral (never stored: the subscription gives it again when the instance starts). The leases are renewed while
 * the instance runs, and the subscriptions closed when it stops
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
        const uses = Object.entries(external ?? {}).filter(([, use]) => use.app.toLowerCase() !== key.appId.toLowerCase());
        if (uses.length === 0) return;
        const attached: Attached = { subscriptions: [], removers: [] };
        this.attached.set(instanceKeyText(key), attached);
        attached.removers.push(authority.onChange(EXTERNAL_PATH, () => ({ result: 'reject', reason: `${EXTERNAL_PATH} is read only: it shows what the app reads of other apps` })));
        for (const [alias, use] of uses) {
            const address = userStateAddress(key.ownerId, key.persona, use.app);
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
        attached.timer = setInterval(() => {
            for (const subscription of attached.subscriptions) subscription.renew();
        }, this.options.renewEveryMs ?? 10_000);
        attached.timer.unref?.();
    }

    detach(key: InstanceKey): void {
        const text = instanceKeyText(key);
        const attached = this.attached.get(text);
        if (attached === undefined) return;
        this.attached.delete(text);
        if (attached.timer !== undefined) clearInterval(attached.timer);
        for (const subscription of attached.subscriptions) subscription.close();
        for (const remove of attached.removers) remove();
    }
}

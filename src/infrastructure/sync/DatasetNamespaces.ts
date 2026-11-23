import { createAuthority } from '@punyts/state-sync/authority';
import type { Authority, GrantContext, RequestOptions, ServerWrite, StoredNamespace } from '@punyts/state-sync/authority';
import type { InstancePlacement } from '../../application/ports/InstancePlacement.js';
import { datasetOfAddress, datasetStateAddress, OWNER_IDS } from '../../domain/StateAddress.js';
import type { OwnerNames } from '../../domain/StateAddress.js';
import type { JsonValue } from '../../domain/JsonValue.js';
import type { InstanceNamespaceStore } from '../storage/NamespaceUiInstanceRepository.js';
import { recordsReason } from './DatasetModels.js';
import type { DatasetModels } from './DatasetModels.js';

/** Where a dataset's namespace holds its records: `$.data.records.<key>` */
export const RECORDS_PATH = '$.data.records';

/** The sync namespace of a dataset's authority, its address with dots (`<owner>.data.<dataset>`), as a hello names it */
export function syncNamespaceOf(address: string): string {
    return address.replaceAll('/', '.');
}

/** A dataset's namespace as stored when it is made outside a running authority (an import): `records` at revision 1 */
export function seededDataset(records: object): StoredNamespace {
    return { state: { data: { records } } as StoredNamespace['state'], revision: 1, log: [], applied: [] };
}

export interface DatasetNamespacesOptions {
    readonly owners?: OwnerNames;
    readonly placement?: InstancePlacement;
    /** The models records are checked with, by the authority's change handler, whoever writes */
    readonly models?: DatasetModels;
    /**
     * Checks each session's access (docs/design/statenet-requests.md, R3b): the grants' keys, the clock and revocations.
     * Without it sessions are not checked
     */
    readonly context?: () => GrantContext;
    /** Requests of sessions that may request and not write, with `context` */
    readonly requests?: RequestOptions;
}

/**
 * The namespaces of an owner's datasets (docs/design/statenet-requests.md, "how R3a is built"): one authority per
 * dataset at `<owner>/data/<dataset>`, made when it is first needed, saving through the owner's namespace store. With
 * a placement (several servers on one database) a dataset's authority runs only on the server that owns its address:
 * `authority` claims it first, as the tools claim an instance, and the owner node starts and releases it by address
 * (`hosted`, `release`). Each authority checks records against the dataset's model, and, given a context, each
 * session's access (R3b)
 */
export class DatasetNamespaces {
    /** By address */
    private readonly authorities = new Map<string, Promise<Authority>>();
    private closed = false;

    private readonly owners: OwnerNames;
    private readonly placement: InstancePlacement | undefined;

    constructor(
        private readonly store: InstanceNamespaceStore,
        private readonly ownerId: string,
        private readonly options: DatasetNamespacesOptions = {}
    ) {
        this.owners = options.owners ?? OWNER_IDS;
        this.placement = options.placement;
    }

    /** The address of a dataset of this owner */
    address(name: string): string {
        return datasetStateAddress(this.ownerId, name, this.owners);
    }

    /** The dataset an address of this owner names, or undefined */
    datasetAt(address: string): string | undefined {
        return datasetOfAddress(address, this.ownerId, this.owners);
    }

    /** The dataset's authority, here: with a placement this server claims its namespace first */
    async authority(name: string): Promise<Authority> {
        const address = this.address(name);
        if (this.placement !== undefined && !(await this.placement.claim(address, this.ownerId))) throw new Error('The dataset is busy on another server; try again');
        return this.opened(address);
    }

    /** The authority of a dataset at an address of this owner, for the owner node when this server takes the namespace */
    hosted(address: string): Promise<Authority | undefined> {
        return this.datasetAt(address) === undefined ? Promise.resolve(undefined) : this.opened(address);
    }

    /** The owner node let a dataset's namespace go: its authority closes here once its saves are done */
    async release(address: string): Promise<void> {
        const authority = this.authorities.get(address);
        if (authority === undefined) return;
        this.authorities.delete(address);
        await this.closeOne(authority);
    }

    /** Removes a dataset's namespace whole: its authority closes and its stored state is removed */
    async remove(name: string): Promise<void> {
        const address = this.address(name);
        await this.authority(name);
        await this.release(address);
        await this.store.remove(address, this.epochOf(address));
    }

    /**
     * Moves a dataset's namespace to the address of its new name, one revision up and without its log (its clients
     * start again from a snapshot); the old namespace is removed
     */
    async move(from: string, to: string): Promise<void> {
        const [source, target] = [this.address(from), this.address(to)];
        await this.authority(from);
        await this.authority(to);
        await this.release(source);
        await this.release(target);
        const stored = (await this.store.load(source)) ?? seededDataset({});
        await this.store.save(target, { ...stored, revision: stored.revision + 1, log: [] }, this.epochOf(target));
        await this.store.remove(source, this.epochOf(source));
    }

    /** Closes every dataset's authority once its saves are done */
    async close(): Promise<void> {
        this.closed = true;
        const open = [...this.authorities.values()];
        this.authorities.clear();
        await Promise.all(open.map((authority) => this.closeOne(authority)));
    }

    private async closeOne(opening: Promise<Authority>): Promise<void> {
        const authority = await opening.catch(() => undefined);
        if (authority === undefined) return;
        await authority.flush().catch(() => undefined);
        authority.close();
    }

    /** The epoch this server saves an address under: the placement's, or 0 where nothing orders namespaces */
    private epochOf(address: string): number {
        return this.placement?.epochOf(address) ?? 0;
    }

    private opened(address: string): Promise<Authority> {
        let authority = this.authorities.get(address);
        if (authority === undefined) {
            if (this.closed) return Promise.reject(new Error('The datasets are closed'));
            if (this.placement !== undefined && this.placement.epochOf(address) === undefined) return Promise.reject(new Error('The dataset runs on another server'));
            const epoch = this.epochOf(address);
            const name = this.datasetAt(address) ?? '';
            const { models, context, requests } = this.options;
            authority = (async () => {
                await models?.load(name);
                const made = await createAuthority({
                    namespace: syncNamespaceOf(address),
                    createParents: true,
                    storage: { load: () => this.store.load(address), save: (_namespace, stored) => this.store.save(address, stored, epoch) },
                    ...(context === undefined ? {} : { access: { address, context }, ...(requests === undefined ? {} : { requests }) })
                });
                made.onChange(RECORDS_PATH, ({ change, get }) => {
                    const reason = recordsReason(models?.fields(name), name, RECORDS_PATH, (path) => get(path) as JsonValue | undefined, [change as ServerWrite]);
                    return reason === undefined ? undefined : { result: 'reject', reason };
                });
                return made;
            })();
            const made = authority;
            made.catch(() => {
                if (this.authorities.get(address) === made) this.authorities.delete(address);
            });
            this.authorities.set(address, made);
        }
        return authority;
    }
}

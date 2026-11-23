import { createAuthority } from '@punyts/state-sync/authority';
import type { Authority, StoredNamespace } from '@punyts/state-sync/authority';
import type { InstancePlacement } from '../../application/ports/InstancePlacement.js';
import { datasetOfAddress, datasetStateAddress, OWNER_IDS } from '../../domain/StateAddress.js';
import type { OwnerNames } from '../../domain/StateAddress.js';
import type { InstanceNamespaceStore } from '../storage/NamespaceUiInstanceRepository.js';

/** Where a dataset's namespace holds its records: `$.data.records.<key>` */
export const RECORDS_PATH = '$.data.records';

/** A dataset's namespace as stored when it is made outside a running authority (an import): `records` at revision 1 */
export function seededDataset(records: object): StoredNamespace {
    return { state: { data: { records } } as StoredNamespace['state'], revision: 1, log: [], applied: [] };
}

/**
 * The namespaces of an owner's datasets (docs/design/statenet-requests.md, "how R3a is built"): one authority per
 * dataset at `<owner>/data/<dataset>`, made when it is first needed, saving through the owner's namespace store. With
 * a placement (several servers on one database) a dataset's authority runs only on the server that owns its address:
 * `authority` claims it first, as the tools claim an instance, and the owner node starts and releases it by address
 * (`hosted`, `release`)
 */
export class DatasetNamespaces {
    /** By address */
    private readonly authorities = new Map<string, Promise<Authority>>();
    private closed = false;

    constructor(
        private readonly store: InstanceNamespaceStore,
        private readonly ownerId: string,
        private readonly owners: OwnerNames = OWNER_IDS,
        private readonly placement?: InstancePlacement
    ) {}

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
            authority = createAuthority({
                namespace: address,
                createParents: true,
                storage: { load: () => this.store.load(address), save: (_namespace, stored) => this.store.save(address, stored, epoch) }
            });
            const made = authority;
            made.catch(() => {
                if (this.authorities.get(address) === made) this.authorities.delete(address);
            });
            this.authorities.set(address, made);
        }
        return authority;
    }
}

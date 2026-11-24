import { diffInstance } from '@punyts/stateui-app/core';
import type { EpochStorage, StoredNamespace } from '@punyts/state-sync/authority';
import type { InstanceDiff, InstanceRead, InstanceWriteFence, PersonDataset, UiInstanceRepository, WholeInstance } from '../../application/ports/UiInstanceRepository.js';
import { isAppId } from './PartFolders.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject } from '../../domain/JsonValue.js';

/** Where instances are kept as stored namespaces: an epoch storage (an aggregate's, or the node's way to one) that can also forget one */
export interface InstanceNamespaceStore extends EpochStorage {
    /** Removes a namespace whole: its state, its log and its head; under `epoch`, where the store fences */
    remove(address: string, epoch?: number): Promise<void>;
}

type DiffInput = Parameters<typeof diffInstance>[0];

/** Where a diff's own `data` is kept (data that no binding holds), as `data` holds the person records */
const LOCAL_DATA = 'localData';
/** Where each person binding's model is kept, by binding */
const MODELS = 'models';

const EMPTY: WholeInstance = { diff: {}, datasets: {}, applied: [], revision: 0 };

/** A stored namespace's state as the instance it holds */
function instanceOf(stored: StoredNamespace | undefined): WholeInstance {
    if (stored === undefined) return EMPTY;
    const { data, [MODELS]: models, [LOCAL_DATA]: local, ...rest } = stored.state as JsonObject;
    const datasets: Record<string, PersonDataset> = {};
    if (isJsonObject(data) && isJsonObject(models)) {
        for (const [binding, records] of Object.entries(data)) {
            const model = models[binding];
            if (typeof model === 'string' && isJsonObject(records)) datasets[binding] = { model, records };
        }
    }
    return { diff: local === undefined ? rest : { ...rest, data: local }, datasets, applied: stored.applied, revision: stored.revision };
}

/** The state a stored namespace keeps for an instance: its diff, its own unbound data, its person records and their models */
function stateOf(diff: InstanceDiff, datasets: Readonly<Record<string, PersonDataset>>): StoredNamespace['state'] {
    const { data: local, ...rest } = diff;
    const bindings = Object.keys(datasets);
    return {
        ...rest,
        ...(local === undefined ? {} : { [LOCAL_DATA]: local }),
        ...(bindings.length === 0
            ? {}
            : {
                  data: Object.fromEntries(bindings.map((binding) => [binding, (datasets[binding] as PersonDataset).records])),
                  [MODELS]: Object.fromEntries(bindings.map((binding) => [binding, (datasets[binding] as PersonDataset).model]))
              })
    } as StoredNamespace['state'];
}

/**
 * One person's instances kept as stored namespaces (docs/design/statenet-network.md, "An instance is a stored
 * namespace"): each app's at its statenet address, whole. Its state is the instance's diff over the app's definition
 * (a key each), its own unbound `data` as `localData`, the records of its person bindings under `data` and each
 * binding's model under `models`; beside it the authority's revision and the change ids it applied, so a change sent
 * again after a handoff is applied once. Every write is one save of the namespace under an owner epoch: the fence's,
 * or the one this node holds the address under (`epochOf`), or 0 where nothing orders instances.
 *
 * `loadWhole` and `saveWhole` are what a running instance uses, one load and one save each. The other methods are for
 * what writes an instance while it is stopped (a reset, a tool that sets person records, an import): each reads the
 * namespace, changes its part and saves it at the next revision
 */
export class NamespaceUiInstanceRepository implements UiInstanceRepository {
    constructor(
        private readonly store: InstanceNamespaceStore,
        private readonly addressOf: (appId: string) => string,
        private readonly epochOf: (address: string) => number | undefined = () => undefined,
        private readonly now: () => number = Date.now
    ) {}

    async loadWhole(appId: string): Promise<InstanceRead<WholeInstance>> {
        if (!isAppId(appId)) return { value: EMPTY };
        return { value: instanceOf(await this.store.load(this.addressOf(appId))) };
    }

    async saveWhole(appId: string, definition: JsonObject, current: JsonObject, datasets: Readonly<Record<string, PersonDataset>>, kept: Pick<WholeInstance, 'applied' | 'revision'>, fence?: InstanceWriteFence): Promise<InstanceDiff> {
        const diff = diffInstance(definition as DiffInput, current as DiffInput) as InstanceDiff;
        if (!isAppId(appId)) return diff;
        await this.put(appId, { diff, datasets, applied: kept.applied, revision: kept.revision }, fence);
        return diff;
    }

    async get(appId: string): Promise<InstanceRead<InstanceDiff>> {
        return { value: (await this.loadWhole(appId)).value.diff };
    }

    async write(appId: string, definition: JsonObject, current: JsonObject, fence?: InstanceWriteFence): Promise<InstanceDiff> {
        const diff = diffInstance(definition as DiffInput, current as DiffInput) as InstanceDiff;
        if (!isAppId(appId)) return diff;
        const whole = (await this.loadWhole(appId)).value;
        await this.put(appId, { ...whole, diff, revision: this.next(whole) }, fence);
        return diff;
    }

    async getData(appId: string, binding: string): Promise<InstanceRead<PersonDataset | undefined>> {
        return { value: (await this.loadWhole(appId)).value.datasets[binding] };
    }

    async writeData(appId: string, binding: string, dataset: PersonDataset, fence?: InstanceWriteFence): Promise<void> {
        if (!isAppId(appId)) throw new Error('An app id is a UUID');
        const whole = (await this.loadWhole(appId)).value;
        await this.put(appId, { ...whole, datasets: { ...whole.datasets, [binding]: dataset }, revision: this.next(whole) }, fence);
    }

    async reset(appId: string): Promise<void> {
        if (!isAppId(appId)) return;
        const address = this.addressOf(appId);
        await this.store.remove(address, this.epochOf(address) ?? 0);
    }

    /** The revision of a write made beside the authority: past the stored one, and past any a stopped authority reached */
    private next(whole: WholeInstance): number {
        return Math.max(this.now(), whole.revision + 1);
    }

    private async put(appId: string, whole: WholeInstance, fence: InstanceWriteFence | undefined): Promise<void> {
        const address = this.addressOf(appId);
        await this.store.save(address, { state: stateOf(whole.diff, whole.datasets), revision: whole.revision, log: [], applied: [...whole.applied] }, fence?.epoch ?? this.epochOf(address) ?? 0);
    }
}

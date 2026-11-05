import type { Report } from '@punyts/core';
import type { JsonValue as SyncValue } from '@punyts/state-sync';
import type { Authority, ChangeContext, ChangeVerdict, ServerWrite } from '@punyts/state-sync/authority';
import { checkRecord, readModel } from '@punyts/stateui-app/core';
import type { JsonValue as LibraryJsonValue, ModelPart } from '@punyts/stateui-app/core';
import type { PartChangeListener } from '../../application/IndexedUiPartRepository.js';
import type { UiPartRepository } from '../../application/ports/UiPartRepository.js';
import type { DataOperation, WriteDataResult } from '../../application/use-cases/WriteData.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import type { PartKind } from '../../domain/partName.js';
import type { InstanceDataGate } from './AppAuthorities.js';
import { dataWrites, isAtOrBelow, sameJson } from './dataWrites.js';
import type { DataWrite } from './dataWrites.js';
import type { InstanceBinding } from './InstanceStart.js';

/** Writes record operations to a dataset part, checked and committed (`WriteData`) */
export type DatasetWriter = (name: string, operations: readonly DataOperation[]) => Promise<WriteDataResult>;

/** Applies the hub's writes to one instance: its authority's `writeAll`, then its logic sees them as changes */
export type InstanceDelivery = (writes: readonly ServerWrite[]) => void;

export interface DatasetParts extends Pick<UiPartRepository, 'findByName'> {
    onChange(listener: PartChangeListener): () => void;
}

/** One binding of a running instance to a shared dataset */
interface Member {
    readonly namespace: string;
    /** `$.data.{binding}` */
    readonly base: string;
    readonly dataset: Dataset;
    readonly authority: Authority;
    readonly deliver: InstanceDelivery;
}

interface Dataset {
    readonly name: string;
    model: string | undefined;
    /** The model read for the synchronous record check; undefined when it is missing or does not read */
    fields: ModelPart | undefined;
    /** The records at `revision`, as the hub last wrote or read them */
    records: JsonObject;
    revision: number;
    readonly members: Member[];
    /** The dataset's write-throughs and refreshes, one at a time in order */
    queue: Promise<void>;
}

/** A write-through: the record keys it sets (with their values) or removes, or the whole map */
type RecordChange = { readonly key: string; readonly value: JsonValue | undefined } | { readonly whole: JsonObject };

function objectOr(value: unknown): JsonObject {
    return isJsonObject(value) ? value : {};
}

/** The value at `segments` below `target` after `op` writes `value` there; objects on the way are copied */
function applyAt(target: JsonValue | undefined, segments: readonly string[], op: ServerWrite['op'], value: JsonValue | undefined): JsonValue | undefined {
    const [head, ...rest] = segments;
    if (head === undefined) {
        if (op === 'delete') return undefined;
        if (op === 'merge' && isJsonObject(target) && isJsonObject(value)) return { ...target, ...value };
        return value;
    }
    const copy: Record<string, JsonValue> = { ...objectOr(target) };
    const next = applyAt(copy[head], rest, op, value);
    if (next === undefined) delete copy[head];
    else copy[head] = next;
    return copy;
}

function segmentsBetween(above: string, below: string): string[] {
    return below === above ? [] : below.slice(above.length + 1).split('.');
}

function descend(value: JsonValue | undefined, segments: readonly string[]): JsonValue | undefined {
    let current = value;
    for (const segment of segments) current = isJsonObject(current) ? current[segment] : undefined;
    return current;
}

function withChange(records: JsonObject, change: RecordChange): JsonObject {
    if ('whole' in change) return change.whole;
    const next: Record<string, JsonValue> = { ...records };
    if (change.value === undefined) delete next[change.key];
    else next[change.key] = change.value;
    return next;
}

function toOperation(change: RecordChange): DataOperation {
    if ('whole' in change) return { op: 'set', path: '', value: change.whole };
    return change.value === undefined ? { op: 'remove', path: change.key } : { op: 'set', path: change.key, value: change.value };
}

/** The change as a server write at another binding's path */
function toWrite(base: string, change: RecordChange): DataWrite {
    if ('whole' in change) return { path: base, op: 'set', value: change.whole as SyncValue };
    return change.value === undefined ? { path: `${base}.${change.key}`, op: 'delete' } : { path: `${base}.${change.key}`, op: 'set', value: change.value as SyncValue };
}

function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Keeps the running instances that bind one shared dataset (`uses.data.{binding} = { dataset }`) in step with the
 * dataset part and with each other (Full mode).
 *
 * - Before a change is applied, the records it touches are checked against the dataset's model, synchronously: the
 *   model is read when the first instance attaches and again when the model or the dataset's `model` changes. A
 *   client change is refused through `authority.onChange` with the reason (`SUI-MODEL-FIELD`, naming the record key
 *   and the field); a write of the instance's logic or a tool is refused through the data gate (`check`), so a
 *   `save-data` gets it as its `rejected` result.
 * - After a change is applied (`onApplied` for a client change, `applied` for a server write), the records it
 *   touched are written to the dataset part, whole, one write-through at a time per dataset. A change that leaves the
 *   records as the dataset has them writes nothing, which is how two instances whose rules derive the same value
 *   settle. A committed write-through is applied to every other binding of the dataset with one `writeAll` each; a
 *   failed one puts the dataset's stored records back into the instance and is reported.
 * - A write of the dataset part from elsewhere (a tool, a rename, a model change) raises its revision past the hub's;
 *   what changed in the records is applied to every binding.
 *
 * Persona bindings are the persona's own and are never attached. Fan-out writes are server writes, which fire no
 * `onApplied`, so the hub never sees its own writes again
 */
export class DatasetHub implements InstanceDataGate {
    private readonly datasets = new Map<string, Promise<Dataset | undefined>>();
    private readonly attached = new Map<string, { readonly members: readonly Member[]; readonly removers: readonly (() => void)[] }>();

    constructor(
        private readonly parts: DatasetParts,
        private readonly write: DatasetWriter,
        private readonly report: Pick<Report, 'info'>
    ) {
        parts.onChange((kind, name) => this.partChanged(kind, name));
    }

    /**
     * Attaches a running instance's shared bindings; a binding whose dataset does not exist is left alone. Replaces
     * what was attached for the namespace before
     */
    async attach(namespace: string, authority: Authority, bindings: Readonly<Record<string, InstanceBinding>>, deliver: InstanceDelivery): Promise<void> {
        this.detach(namespace);
        const members: Member[] = [];
        const removers: (() => void)[] = [];
        for (const [binding, declared] of Object.entries(bindings)) {
            if (declared.scope !== 'shared' || declared.dataset === undefined) continue;
            const dataset = await this.dataset(declared.dataset);
            if (dataset === undefined) continue;
            const member: Member = { namespace, base: `$.data.${binding}`, dataset, authority, deliver };
            dataset.members.push(member);
            members.push(member);
            removers.push(authority.onChange(member.base, (context) => this.guardClient(member, context)));
        }
        if (members.length === 0) return;
        removers.push(authority.onApplied((change) => this.applied(namespace, [change])));
        this.attached.set(namespace, { members, removers });
    }

    /** Stops keeping the namespace's instance in step; a dataset no instance binds any more is forgotten */
    detach(namespace: string): void {
        const current = this.attached.get(namespace);
        if (current === undefined) return;
        this.attached.delete(namespace);
        for (const remove of current.removers) remove();
        for (const member of current.members) {
            const { members, name } = member.dataset;
            members.splice(members.indexOf(member), 1);
            if (members.length === 0) this.datasets.delete(name);
        }
    }

    /** The reason the writes leave a record of a shared binding invalid, or undefined */
    check(namespace: string, writes: readonly ServerWrite[]): string | undefined {
        for (const member of this.attached.get(namespace)?.members ?? []) {
            const reason = this.reasonFor(member, writes);
            if (reason !== undefined) return reason;
        }
        return undefined;
    }

    /** Server writes the instance applied (its logic, a tool): written through to the datasets they touch */
    applied(namespace: string, writes: readonly ServerWrite[]): void {
        for (const member of this.attached.get(namespace)?.members ?? []) {
            const changes = this.recordChanges(member, writes);
            if (changes.length > 0) this.enqueue(member.dataset, () => this.writeThrough(member, changes));
        }
    }

    /** Resolves when no write-through or refresh is queued, including those queued while it waits */
    async settled(): Promise<void> {
        for (;;) {
            const datasets = (await Promise.all([...this.datasets.values()])).filter((dataset) => dataset !== undefined);
            const queues = datasets.map((dataset) => dataset.queue);
            await Promise.all(queues);
            // a part change reaches the hub through a promise, so let it queue its refresh before looking again
            await new Promise((resolve) => setImmediate(resolve));
            if (datasets.every((dataset, index) => dataset.queue === queues[index])) return;
        }
    }

    private guardClient(member: Member, context: ChangeContext): ChangeVerdict {
        const { change } = context;
        const reason = this.reasonFor(member, [change.value === undefined ? { path: change.path, op: change.op } : { path: change.path, op: change.op, value: change.value }]);
        return reason === undefined ? undefined : { result: 'reject', reason };
    }

    /** Applies the writes that reach the binding to its current records and checks the records they touch */
    private reasonFor(member: Member, writes: readonly ServerWrite[]): string | undefined {
        const { base, authority } = member;
        let records = authority.get(base) as JsonValue | undefined;
        const touched = new Set<string>();
        let whole = false;
        for (const write of writes) {
            const value = write.value as JsonValue | undefined;
            if (isAtOrBelow(write.path, base)) {
                const [key] = segmentsBetween(base, write.path);
                records = applyAt(records, segmentsBetween(base, write.path), write.op, value);
                if (key === undefined) whole = true;
                else touched.add(key);
            } else if (isAtOrBelow(base, write.path)) {
                const above = applyAt(authority.get(write.path) as JsonValue | undefined, [], write.op, value);
                records = descend(above, segmentsBetween(write.path, base));
                whole = true;
            }
        }
        if (!whole && touched.size === 0) return undefined;
        if (records !== undefined && !isJsonObject(records)) return `${base} holds the records of the dataset "${member.dataset.name}", so it must be an object`;
        const model = member.dataset.fields;
        if (model === undefined || records === undefined) return undefined;
        const errors = [];
        for (const key of whole ? Object.keys(records) : touched) {
            const record = records[key];
            if (record !== undefined) errors.push(...checkRecord(model, record as LibraryJsonValue, key));
        }
        return errors.length === 0 ? undefined : errors.map((error) => error.message).join('; ');
    }

    /** The record changes of applied writes, read from the instance now, before it changes again */
    private recordChanges(member: Member, writes: readonly ServerWrite[]): RecordChange[] {
        const { base, authority } = member;
        const changes: RecordChange[] = [];
        for (const write of writes) {
            if (isAtOrBelow(base, write.path)) {
                changes.push({ whole: objectOr(authority.get(base)) });
            } else if (isAtOrBelow(write.path, base)) {
                const [key] = segmentsBetween(base, write.path);
                if (key !== undefined) changes.push({ key, value: authority.get(`${base}.${key}`) as JsonValue | undefined });
            }
        }
        return changes;
    }

    private async writeThrough(member: Member, changes: readonly RecordChange[]): Promise<void> {
        const { dataset } = member;
        const next = changes.reduce(withChange, dataset.records);
        if (sameJson(next, dataset.records)) return;
        let failure: string | undefined;
        let revision: number | undefined;
        try {
            const result = await this.write(dataset.name, changes.map(toOperation));
            if (result.kind === 'written') revision = result.revision;
            else failure = result.kind === 'invalid' ? result.errors.map((error) => error.message).join('; ') : result.kind;
        } catch (error) {
            failure = reasonOf(error);
        }
        const part = await this.parts.findByName('data', dataset.name).catch(() => undefined);
        if (revision === undefined) {
            this.report.info('Shared data not written', { dataset: dataset.name, instance: member.namespace, reason: failure ?? 'unknown' });
            member.deliver([{ path: member.base, op: 'set', value: (part === undefined ? dataset.records : objectOr(part.body.records)) as SyncValue }]);
            return;
        }
        // Only a write right after the hub's revision is the hub's alone; otherwise the refresh of the write between applies both
        if (part !== undefined && part.revision === revision && dataset.revision === revision - 1) {
            dataset.records = objectOr(part.body.records);
            dataset.revision = revision;
        }
        for (const other of dataset.members) {
            if (other !== member) other.deliver(changes.map((change) => toWrite(other.base, change)));
        }
    }

    private partChanged(kind: PartKind, name: string): void {
        if (kind !== 'data' && kind !== 'models') return;
        for (const loading of [...this.datasets.values()]) {
            void loading.then((dataset) => {
                if (dataset === undefined) return;
                if (kind === 'data' && dataset.name === name) this.enqueue(dataset, () => this.refresh(dataset));
                if (kind === 'models' && dataset.model === name) this.enqueue(dataset, () => this.readFields(dataset));
            });
        }
    }

    /** A write of the dataset from elsewhere: what changed in the records goes to every binding */
    private async refresh(dataset: Dataset): Promise<void> {
        const part = await this.parts.findByName('data', dataset.name);
        if (part === undefined || part.revision <= dataset.revision) return;
        const before = dataset.records;
        dataset.records = objectOr(part.body.records);
        dataset.revision = part.revision;
        if (part.body.model !== dataset.model) {
            dataset.model = part.body.model;
            await this.readFields(dataset);
        }
        for (const member of dataset.members) {
            const writes: DataWrite[] = [];
            dataWrites(member.base, before, dataset.records, writes);
            if (writes.length > 0) member.deliver(writes);
        }
    }

    private async readFields(dataset: Dataset): Promise<void> {
        const model = dataset.model === undefined ? undefined : await this.parts.findByName('models', dataset.model);
        dataset.fields = model === undefined ? undefined : readModel(model.body as unknown as LibraryJsonValue).model;
    }

    private dataset(name: string): Promise<Dataset | undefined> {
        let loading = this.datasets.get(name);
        if (loading === undefined) {
            loading = this.load(name);
            this.datasets.set(name, loading);
            loading.then(
                (dataset) => {
                    if (dataset === undefined && this.datasets.get(name) === loading) this.datasets.delete(name);
                },
                () => this.datasets.delete(name)
            );
        }
        return loading;
    }

    private async load(name: string): Promise<Dataset | undefined> {
        const part = await this.parts.findByName('data', name);
        if (part === undefined) return undefined;
        const dataset: Dataset = {
            name,
            model: part.body.model,
            fields: undefined,
            records: objectOr(part.body.records),
            revision: part.revision,
            members: [],
            queue: Promise.resolve()
        };
        await this.readFields(dataset);
        return dataset;
    }

    private enqueue(dataset: Dataset, task: () => Promise<void>): void {
        dataset.queue = dataset.queue.then(task).catch((error: unknown) => {
            this.report.info('Shared data not kept in step', { dataset: dataset.name, reason: reasonOf(error) });
        });
    }
}

import type { Report } from '@punyts/core';
import type { RevisedChange } from '@punyts/state-sync';
import type { Authority, ChangeContext, ChangeVerdict, RelayBatch, RelaySubscription, RelayWelcome, ServerWrite, Upstream } from '@punyts/state-sync/authority';
import { checkRecord, readModel } from '@punyts/stateui-app/core';
import type { JsonValue as LibraryJsonValue, ModelPart } from '@punyts/stateui-app/core';
import type { PartChangeListener } from '../../application/IndexedUiPartRepository.js';
import type { UiPartRepository } from '../../application/ports/UiPartRepository.js';
import type { DataOperation, WriteDataResult } from '../../application/use-cases/WriteData.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import type { PartKind } from '../../domain/partName.js';
import type { InstanceDataGate } from './AppAuthorities.js';
import { RECORDS_PATH } from './DatasetNamespaces.js';
import { dataWrites, isAtOrBelow } from './dataWrites.js';
import type { DataWrite } from './dataWrites.js';
import type { InstanceBinding } from './InstanceStart.js';

/** Writes record operations to a dataset, checked and committed (`WriteData`) */
export type DatasetWriter = (name: string, operations: readonly DataOperation[]) => Promise<WriteDataResult>;

/** Applies the hub's writes to one instance: its authority's `writeAll`, then its logic sees them as changes */
export type InstanceDelivery = (writes: readonly ServerWrite[]) => void;

/** The stored parts, read for a dataset's model (its records come from its namespace), and what tells of part changes */
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
    /** The member's write-throughs not yet done: while there are any, the dataset's changes wait for them */
    pending: number;
}

interface Dataset {
    readonly name: string;
    model: string | undefined;
    /** The model read for the synchronous record check; undefined when it is missing or does not read */
    fields: ModelPart | undefined;
    /** The records as the dataset's namespace last told them, at `revision` */
    records: JsonObject;
    revision: number | undefined;
    readonly members: Member[];
    /** The subscription to the dataset's namespace, through the relay */
    subscription?: RelaySubscription;
    /** The dataset's write-throughs and model reads, one at a time in order */
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

function toOperation(change: RecordChange): DataOperation {
    if ('whole' in change) return { op: 'set', path: '', value: change.whole };
    return change.value === undefined ? { op: 'remove', path: change.key } : { op: 'set', path: change.key, value: change.value };
}

/** The records after the namespace's changes, which are at or below or above `$.data.records` */
function withChanges(records: JsonObject, changes: readonly RevisedChange[]): JsonObject {
    let next: JsonValue | undefined = records;
    for (const change of changes) {
        const value = change.value as JsonValue | undefined;
        if (isAtOrBelow(change.path, RECORDS_PATH)) next = applyAt(next, segmentsBetween(RECORDS_PATH, change.path), change.op, value);
        else if (isAtOrBelow(RECORDS_PATH, change.path)) next = descend(applyAt(undefined, [], change.op, value), segmentsBetween(change.path, RECORDS_PATH));
    }
    return objectOr(next);
}

function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Keeps the running instances that bind one shared dataset (`uses.data.{binding} = { dataset }`) in step with the
 * dataset's namespace (`<owner>/data/<dataset>`, docs/design/statenet-requests.md, "how R3a is built") and so with
 * each other (Full mode).
 *
 * - Before a change is applied, the records it touches are checked against the dataset's model, synchronously: the
 *   model is read when the first instance attaches and again when the model or the dataset's `model` changes. A
 *   client change is refused through `authority.onChange` with the reason (`SUI-MODEL-FIELD`, naming the record key
 *   and the field); a write of the instance's logic or a tool is refused through the data gate (`check`), so a
 *   `save-data` gets it as its `rejected` result.
 * - After a change is applied (`onApplied` for a client change, `applied` for a server write), the records it
 *   touched are written to the dataset, whole, one write-through at a time per dataset. A failed write-through puts
 *   the dataset's records back into the instance and is reported.
 * - The hub subscribes to each bound dataset's namespace through the relay, which follows it to the server that holds
 *   it, so a change from anywhere (an instance here or on another server, a tool, the Data page) reaches every
 *   binding here. Only what differs from a binding is written to it, so an instance's own change coming back writes
 *   nothing; while an instance's write-throughs are under way, the dataset's changes wait and are laid over it after.
 *
 * Persona bindings are the persona's own and are never attached. Deliveries are server writes, which fire no
 * `onApplied`, so the hub never writes its own deliveries through again
 */
export class DatasetHub implements InstanceDataGate {
    private readonly datasets = new Map<string, Promise<Dataset | undefined>>();
    private readonly attached = new Map<string, { readonly members: readonly Member[]; readonly removers: readonly (() => void)[] }>();
    /** Each namespace's write-throughs not yet waited for, each resolving to why it failed or to undefined */
    private readonly writing = new Map<string, Promise<string | undefined>[]>();
    private closed = false;

    constructor(
        private readonly parts: DatasetParts,
        private readonly write: DatasetWriter,
        /** Where datasets' namespaces are subscribed: a relay that follows each to the server that holds it */
        private readonly upstream: Upstream,
        /** The address of a dataset's namespace */
        private readonly addressOf: (dataset: string) => string,
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
            const member: Member = { namespace, base: `$.data.${binding}`, dataset, authority, deliver, pending: 0 };
            dataset.members.push(member);
            members.push(member);
            removers.push(authority.onChange(member.base, (context) => this.guardClient(member, context)));
            if (dataset.revision !== undefined) this.reconcile(member);
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
            if (members.length === 0) {
                member.dataset.subscription?.close();
                this.datasets.delete(name);
            }
        }
    }

    /** Detaches every instance and subscribes to nothing more: the server is closing */
    close(): void {
        this.closed = true;
        for (const namespace of [...this.attached.keys()]) this.detach(namespace);
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
            if (changes.length === 0) continue;
            member.pending++;
            const outcome = new Promise<string | undefined>((resolve) =>
                this.enqueue(member.dataset, async () => {
                    const reason = await this.writeThrough(member, changes).catch((error: unknown) => reasonOf(error));
                    member.pending--;
                    if (member.pending === 0) this.reconcile(member);
                    resolve(reason);
                })
            );
            this.writing.set(namespace, [...(this.writing.get(namespace) ?? []), outcome]);
        }
    }

    /** Resolves once the namespace's write-throughs queued so far are done; rejects with the reason one of them failed */
    async durable(namespace: string): Promise<void> {
        const pending = [...(this.writing.get(namespace) ?? [])];
        if (pending.length === 0) return;
        const failures = (await Promise.all(pending)).filter((reason): reason is string => reason !== undefined);
        const left = (this.writing.get(namespace) ?? []).filter((task) => !pending.includes(task));
        if (left.length === 0) this.writing.delete(namespace);
        else this.writing.set(namespace, left);
        if (failures.length > 0) throw new Error(`The shared data was not stored: ${failures[0]}`);
    }

    /** Resolves when no write-through or model read is queued, including those queued while it waits */
    async settled(): Promise<void> {
        for (;;) {
            const datasets = (await Promise.all([...this.datasets.values()])).filter((dataset) => dataset !== undefined);
            const queues = datasets.map((dataset) => dataset.queue);
            await Promise.all(queues);
            // a part change or a relay delivery reaches the hub through a promise, so let it queue before looking again
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

    /** Writes the changes to the dataset; answers why they were not written, or undefined */
    private async writeThrough(member: Member, changes: readonly RecordChange[]): Promise<string | undefined> {
        const { dataset } = member;
        let failure: string | undefined;
        try {
            const result = await this.write(dataset.name, changes.map(toOperation));
            if (result.kind !== 'written') failure = result.kind === 'invalid' ? result.errors.map((error) => error.message).join('; ') : result.kind;
        } catch (error) {
            failure = reasonOf(error);
        }
        if (failure === undefined) return undefined;
        // The binding goes back to the dataset's records when the member's write-throughs are done (`reconcile`)
        this.report.info('Shared data not written', { dataset: dataset.name, instance: member.namespace, reason: failure });
        return failure;
    }

    /** Writes to a binding what differs between it and the dataset's records */
    private reconcile(member: Member): void {
        if (member.pending > 0 || member.dataset.revision === undefined) return;
        const writes: DataWrite[] = [];
        dataWrites(member.base, objectOr(member.authority.get(member.base)), member.dataset.records, writes);
        if (writes.length > 0) member.deliver(writes);
    }

    /** The dataset's records moved on: every binding here that is not writing gets what differs */
    private received(dataset: Dataset, records: JsonObject, revision: number): void {
        dataset.records = records;
        dataset.revision = revision;
        for (const member of dataset.members) this.reconcile(member);
    }

    private subscribe(dataset: Dataset): void {
        const listener = {
            welcome: (welcome: RelayWelcome) => {
                const records = 'changes' in welcome ? withChanges(dataset.records, welcome.changes) : objectOr(welcome.value);
                this.received(dataset, records, welcome.revision);
            },
            changes: (batch: RelayBatch) => {
                if (dataset.revision !== undefined && batch.previous !== dataset.revision) {
                    // a gap: subscribe again from the revision the hub has
                    this.resubscribe(dataset);
                    return;
                }
                this.received(dataset, withChanges(dataset.records, batch.changes), batch.revision);
            },
            closed: (reason: string) => {
                if (dataset.members.length === 0 || dataset.subscription === undefined) return;
                this.report.info('Shared data subscription closed', { dataset: dataset.name, reason });
                setTimeout(() => this.resubscribe(dataset), 0);
            }
        };
        dataset.subscription = this.upstream.subscribe(this.addressOf(dataset.name), RECORDS_PATH, dataset.revision, listener);
    }

    private resubscribe(dataset: Dataset): void {
        dataset.subscription?.close();
        delete dataset.subscription;
        if (dataset.members.length > 0 && !this.closed) this.subscribe(dataset);
    }

    private partChanged(kind: PartKind, name: string): void {
        if (kind !== 'data' && kind !== 'models') return;
        for (const loading of [...this.datasets.values()]) {
            void loading.then((dataset) => {
                if (dataset === undefined) return;
                if (kind === 'data' && dataset.name === name) this.enqueue(dataset, () => this.readModelName(dataset));
                if (kind === 'models' && dataset.model === name) this.enqueue(dataset, () => this.readFields(dataset));
            });
        }
    }

    /** The dataset part changed: its model may be another */
    private async readModelName(dataset: Dataset): Promise<void> {
        const part = await this.parts.findByName('data', dataset.name);
        if (part === undefined || part.body.model === dataset.model) return;
        dataset.model = part.body.model;
        await this.readFields(dataset);
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
        const dataset: Dataset = { name, model: part.body.model, fields: undefined, records: {}, revision: undefined, members: [], queue: Promise.resolve() };
        await this.readFields(dataset);
        this.subscribe(dataset);
        return dataset;
    }

    private enqueue(dataset: Dataset, task: () => Promise<void>): void {
        dataset.queue = dataset.queue.then(task).catch((error: unknown) => {
            this.report.info('Shared data not kept in step', { dataset: dataset.name, reason: reasonOf(error) });
        });
    }
}


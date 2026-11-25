import type { Report } from '@punyts/core';
import type { JsonValue as SyncJson, SyncRequest } from '@punyts/state-sync';
import type { Authority, ChangeContext, ChangeVerdict, ServerWrite } from '@punyts/state-sync/authority';
import { ownerOfTestPerson } from '../../domain/InstanceKey.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import type { InstanceDataGate } from './AppAuthorities.js';
import { recordsReason, segmentsBetween } from './DatasetModels.js';
import type { DatasetModels } from './DatasetModels.js';
import { RECORDS_PATH } from './DatasetNamespaces.js';
import type { DatasetSession, DatasetSessionOptions, RecordChange } from './DatasetSession.js';
import { dataWrites, isAtOrBelow } from './dataWrites.js';
import type { DataWrite } from './dataWrites.js';
import type { InstanceBinding } from './InstanceStart.js';

/** Applies the hub's writes to one instance: its authority's `writeAll`, then its logic sees them as changes */
export type InstanceDelivery = (writes: readonly ServerWrite[]) => void;

/** Opens a binding's session with a dataset's namespace as the person the instance acts for */
export type DatasetSessionOpener = (person: string, dataset: string, handlers: Pick<DatasetSessionOptions, 'onRecords' | 'onRequests' | 'onRejected'>) => Promise<DatasetSession>;

/** How long an instance's start waits for a binding's records before its logic runs without them */
const FIRST_RECORDS_MS = 5_000;

/** The emit a host sends to decide a binding's request, and the one that asks for the requests again (R3b; the browser host's `BOUND_DECIDE` and `BOUND_REQUESTS`) */
export const DECIDE_EMIT = 'sync.decide';
export const REQUESTS_EMIT = 'sync.requests';

/** One binding of a running instance to a shared dataset */
interface Member {
    readonly namespace: string;
    readonly dataset: string;
    /** `$.data.{binding}` */
    readonly base: string;
    readonly authority: Authority;
    readonly deliver: InstanceDelivery;
    /** A test run's copy of the dataset: checked against its model, never sent to the dataset */
    readonly copy: boolean;
    /** A copy's last records of the dataset, whose changes it takes */
    seen: JsonObject | undefined;
    session: DatasetSession | undefined;
    requests: readonly SyncRequest[];
}

interface Attached {
    readonly members: readonly Member[];
    readonly removers: readonly (() => void)[];
    closed: boolean;
}

function objectOr(value: unknown): JsonObject {
    return isJsonObject(value) ? value : {};
}

/** A request of the dataset's namespace as the binding sees it: its path below `$.data.{binding}` */
function asBinding(request: SyncRequest, base: string): SyncRequest {
    return isAtOrBelow(request.path, RECORDS_PATH) ? { ...request, path: base + request.path.slice(RECORDS_PATH.length) } : request;
}

/**
 * Keeps the running instances that bind one shared dataset (`uses.data.{binding} = { dataset }`) in step with the
 * dataset's namespace (`<owner>/data/<dataset>`, docs/design/statenet-requests.md, "how R3b is built").
 *
 * - Each binding is a sync session with the namespace (`DatasetSession`) as the person the instance acts for, so the
 *   dataset's authority checks their access: a write they may make is applied, one they may only request waits as a
 *   request, any other is refused. The authority checks records against the model whoever writes.
 * - The instance's own writes to a binding are checked against the model here too, synchronously, so a client change
 *   is refused through `authority.onChange` and a write of the instance's logic or a tool through the data gate
 *   (`check`), which gives a `save-data` its `rejected` result at once.
 * - After a change is applied (`onApplied` for a client change, `applied` for a server write), the records it touched
 *   are sent through the binding's session. `durable` waits for the authority's answer and fails with a refusal.
 * - What the session shows (the namespace's records, with the binding's changes on top until they are answered) is
 *   laid over the binding, only what differs, so a refused or requested change is taken out of it again.
 * - The binding's requests are emitted to the instance's clients as `sync.requests`, with paths below the binding; a
 *   client decides one with the emit `sync.decide` `{ action, id, note }` and asks for them again with `sync.requests`.
 *
 * A test run's copy (a person binding that names its `dataset`, docs/design/stateui-test-runs.md) is checked against
 * the dataset's model the same way. Its session, as the owner, only reads: a change of the dataset (`ui_data_write`,
 * the Data page) is applied to the copy as that change, so the copy's own writes to other records stay, and nothing
 * the copy changes is sent. Other person bindings are the person's own and are never attached. Deliveries are server writes, which fire no
 * `onApplied`, so the hub never sends its own deliveries again
 */
export class DatasetHub implements InstanceDataGate {
    private readonly attached = new Map<string, Attached>();

    constructor(
        private readonly models: DatasetModels,
        /** Whether a dataset exists: a binding to one that does not is left alone */
        private readonly exists: (dataset: string) => Promise<boolean>,
        private readonly open: DatasetSessionOpener,
        private readonly report: Pick<Report, 'info'>
    ) {}

    /**
     * Attaches a running instance's shared bindings, each with a session as `person`. Replaces what was attached for
     * the namespace before
     */
    async attach(namespace: string, person: string, authority: Authority, bindings: Readonly<Record<string, InstanceBinding>>, deliver: InstanceDelivery): Promise<void> {
        this.detach(namespace);
        const members: Member[] = [];
        const removers: (() => void)[] = [];
        const attached: Attached = { members, removers, closed: false };
        for (const [binding, declared] of Object.entries(bindings)) {
            if (declared.dataset === undefined) continue;
            if (!(await this.exists(declared.dataset))) continue;
            await this.models.load(declared.dataset);
            const member: Member = { namespace, dataset: declared.dataset, base: `$.data.${binding}`, authority, deliver, copy: declared.scope === 'person', seen: undefined, session: undefined, requests: [] };
            members.push(member);
            removers.push(authority.onChange(member.base, (context) => this.guardClient(member, context)));
        }
        if (members.length === 0) return;
        this.attached.set(namespace, attached);
        removers.push(authority.onApplied((change) => this.applied(namespace, [change])));
        removers.push(authority.onEmit((name, value) => this.emitted(attached, name, value)));
        for (const member of members) {
            if (member.copy) {
                member.session = await this.open(ownerOfTestPerson(person) ?? person, member.dataset, {
                    onRecords: (records) => this.follow(member, records),
                    onRequests: () => undefined,
                    onRejected: (reason) => this.report.info('Shared data refused', { dataset: member.dataset, instance: namespace, reason })
                });
                if (attached.closed) member.session.close();
                continue;
            }
            member.session = await this.open(person, member.dataset, {
                onRecords: (records) => this.reconcile(member, records),
                onRequests: (requests) => {
                    member.requests = requests.map((request) => asBinding(request, member.base));
                    this.sendRequests(attached);
                },
                onRejected: (reason) => this.report.info('Shared data refused', { dataset: member.dataset, instance: namespace, reason })
            });
            if (attached.closed) member.session.close();
        }
        // The instance's logic starts on the dataset's records, so what it derives is checked against them
        await Promise.all(members.map((member) => member.session?.ready(FIRST_RECORDS_MS)));
    }

    /** Stops keeping the namespace's instance in step: its sessions close */
    detach(namespace: string): void {
        const current = this.attached.get(namespace);
        if (current === undefined) return;
        this.attached.delete(namespace);
        current.closed = true;
        for (const remove of current.removers) remove();
        for (const member of current.members) member.session?.close();
    }

    /** Detaches every instance: the server is closing */
    close(): void {
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

    /** Server writes the instance applied (its logic, a tool): sent through the sessions of the bindings they touch */
    applied(namespace: string, writes: readonly ServerWrite[]): void {
        for (const member of this.attached.get(namespace)?.members ?? []) {
            if (member.copy) continue;
            const changes = this.recordChanges(member, writes);
            if (changes.length > 0) member.session?.write(changes);
        }
    }

    /**
     * Resolves once the authority answered every change the namespace's bindings sent so far; rejects with the reason
     * it refused one
     */
    async durable(namespace: string): Promise<void> {
        const reasons = await Promise.all((this.attached.get(namespace)?.members ?? []).map((member) => member.session?.settled()));
        const refused = reasons.find((reason) => reason !== undefined);
        if (refused !== undefined) throw new Error(`The shared data was not stored: ${refused}`);
    }

    /** Resolves when every session's changes are answered and their deliveries made */
    async settled(): Promise<void> {
        for (let round = 0; round < 3; round++) {
            await Promise.all([...this.attached.values()].flatMap((attached) => attached.members.map((member) => member.session?.settled())));
            await new Promise((resolve) => setImmediate(resolve));
        }
    }

    private guardClient(member: Member, context: ChangeContext): ChangeVerdict {
        const { change } = context;
        const reason = this.reasonFor(member, [change.value === undefined ? { path: change.path, op: change.op } : { path: change.path, op: change.op, value: change.value }]);
        return reason === undefined ? undefined : { result: 'reject', reason };
    }

    private reasonFor(member: Member, writes: readonly ServerWrite[]): string | undefined {
        return recordsReason(this.models.fields(member.dataset), member.dataset, member.base, (path) => member.authority.get(path) as JsonValue | undefined, writes);
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

    /** Writes to a binding what differs between it and the records its session shows */
    private reconcile(member: Member, records: JsonObject): void {
        const writes: DataWrite[] = [];
        dataWrites(member.base, objectOr(member.authority.get(member.base)), records, writes);
        if (writes.length > 0) member.deliver(writes);
    }

    /** Applies to a copy what changed in the dataset since its last records; the first records are what it started from */
    private follow(member: Member, records: JsonObject): void {
        const seen = member.seen;
        member.seen = records;
        if (seen === undefined) return;
        const writes: DataWrite[] = [];
        dataWrites(member.base, seen, records, writes);
        if (writes.length > 0) member.deliver(writes);
    }

    private sendRequests(attached: Attached): void {
        if (attached.closed) return;
        const all = attached.members.flatMap((member) => member.requests);
        attached.members[0]?.authority.emit(REQUESTS_EMIT, all as unknown as SyncJson);
    }

    /** A client's emit on the instance: a decision on a binding's request, or a call for the requests */
    private emitted(attached: Attached, name: string, value: SyncJson | undefined): void {
        if (name === REQUESTS_EMIT) {
            this.sendRequests(attached);
            return;
        }
        if (name !== DECIDE_EMIT || !isJsonObject(value as JsonValue)) return;
        const { action, id, note } = value as JsonObject;
        if ((action !== 'approve' && action !== 'reject' && action !== 'withdraw') || typeof id !== 'string') return;
        const holder = attached.members.find((member) => member.requests.some((request) => request.id === id));
        holder?.session?.decide(action, id, typeof note === 'string' ? note : undefined);
    }
}

import type { JsonValue as SyncValue } from '@punyts/state-sync';
import type { ServerWrite } from '@punyts/state-sync/authority';
import type {
    CreateUiPartInput,
    CreateUiPartResult,
    UiPartDeleteResult,
    UiPartRenameResult,
    UiPartRepository,
    UiPartRewrite,
    UiPartSummary,
    UiPartWriteResult
} from '../../application/ports/UiPartRepository.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonObject } from '../../domain/JsonValue.js';
import type { PartKind } from '../../domain/partName.js';
import type { UiPart, UiPartBodies } from '../../domain/UiPart.js';
import type { DatasetNamespaces } from '../sync/DatasetNamespaces.js';
import { RECORDS_PATH } from '../sync/DatasetNamespaces.js';
import { dataWrites } from '../sync/dataWrites.js';
import type { DataWrite } from '../sync/dataWrites.js';

/** A data part's body as stored: everything but its records */
function storedBody(body: object): UiPartBodies['data'] {
    const { records: _records, ...rest } = body as JsonObject;
    return rest as unknown as UiPartBodies['data'];
}

function recordsOf(body: object): JsonObject {
    const records = (body as JsonObject)['records'];
    return isJsonObject(records) ? records : {};
}

/**
 * The owner's parts with each dataset's records in its namespace (docs/design/statenet-requests.md, "how R3a is
 * built"). The stored `data` part keeps the dataset's id, name and model; a `data` part is served with the records of
 * its namespace (`$.data.records`) and the namespace's revision. A write of a `data` part checks the revision the
 * caller read against the namespace's and writes what changed in the records as server writes; a create makes the
 * namespace, a rename moves it and a delete removes it. Every other kind is the stored repository's
 */
export class DatasetParts implements UiPartRepository {
    constructor(
        private readonly stored: UiPartRepository,
        private readonly namespaces: DatasetNamespaces
    ) {}

    async create<K extends PartKind>(input: CreateUiPartInput<K>): Promise<CreateUiPartResult<K>> {
        if (input.kind !== 'data') return this.stored.create(input);
        const created = await this.stored.create({ ...input, body: storedBody(input.body as object) } as CreateUiPartInput<K>);
        if (created.kind !== 'created') return created;
        const authority = await this.namespaces.authority(input.name);
        const revision = authority.write({ path: RECORDS_PATH, op: 'set', value: recordsOf(input.body as object) as SyncValue }) ?? authority.revision();
        await authority.whenDurable(revision);
        return { kind: 'created', part: { ...created.part, body: input.body, revision } };
    }

    async findByName<K extends PartKind>(kind: K, name: string): Promise<UiPart<K> | undefined> {
        return this.withRecords(await this.stored.findByName(kind, name));
    }

    async findById<K extends PartKind>(kind: K, id: string): Promise<UiPart<K> | undefined> {
        return this.withRecords(await this.stored.findById(kind, id));
    }

    list(kind: PartKind): Promise<readonly UiPartSummary[]> {
        return this.stored.list(kind);
    }

    async write<K extends PartKind>(kind: K, name: string, body: UiPartBodies[K], expectedRevision: number): Promise<UiPartWriteResult> {
        if (kind !== 'data') return this.stored.write(kind, name, body, expectedRevision);
        const part = await this.stored.findByName('data', name);
        if (part === undefined) return { kind: 'not-found' };
        const authority = await this.namespaces.authority(name);
        if (authority.revision() !== expectedRevision) return { kind: 'conflict', currentRevision: authority.revision() };
        const next = storedBody(body as object);
        if (JSON.stringify(next) !== JSON.stringify(part.body)) {
            const written = await this.stored.write('data', name, next, part.revision);
            if (written.kind !== 'written') return written.kind === 'conflict' ? { kind: 'conflict', currentRevision: authority.revision() } : written;
        }
        const writes: DataWrite[] = [];
        dataWrites(RECORDS_PATH, authority.get(RECORDS_PATH) as JsonObject | undefined, recordsOf(body as object), writes);
        if (writes.length === 0) return { kind: 'written', revision: authority.revision() };
        const revisions = authority.writeAll(writes as ServerWrite[]);
        const revision = revisions[revisions.length - 1] ?? authority.revision();
        await authority.whenDurable(revision);
        return { kind: 'written', revision };
    }

    async delete(kind: PartKind, name: string, expectedRevision: number): Promise<UiPartDeleteResult> {
        if (kind !== 'data') return this.stored.delete(kind, name, expectedRevision);
        const part = await this.stored.findByName('data', name);
        if (part === undefined) return { kind: 'not-found' };
        const authority = await this.namespaces.authority(name);
        if (authority.revision() !== expectedRevision) return { kind: 'conflict', currentRevision: authority.revision() };
        const deleted = await this.stored.delete('data', name, part.revision);
        if (deleted.kind === 'deleted') await this.namespaces.remove(name);
        return deleted.kind === 'conflict' ? { kind: 'conflict', currentRevision: authority.revision() } : deleted;
    }

    async rename(kind: PartKind, from: string, to: string, rewrites: readonly UiPartRewrite[] = []): Promise<UiPartRenameResult> {
        // A rewritten dataset names a renamed model: its stored body is rewritten at the stored revision
        const stored: UiPartRewrite[] = [];
        for (const rewrite of rewrites) {
            if (rewrite.kind !== 'data') {
                stored.push(rewrite);
                continue;
            }
            const part = await this.stored.findByName('data', rewrite.name);
            if (part === undefined) return { kind: 'not-found' };
            stored.push({ ...rewrite, body: storedBody(rewrite.body), expectedRevision: part.revision });
        }
        if (kind === 'data' && from !== to) {
            // The records go to the new name first: a rename that fails leaves the old namespace as it was
            await this.namespaces.move(from, to);
            const renamed = await this.stored.rename(kind, from, to, stored);
            if (renamed.kind !== 'renamed') await this.namespaces.move(to, from);
            else return { ...renamed, revision: (await this.namespaces.authority(to)).revision() };
            return renamed;
        }
        return this.stored.rename(kind, from, to, stored);
    }

    private async withRecords<K extends PartKind>(part: UiPart<K> | undefined): Promise<UiPart<K> | undefined> {
        if (part === undefined || part.kind !== 'data') return part;
        const authority = await this.namespaces.authority(part.name);
        const records = authority.get(RECORDS_PATH);
        return { ...part, body: { ...(part.body as object), records: isJsonObject(records) ? records : {} } as UiPartBodies[K], revision: authority.revision() };
    }
}

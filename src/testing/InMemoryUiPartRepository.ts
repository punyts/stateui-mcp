import { randomUUID } from 'node:crypto';
import type {
    CreateUiPartInput,
    CreateUiPartResult,
    UiPartDeleteResult,
    UiPartRenameResult,
    UiPartRepository,
    UiPartRewrite,
    UiPartSummary,
    UiPartWriteResult
} from '../application/ports/UiPartRepository.js';
import type { PartKind } from '../domain/partName.js';
import { PART_BODY_PROBLEM, createUiPart, isPartBody, partInputProblem, partNameProblem, renameUiPart, reviseUiPart } from '../domain/UiPart.js';
import type { UiPart, UiPartBodies } from '../domain/UiPart.js';
import { isRevisionCurrent } from '../domain/revision.js';

export interface InMemoryUiPartRepositoryOptions {
    readonly newId?: () => string;
    readonly now?: () => Date;
}

/**
 * `UiPartRepository` in memory, for use-case tests. Bodies are copied in and out (`structuredClone`, which keeps key
 * order), so a caller cannot change a stored part. Its results match the file adapter's (`partRepository.contract.test.ts`)
 */
export class InMemoryUiPartRepository implements UiPartRepository {
    private readonly parts = new Map<string, UiPart>();
    private readonly names = new Map<PartKind, Map<string, string>>();
    private readonly newId: () => string;
    private readonly now: () => Date;

    constructor(options: InMemoryUiPartRepositoryOptions = {}) {
        this.newId = options.newId ?? randomUUID;
        this.now = options.now ?? (() => new Date());
    }

    async create<K extends PartKind>(input: CreateUiPartInput<K>): Promise<CreateUiPartResult<K>> {
        const problem = partInputProblem(input.kind, input.name, input.body);
        if (problem !== undefined) return { kind: 'invalid', reason: problem };
        const names = this.namesOf(input.kind);
        if (names.has(input.name)) return { kind: 'duplicate-name' };
        const part = createUiPart({ id: this.newId(), kind: input.kind, name: input.name, body: structuredClone(input.body), now: this.now() });
        this.parts.set(part.id, part as UiPart);
        names.set(part.name, part.id);
        return { kind: 'created', part: structuredClone(part) };
    }

    async findByName<K extends PartKind>(kind: K, name: string): Promise<UiPart<K> | undefined> {
        const part = this.byName(kind, name);
        return part === undefined ? undefined : (structuredClone(part) as UiPart<K>);
    }

    async findById<K extends PartKind>(kind: K, id: string): Promise<UiPart<K> | undefined> {
        const part = this.parts.get(id);
        return part === undefined || part.kind !== kind ? undefined : (structuredClone(part) as UiPart<K>);
    }

    async list(kind: PartKind): Promise<readonly UiPartSummary[]> {
        return [...this.namesOf(kind).keys()]
            .sort()
            .map((name) => this.byName(kind, name) as UiPart)
            .map(({ id, name, revision, updatedAt }) => ({ id, kind, name, revision, updatedAt }));
    }

    async write<K extends PartKind>(kind: K, name: string, body: UiPartBodies[K], expectedRevision: number): Promise<UiPartWriteResult> {
        if (!isPartBody(body)) return { kind: 'invalid', reason: PART_BODY_PROBLEM };
        const part = this.byName(kind, name);
        if (part === undefined) return { kind: 'not-found' };
        if (!isRevisionCurrent(part.revision, expectedRevision)) return { kind: 'conflict', currentRevision: part.revision };
        const written = reviseUiPart(part, structuredClone(body), this.now());
        this.parts.set(written.id, written as UiPart);
        return { kind: 'written', revision: written.revision };
    }

    async delete(kind: PartKind, name: string, expectedRevision: number): Promise<UiPartDeleteResult> {
        const part = this.byName(kind, name);
        if (part === undefined) return { kind: 'not-found' };
        if (!isRevisionCurrent(part.revision, expectedRevision)) return { kind: 'conflict', currentRevision: part.revision };
        this.parts.delete(part.id);
        this.namesOf(kind).delete(name);
        return { kind: 'deleted' };
    }

    async rename(kind: PartKind, from: string, to: string, rewrites: readonly UiPartRewrite[] = []): Promise<UiPartRenameResult> {
        const problem = partNameProblem(to);
        if (problem !== undefined) return { kind: 'invalid', reason: problem };
        if (rewrites.some((rewrite) => !isPartBody(rewrite.body))) return { kind: 'invalid', reason: PART_BODY_PROBLEM };
        const part = this.byName(kind, from);
        if (part === undefined) return { kind: 'not-found' };
        const names = this.namesOf(kind);
        if (names.has(to)) return { kind: 'duplicate-name' };
        const now = this.now();
        let body = part.body;
        const revised: UiPart[] = [];
        for (const rewrite of rewrites) {
            const self = rewrite.kind === kind && rewrite.name === from;
            const current = this.byName(rewrite.kind, rewrite.name);
            if (current === undefined || !isRevisionCurrent(current.revision, rewrite.expectedRevision)) {
                return { kind: 'conflict', part: { kind: rewrite.kind, name: rewrite.name }, currentRevision: current?.revision ?? 0 };
            }
            if (self) body = structuredClone(rewrite.body) as UiPart['body'];
            else revised.push(reviseUiPart(current, structuredClone(rewrite.body) as UiPart['body'], now));
        }
        const renamed = renameUiPart({ ...part, body }, to, now);
        for (const written of [renamed, ...revised]) this.parts.set(written.id, written);
        names.delete(from);
        names.set(to, renamed.id);
        return { kind: 'renamed', revision: renamed.revision, rewritten: revised.map(({ kind: of, name, revision }) => ({ kind: of, name, revision })) };
    }

    private namesOf(kind: PartKind): Map<string, string> {
        let names = this.names.get(kind);
        if (names === undefined) {
            names = new Map();
            this.names.set(kind, names);
        }
        return names;
    }

    private byName(kind: PartKind, name: string): UiPart | undefined {
        const id = this.namesOf(kind).get(name);
        return id === undefined ? undefined : this.parts.get(id);
    }
}

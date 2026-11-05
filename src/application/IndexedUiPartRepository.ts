import type { PartKind } from '../domain/partName.js';
import type { UiPart, UiPartBodies } from '../domain/UiPart.js';
import type {
    CreateUiPartInput,
    CreateUiPartResult,
    UiPartDeleteResult,
    UiPartRenameResult,
    UiPartRepository,
    UiPartSummary,
    UiPartWriteResult
} from './ports/UiPartRepository.js';
import { UsageIndex } from './UsageIndex.js';

/** A part that was created, written, renamed (its new name) or deleted, after the usage index took the change */
export type PartChangeListener = (kind: PartKind, name: string) => void;

/**
 * A part repository that keeps a `UsageIndex` in step: the index is built from the stored parts at the first call, and
 * every create, write, rename and delete that succeeds updates it, then tells the listeners (`onChange`). Every change
 * of parts goes through this wrapper
 */
export class IndexedUiPartRepository implements UiPartRepository {
    private building: Promise<UsageIndex> | undefined;
    private readonly listeners = new Set<PartChangeListener>();

    constructor(private readonly inner: UiPartRepository) {}

    /** The usage index, built from the stored parts at the first call */
    usage(): Promise<UsageIndex> {
        this.building ??= UsageIndex.build(this.inner).catch((error: unknown) => {
            this.building = undefined;
            throw error;
        });
        return this.building;
    }

    /** Calls `listener` after every change that succeeds; returns the function that stops it. A listener that throws is ignored */
    onChange(listener: PartChangeListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private changed(kind: PartKind, name: string): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(kind, name);
            } catch {
                // a listener's failure is its own; the change is stored
            }
        }
    }

    async create<K extends PartKind>(input: CreateUiPartInput<K>): Promise<CreateUiPartResult<K>> {
        const index = await this.usage();
        const result = await this.inner.create(input);
        if (result.kind === 'created') {
            index.set(input.kind, input.name, result.part.body);
            this.changed(input.kind, input.name);
        }
        return result;
    }

    findByName<K extends PartKind>(kind: K, name: string): Promise<UiPart<K> | undefined> {
        return this.inner.findByName(kind, name);
    }

    findById<K extends PartKind>(kind: K, id: string): Promise<UiPart<K> | undefined> {
        return this.inner.findById(kind, id);
    }

    list(kind: PartKind): Promise<readonly UiPartSummary[]> {
        return this.inner.list(kind);
    }

    async write<K extends PartKind>(kind: K, name: string, body: UiPartBodies[K], expectedRevision: number): Promise<UiPartWriteResult> {
        const index = await this.usage();
        const result = await this.inner.write(kind, name, body, expectedRevision);
        if (result.kind === 'written') {
            index.set(kind, name, body);
            this.changed(kind, name);
        }
        return result;
    }

    async delete(kind: PartKind, name: string, expectedRevision: number): Promise<UiPartDeleteResult> {
        const index = await this.usage();
        const result = await this.inner.delete(kind, name, expectedRevision);
        if (result.kind === 'deleted') {
            index.remove(kind, name);
            this.changed(kind, name);
        }
        return result;
    }

    async rename(kind: PartKind, from: string, to: string): Promise<UiPartRenameResult> {
        const index = await this.usage();
        const result = await this.inner.rename(kind, from, to);
        if (result.kind === 'renamed') {
            index.rename(kind, from, to);
            this.changed(kind, to);
        }
        return result;
    }
}

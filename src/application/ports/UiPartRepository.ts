import type { PartKind } from '../../domain/partName.js';
import type { UiPart, UiPartBodies } from '../../domain/UiPart.js';

/** What a caller supplies to create a part. The id, revision and timestamps come from the adapter */
export interface CreateUiPartInput<K extends PartKind> {
    readonly kind: K;
    readonly name: string;
    readonly body: UiPartBodies[K];
}

/** One row of a part list: no body */
export interface UiPartSummary {
    readonly id: string;
    readonly kind: PartKind;
    readonly name: string;
    readonly revision: number;
    readonly updatedAt: Date;
}

/** A name that is not a slug, or a body that is not a JSON object; `reason` says which */
export interface UiPartInvalid {
    readonly kind: 'invalid';
    readonly reason: string;
}

export type CreateUiPartResult<K extends PartKind> =
    | { readonly kind: 'created'; readonly part: UiPart<K> }
    | { readonly kind: 'duplicate-name' }
    | UiPartInvalid;

/** The outcome of a write. Only `written` changed anything */
export type UiPartWriteResult =
    | { readonly kind: 'written'; readonly revision: number }
    | { readonly kind: 'conflict'; readonly currentRevision: number }
    | { readonly kind: 'not-found' }
    | UiPartInvalid;

export type UiPartDeleteResult =
    | { readonly kind: 'deleted' }
    | { readonly kind: 'conflict'; readonly currentRevision: number }
    | { readonly kind: 'not-found' };

/** A part that names the renamed part, with its new body and the revision its old body was read at */
export interface UiPartRewrite {
    readonly kind: PartKind;
    readonly name: string;
    readonly body: object;
    readonly expectedRevision: number;
}

/** A part a rename wrote, with its new revision */
export interface UiPartRewritten {
    readonly kind: PartKind;
    readonly name: string;
    readonly revision: number;
}

/**
 * The outcome of a rename. Only `renamed` changed anything: the part keeps its id and goes one revision up, and so does
 * each rewritten part. `conflict` names a rewritten part whose revision moved since it was read
 */
export type UiPartRenameResult =
    | { readonly kind: 'renamed'; readonly revision: number; readonly rewritten: readonly UiPartRewritten[] }
    | { readonly kind: 'conflict'; readonly part: { readonly kind: PartKind; readonly name: string }; readonly currentRevision: number }
    | { readonly kind: 'duplicate-name' }
    | { readonly kind: 'not-found' }
    | UiPartInvalid;

/**
 * Storage of the owner's parts, one contract for every kind. A part is found by kind and name, or by its immutable id;
 * names are unique within a kind. Writes and deletes take `expectedRevision`: a stale one returns `conflict` and
 * changes nothing. Bodies keep their key order. The repository checks names and that a body is an object; whether a
 * body is a valid part, and what depends on it, is the use cases' (O2.4). A rename changes the part's name and writes the
 * new bodies of the parts that name it (`rewrites`, which the rename use case computes, O2.5) all together or not at all
 */
export interface UiPartRepository {
    create<K extends PartKind>(input: CreateUiPartInput<K>): Promise<CreateUiPartResult<K>>;
    findByName<K extends PartKind>(kind: K, name: string): Promise<UiPart<K> | undefined>;
    findById<K extends PartKind>(kind: K, id: string): Promise<UiPart<K> | undefined>;
    /** The parts of a kind by name, in name order */
    list(kind: PartKind): Promise<readonly UiPartSummary[]>;
    write<K extends PartKind>(kind: K, name: string, body: UiPartBodies[K], expectedRevision: number): Promise<UiPartWriteResult>;
    delete(kind: PartKind, name: string, expectedRevision: number): Promise<UiPartDeleteResult>;
    rename(kind: PartKind, from: string, to: string, rewrites?: readonly UiPartRewrite[]): Promise<UiPartRenameResult>;
}

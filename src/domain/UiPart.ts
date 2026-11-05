import type { AppBlueprint, ComposedPart, DatasetPart, LogicModule, ModelPart, PatternPart, ThemePart } from '@punyts/stateui-app/core';
import { PART_KINDS, isPartName } from './partName.js';
import type { PartKind } from './partName.js';
import { INITIAL_REVISION, nextRevision } from './revision.js';

/** The body of a part of each kind: what the owner writes, without the storage fields */
export interface UiPartBodies {
    apps: AppBlueprint;
    themes: ThemePart;
    logic: LogicModule;
    models: ModelPart;
    data: DatasetPart;
    components: ComposedPart;
    patterns: PatternPart;
}

/**
 * One part of the owner tree as stored: a body under a name, with an immutable `id` (a UUID the adapter makes; files are
 * named by it, so a rename moves no file) and a revision that rises by one with every committed change
 */
export interface UiPart<K extends PartKind = PartKind> {
    readonly id: string;
    readonly kind: K;
    readonly name: string;
    readonly revision: number;
    readonly body: UiPartBodies[K];
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

/** True for one of `PART_KINDS` */
export function isPartKind(value: unknown): value is PartKind {
    return (PART_KINDS as readonly unknown[]).includes(value);
}

/** Why `name` cannot name a part, or undefined when it can */
export function partNameProblem(name: unknown): string | undefined {
    if (isPartName(name)) return undefined;
    return `"${String(name)}" is not a part name: lower-case letters, digits and dashes, starting with a letter, at most 63 characters`;
}

export interface NewUiPartInput<K extends PartKind> {
    readonly id: string;
    readonly kind: K;
    readonly name: string;
    readonly body: UiPartBodies[K];
    readonly now: Date;
}

/** A new part at `INITIAL_REVISION`; throws a `RangeError` for an unknown kind or a name that is not a slug */
export function createUiPart<K extends PartKind>(input: NewUiPartInput<K>): UiPart<K> {
    if (!isPartKind(input.kind)) throw new RangeError(`Invalid part kind: ${String(input.kind)}`);
    const problem = partNameProblem(input.name);
    if (problem !== undefined) throw new RangeError(problem);
    return { id: input.id, kind: input.kind, name: input.name, revision: INITIAL_REVISION, body: input.body, createdAt: input.now, updatedAt: input.now };
}

/** The part with a new body, one revision up */
export function reviseUiPart<K extends PartKind>(part: UiPart<K>, body: UiPartBodies[K], now: Date): UiPart<K> {
    return { ...part, body, revision: nextRevision(part.revision), updatedAt: now };
}

/** The part under a new name, one revision up; the id stays. Throws a `RangeError` for a name that is not a slug */
export function renameUiPart<K extends PartKind>(part: UiPart<K>, name: string, now: Date): UiPart<K> {
    const problem = partNameProblem(name);
    if (problem !== undefined) throw new RangeError(problem);
    return { ...part, name, revision: nextRevision(part.revision), updatedAt: now };
}

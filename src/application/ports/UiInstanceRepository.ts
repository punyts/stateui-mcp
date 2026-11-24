import type { JsonObject } from '../../domain/JsonValue.js';

/**
 * What one person did in one app, shaped like the library's `AppInstance` (`app`, `screens`, `route`, `theme`,
 * `data`), every part sparse: only the paths that differ from the definition, a removed key as `null`
 */
export type InstanceDiff = JsonObject;

/** The records of one person binding (`uses.data.{binding}` with `scope: "person"`): they belong to the instance */
export interface PersonDataset {
    readonly model: string;
    readonly records: JsonObject;
}

/**
 * A read that never throws at the person using the app: a missing file reads as nothing (a first use), and a file
 * that cannot be read as an instance or a dataset reads as nothing too, with `problem` saying why, for the caller to
 * report
 */
/**
 * How a write is fenced when several servers share the storage: the owner epoch it is made under. A store that keeps
 * epochs refuses a write under an epoch older than the newest one it has seen for the instance (`FencedError`), so a
 * server that lost the instance can no longer save it
 */
export interface InstanceWriteFence {
    readonly epoch?: number;
}

/**
 * An instance whole, for a repository that keeps it as one stored namespace: its diff, the records of its person
 * bindings, and what the authority keeps beside its state (the revision it reached and the change ids it applied)
 */
export interface WholeInstance {
    readonly diff: InstanceDiff;
    readonly datasets: Readonly<Record<string, PersonDataset>>;
    readonly applied: ReadonlyArray<{ id: string; revision: number }>;
    readonly revision: number;
}

export interface InstanceRead<T> {
    readonly value: T;
    readonly problem?: string;
}

/**
 * The instances of one person in one owner's apps, by app id: the diff of each app's state over its definition, and the
 * records of its person bindings. Keyed by the app's id, so a rename of the app keeps them. Nothing here writes a
 * part, and no part write touches an instance
 */
export interface UiInstanceRepository {
    /** The stored diff; `{}` when the person has not used the app */
    get(appId: string): Promise<InstanceRead<InstanceDiff>>;

    /**
     * Stores what differs between the definition's starting state and the current one (`diffInstance`), both shaped
     * like `AppInstance`. An empty diff removes the file. Returns the diff stored
     */
    write(appId: string, definition: JsonObject, current: JsonObject, fence?: InstanceWriteFence): Promise<InstanceDiff>;

    /** The records of one person binding; `undefined` when the person has none yet */
    getData(appId: string, binding: string): Promise<InstanceRead<PersonDataset | undefined>>;

    /** Replaces the records of one person binding. The caller checks them against the model first */
    writeData(appId: string, binding: string, dataset: PersonDataset, fence?: InstanceWriteFence): Promise<void>;

    /** Removes the instance and every person binding's records of the app, so the next read is the definition */
    reset(appId: string): Promise<void>;

    /**
     * The instance whole, in one read. A repository that has this and `saveWhole` keeps each instance as one stored
     * namespace (docs/design/statenet-network.md): a running instance then loads and saves through these two alone
     */
    loadWhole?(appId: string): Promise<InstanceRead<WholeInstance>>;

    /**
     * Stores the instance whole, in one write: the diff of `current` over `definition` as `write` takes them, the
     * records of every person binding, and what the authority keeps beside its state. Returns the diff stored
     */
    saveWhole?(appId: string, definition: JsonObject, current: JsonObject, datasets: Readonly<Record<string, PersonDataset>>, kept: Pick<WholeInstance, 'applied' | 'revision'>, fence?: InstanceWriteFence): Promise<InstanceDiff>;
}

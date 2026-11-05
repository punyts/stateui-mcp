import type { JsonObject } from '../../domain/JsonValue.js';

/**
 * What one persona did in one app, shaped like the library's `AppInstance` (`app`, `screens`, `route`, `theme`,
 * `data`), every part sparse: only the paths that differ from the definition, a removed key as `null`
 */
export type InstanceDiff = JsonObject;

/** The records of one persona binding (`uses.data.{binding}` with `scope: "persona"`): they belong to the instance */
export interface PersonaDataset {
    readonly model: string;
    readonly records: JsonObject;
}

/**
 * A read that never throws at the person using the app: a missing file reads as nothing (a first use), and a file
 * that cannot be read as an instance or a dataset reads as nothing too, with `problem` saying why, for the caller to
 * report
 */
export interface InstanceRead<T> {
    readonly value: T;
    readonly problem?: string;
}

/**
 * The instances of one owner's default persona, by app id: the diff of each app's state over its definition, and the
 * records of its persona bindings. Keyed by the app's id, so a rename of the app keeps them. Nothing here writes a
 * part, and no part write touches an instance
 */
export interface UiInstanceRepository {
    /** The stored diff; `{}` when the persona has not used the app */
    get(appId: string): Promise<InstanceRead<InstanceDiff>>;

    /**
     * Stores what differs between the definition's starting state and the current one (`diffInstance`), both shaped
     * like `AppInstance`. An empty diff removes the file. Returns the diff stored
     */
    write(appId: string, definition: JsonObject, current: JsonObject): Promise<InstanceDiff>;

    /** The records of one persona binding; `undefined` when the persona has none yet */
    getData(appId: string, binding: string): Promise<InstanceRead<PersonaDataset | undefined>>;

    /** Replaces the records of one persona binding. The caller checks them against the model first */
    writeData(appId: string, binding: string, dataset: PersonaDataset): Promise<void>;

    /** Removes the instance and every persona binding's records of the app, so the next read is the definition */
    reset(appId: string): Promise<void>;
}

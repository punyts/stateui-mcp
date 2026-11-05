import type { JsonObject, JsonValue } from '../../domain/JsonValue.js';
import type { UiDocument } from '../../domain/UiApp.js';
import type { UiPart } from '../../domain/UiPart.js';

/** What a key of `uses.data` binds: a shared dataset (a part) or the persona's own records of a model */
export type BindingScope = 'shared' | 'persona';

/** What a running instance is made of: the assembled document and the scope of each data binding */
export interface InstanceShape {
    /** The app assembled from its parts: shell (`app`), `screens`, `start`, `data` (by binding), the bound `logic` */
    readonly document: UiDocument;
    readonly bindings: Readonly<Record<string, BindingScope>>;
}

export interface InstanceWriteOptions {
    /** False writes the value as it is: no guard asks and no rule fires. Default true */
    readonly logic?: boolean;
}

/**
 * The running instances of owner apps, for the default persona: one state-sync authority each, whose state is the
 * assembled view (`$.app` and `$.screens` sparse, `$.route`, `$.data` by binding) with the persona's instance laid
 * over it. The app is given as its part, so the caller has read it (and its revision) once
 */
export interface InstanceStates {
    /** Assembles the app as its instance runs it */
    shape(app: UiPart<'apps'>): Promise<InstanceShape>;

    /** A tool's write to the instance: asked of the guards, written, and seen by the logic. The reason when a guard refused it */
    write(app: UiPart<'apps'>, path: string, value: JsonValue | undefined, options?: InstanceWriteOptions): Promise<string | undefined>;

    /** A copy of the instance's state */
    state(app: UiPart<'apps'>): Promise<JsonObject>;

    /**
     * Stops the app's running instance, if one runs: its views' sockets close and its state is saved. `whileStopped`
     * runs before anything can start it again (a reset removes the saved instance there), so the next use starts over
     * what is stored then
     */
    stop(app: UiPart<'apps'>, whileStopped: () => Promise<void>): Promise<void>;
}

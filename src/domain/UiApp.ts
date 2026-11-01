import type { JsonObject } from './JsonValue.js';

/** A StateUI application document: the `app` tree plus optional `composed`, `data`, `locales` and theme keys */
export type UiDocument = JsonObject;

/** The latest runtime state the preview reported: `$.data` and articulation values */
export type UiStateSnapshot = JsonObject;

/** A minion-built application, stored as one folder on disk */
export interface UiApp {
    readonly id: string;
    readonly name: string;
    /** Starts at `INITIAL_REVISION` and rises by one with every committed write (see `revision.ts`) */
    readonly revision: number;
    readonly document: UiDocument;
    readonly stateSnapshot: UiStateSnapshot;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

/** An empty valid document: a single `page` root */
export function createEmptyDocument(): UiDocument {
    return { app: { component: 'page' } };
}

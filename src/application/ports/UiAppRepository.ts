import type { JsonValue } from '../../domain/JsonValue.js';
import type { UiApp, UiDocument } from '../../domain/UiApp.js';

/** What a caller supplies to create an app. The id, revision and timestamps come from the adapter */
export interface CreateUiAppInput {
    readonly name: string;
    readonly document: UiDocument;
}

/** One row of the app list: no document, no state */
export interface UiAppSummary {
    readonly id: string;
    readonly name: string;
    readonly revision: number;
    readonly updatedAt: Date;
}

export type CreateUiAppResult =
    | { readonly kind: 'created'; readonly app: UiApp }
    | { readonly kind: 'duplicate-name' };

/** The outcome of a write. Only `written` changed anything */
export type UiAppWriteResult =
    | { readonly kind: 'written'; readonly revision: number }
    | { readonly kind: 'conflict'; readonly currentRevision: number }
    | { readonly kind: 'not-found' };

export type UiAppDeleteResult =
    | { readonly kind: 'deleted' }
    | { readonly kind: 'conflict'; readonly currentRevision: number }
    | { readonly kind: 'not-found' };

/**
 * Storage of apps. Writes take `expectedRevision`: a stale one returns `conflict` and changes nothing. The revision
 * counts document writes. The state (`stateSnapshot` of a found app) is the app's synced state, which the open views
 * change too, so a state write does not raise the revision. Documents and states keep their key order
 */
export interface UiAppRepository {
    create(input: CreateUiAppInput): Promise<CreateUiAppResult>;
    findById(appId: string): Promise<UiApp | undefined>;
    list(): Promise<readonly UiAppSummary[]>;
    writeDocument(appId: string, document: UiDocument, expectedRevision: number): Promise<UiAppWriteResult>;
    /**
     * Sets one value of the state, at `statePath` from its root (`['data', 'total']`), creating missing parents. Every
     * open view gets the change at once. The revision stays as it is; `written` carries it
     */
    writeState(appId: string, statePath: readonly string[], value: JsonValue, expectedRevision: number): Promise<UiAppWriteResult>;
    /** Removes the app folder: document, state, error log and files */
    delete(appId: string, expectedRevision: number): Promise<UiAppDeleteResult>;
}

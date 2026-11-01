import type { UiApp, UiDocument, UiStateSnapshot } from '../../domain/UiApp.js';

/** What a caller supplies to create an app. The id, revision and timestamps come from the adapter */
export interface CreateUiAppInput {
    readonly name: string;
    readonly document: UiDocument;
}

/** One row of the app list: no document, no snapshot */
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
 * Storage of apps. Writes take `expectedRevision`: a stale one returns `conflict` and changes nothing. A committed
 * write raises the revision by one. Documents and snapshots keep their key order
 */
export interface UiAppRepository {
    create(input: CreateUiAppInput): Promise<CreateUiAppResult>;
    findById(appId: string): Promise<UiApp | undefined>;
    list(): Promise<readonly UiAppSummary[]>;
    writeDocument(appId: string, document: UiDocument, expectedRevision: number): Promise<UiAppWriteResult>;
    writeStateSnapshot(appId: string, snapshot: UiStateSnapshot, expectedRevision: number): Promise<UiAppWriteResult>;
    /**
     * Stores the state snapshot a preview reports. Unlike `writeStateSnapshot` it does NOT raise the revision:
     * the revision counts document and tool writes, and `expectedRevision` is the revision the preview rendered.
     * A tool write since then makes it stale: `conflict` with the current revision, nothing stored, so a snapshot
     * older than the latest tool write loses. Snapshots among themselves are last-writer-wins
     */
    savePreviewSnapshot(appId: string, snapshot: UiStateSnapshot, expectedRevision: number): Promise<UiAppWriteResult>;
    /** Removes the app folder: document, state, error log and files */
    delete(appId: string, expectedRevision: number): Promise<UiAppDeleteResult>;
}

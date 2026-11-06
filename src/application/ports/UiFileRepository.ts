import type { UiFile } from '../../domain/UiFile.js';

/** What a caller supplies to add a file entry. The id is chosen by the use case, because the bytes are stored first */
export interface AddUiFileInput {
    readonly id: string;
    readonly appId: string;
    readonly name: string;
    readonly size: number;
    readonly type: string;
    readonly sha256: string;
}

export type AddUiFileResult =
    | { readonly kind: 'added'; readonly file: UiFile }
    | { readonly kind: 'quota'; readonly reason: 'files' | 'bytes' }
    | { readonly kind: 'not-found' };

/** What `deleteUnlessReferenced` did: removed the row, kept it because something references it, or found no such file */
export type ReleaseUiFileOutcome = 'deleted' | 'referenced' | 'not-found';

/** How much of its quota an app uses */
export interface UiFileUsage {
    readonly count: number;
    readonly bytes: number;
}

/** Metadata of the files of an app. `add` checks the app and both quotas under one lock */
export interface UiFileRepository {
    appExists(appId: string): Promise<boolean>;
    usage(appId: string): Promise<UiFileUsage>;
    add(input: AddUiFileInput): Promise<AddUiFileResult>;
    findById(appId: string, fileId: string): Promise<UiFile | undefined>;
    /** Newest first */
    list(appId: string): Promise<readonly UiFile[]>;
    /** Files uploaded before `olderThan`, whether or not anything references them */
    findOlderThan(appId: string, olderThan: Date): Promise<readonly UiFile[]>;
    deleteByIds(appId: string, fileIds: readonly string[]): Promise<void>;
    /**
     * Removes the row of one file unless `isReferenced` answers true. The check and the removal run under the per-app
     * lock of `add` and `deleteByIds`, so no other change to the app's files comes between them. A file the app does not
     * have is `not-found` and the check is not run
     */
    deleteUnlessReferenced(appId: string, fileId: string, isReferenced: () => Promise<boolean>): Promise<ReleaseUiFileOutcome>;
}

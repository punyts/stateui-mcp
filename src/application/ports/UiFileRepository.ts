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
    /** Files uploaded before `olderThan` whose id is in neither the app's state snapshot nor its document */
    findUnreferenced(appId: string, olderThan: Date): Promise<readonly UiFile[]>;
    deleteByIds(appId: string, fileIds: readonly string[]): Promise<void>;
}

import type { Readable } from 'node:stream';

/** The outcome of saving bytes */
export type SaveFileResult =
    | {
          readonly kind: 'saved';
          readonly size: number;
          readonly sha256: string;
          /** The first bytes (at most 4 KiB), for the magic-number check */
          readonly head: Uint8Array;
      }
    | { readonly kind: 'too-large' };

/** Where the bytes of uploaded files live: one file per id in the folder of the app. A file name is never in a path */
export interface UiFileStore {
    /** Streams `content` through a temporary file renamed when complete; more than `maxBytes` is `too-large` and stores nothing */
    save(appId: string, fileId: string, content: AsyncIterable<Uint8Array>, maxBytes: number): Promise<SaveFileResult>;
    /** The stream of the stored bytes, or `undefined` when there are none */
    open(appId: string, fileId: string): Promise<Readable | undefined>;
    /** The whole stored file. Files are at most `MAX_FILE_BYTES` */
    read(appId: string, fileId: string): Promise<Uint8Array>;
    remove(appId: string, fileId: string): Promise<void>;
}

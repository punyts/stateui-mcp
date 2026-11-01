import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import type { SaveFileResult, UiFileStore } from '../../application/ports/UiFileStore.js';
import type { AppFolders } from './AppFolders.js';
import { isMissing } from './atomicFile.js';

const HEAD_BYTES = 4096;

/**
 * Keeps file bytes in `<appFolder>/files/<fileId>`. `AppFolders` accepts UUIDs only, so no name or other input can
 * leave the folder. Bytes go to `<path>.part` and are renamed when complete, so a reader never sees half a file
 */
export class FsUiFileStore implements UiFileStore {
    constructor(private readonly folders: AppFolders) {}

    async save(appId: string, fileId: string, content: AsyncIterable<Uint8Array>, maxBytes: number): Promise<SaveFileResult> {
        const target = this.folders.fileBytes(appId, fileId);
        const partial = `${target}.part`;
        await mkdir(dirname(target), { recursive: true });
        const handle = await open(partial, 'w');
        const hash = createHash('sha256');
        const head = new Uint8Array(HEAD_BYTES);
        let size = 0;
        let exceeded = false;
        try {
            for await (const chunk of content) {
                if (exceeded) continue;
                if (size + chunk.length > maxBytes) {
                    exceeded = true;
                    continue;
                }
                if (size < HEAD_BYTES) head.set(chunk.subarray(0, HEAD_BYTES - size), size);
                hash.update(chunk);
                size += chunk.length;
                await handle.write(chunk);
            }
        } catch (error) {
            await handle.close();
            await rm(partial, { force: true });
            throw error;
        }
        await handle.close();
        if (exceeded) {
            await rm(partial, { force: true });
            return { kind: 'too-large' };
        }
        await rename(partial, target);
        return { kind: 'saved', size, sha256: hash.digest('hex'), head: head.slice(0, Math.min(size, HEAD_BYTES)) };
    }

    async open(appId: string, fileId: string): Promise<Readable | undefined> {
        const path = this.folders.fileBytes(appId, fileId);
        try {
            await stat(path);
        } catch (error) {
            if (isMissing(error)) return undefined;
            throw error;
        }
        return createReadStream(path);
    }

    async read(appId: string, fileId: string): Promise<Uint8Array> {
        return readFile(this.folders.fileBytes(appId, fileId));
    }

    async remove(appId: string, fileId: string): Promise<void> {
        await rm(this.folders.fileBytes(appId, fileId), { force: true });
    }
}

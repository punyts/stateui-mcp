/**
 * The live view page's side of a file release (`fileRelease` from the runtime, answered with `fileReleased`). It runs
 * in the page and sends `DELETE /apps/:appId/files/:fileId` to the page's own origin, which the page policy allows
 * (`connect-src 'self'`); the frame itself never fetches. `host.ts` bundles it.
 */

import { isFileId } from './fileRead.js';
import type { FileFetch } from './fileRead.js';

/** The failure codes of a release, a subset of the runtime's `FILE_ERROR_CODES` */
export type FileReleaseCode = 'offline' | 'internal';

/** What the host posts back as the fields of `fileReleased` (beside `requestId`) */
export type FileReleaseOutcome = { ok: true } | { ok: false; code: FileReleaseCode; message: string };

/**
 * Releases a stored file of the app for the runtime. The answer is `ok: true` for `204` (removed), for `404` (no such
 * file: released before, swept, or never stored, so a release is idempotent) and for `409` (the app or its live state
 * still references the file; it stays and the server's sweep removes it once nothing does). An id that is not a UUID
 * names no stored file, so it is `ok: true` without a request. A request that does not reach the server is `offline`,
 * any other status `internal`. It never throws
 */
export async function releaseStoredFile(appId: string, id: unknown, fetcher: FileFetch): Promise<FileReleaseOutcome> {
    if (!isFileId(id)) return { ok: true };
    let response: Response;
    try {
        response = await fetcher(`/apps/${encodeURIComponent(appId)}/files/${id}`, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' });
    } catch {
        return { ok: false, code: 'offline', message: 'The server could not be reached' };
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 204 || response.status === 404 || response.status === 409) return { ok: true };
    return { ok: false, code: 'internal', message: `The release was refused (${response.status})` };
}

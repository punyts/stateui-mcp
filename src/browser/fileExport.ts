/**
 * The live view page's side of a CSV export (`fileExport` from the runtime, answered with `fileExported`). It runs in
 * the page and sends `POST /apps/:appId/export` to the page's own origin with the grid's settings, never rows; the
 * authority builds the file from the persona's own instance. The page then hands the file to the browser to save: the
 * frame is sandboxed without `allow-downloads`, so it could not. `host.ts` bundles it.
 */

import type { FileFetch } from './fileRead.js';

/** The failure codes of an export, a subset of the runtime's `FILE_ERROR_CODES` */
export type FileExportCode = 'too_large' | 'not_found' | 'unauthorized' | 'offline' | 'internal';

/** What the host posts back as the fields of `fileExported` (beside `requestId`) */
export type FileExportOutcome = { ok: true; rows: number } | { ok: false; code: FileExportCode; message: string };

/** Hands a file to the browser to save under a name */
export type SaveFile = (file: Blob, name: string) => void;

/** Saves a file through a link with `download`, in the page; the object URL is let go a moment later */
export const saveWithLink: SaveFile = (file, name) => {
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

const codeOf = (status: number): FileExportCode => {
    if (status === 413) return 'too_large';
    if (status === 404) return 'not_found';
    if (status === 401 || status === 403) return 'unauthorized';
    return 'internal';
};

/**
 * Asks the server for the CSV of the runtime's `fileExport` (`source`, `name`, `request`) and saves it. `200` saves the
 * file and answers the rows the server wrote; a request that does not reach the server is `offline`; `413`, `404`,
 * `401`/`403` and any other status map to `too_large`, `not_found`, `unauthorized` and `internal`. It never throws
 */
export async function exportRecordsFile(appId: string, message: { source: unknown; name: unknown; request: unknown }, fetcher: FileFetch, save: SaveFile = saveWithLink): Promise<FileExportOutcome> {
    const { source, name, request } = message;
    if (typeof name !== 'string') return { ok: false, code: 'internal', message: 'The export has no file name' };
    let response: Response;
    try {
        response = await fetcher(`/apps/${encodeURIComponent(appId)}/export`, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source, name, request })
        });
    } catch {
        return { ok: false, code: 'offline', message: 'The server could not be reached' };
    }
    if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, code: codeOf(response.status), message: `The export was refused (${response.status})` };
    }
    let file: Blob;
    try {
        file = await response.blob();
    } catch {
        return { ok: false, code: 'offline', message: 'The file did not arrive' };
    }
    save(file, name);
    const rows = Number(response.headers.get('X-Export-Rows'));
    return { ok: true, rows: Number.isInteger(rows) && rows >= 0 ? rows : 0 };
}

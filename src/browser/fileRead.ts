/**
 * The live view page's side of a file read (`fileRead` from the runtime, answered with `fileData`). It runs in the page
 * and fetches `GET /apps/:appId/files/:fileId` from the page's own origin, which the page policy allows
 * (`connect-src 'self'`); the frame itself never fetches. No imports: `host.ts` bundles it.
 */

/** Largest file a read hands to the runtime (10 MiB), the runtime's `MAX_FILE_BYTES` */
export const MAX_READ_BYTES = 10 * 1024 * 1024;

/** The form of a file id: a UUID, the only form the file store gives */
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The failure codes of a read, a subset of the runtime's `FILE_ERROR_CODES` */
export type FileReadCode = 'not_found' | 'unauthorized' | 'offline' | 'too_large' | 'internal';

/** What the host posts back as the fields of `fileData` (beside `requestId`) */
export type FileReadOutcome =
    | { ok: true; file: { id: string; name: string; size: number; type: string }; data: ArrayBuffer }
    | { ok: false; code: FileReadCode; message: string };

/** The fetch a read uses; the page's `fetch` in the host, a fake in tests */
export type FileFetch = (url: string, init: RequestInit) => Promise<Response>;

/** True for an id of the file store's form, which a read checks before it makes a request */
export function isFileId(value: unknown): value is string {
    return typeof value === 'string' && FILE_ID.test(value);
}

/** The code of a refused read for the HTTP status of the download route: 404 `not_found`, 401 and 403 `unauthorized`, anything else `internal` */
export function fileReadCode(status: number): FileReadCode {
    if (status === 404) return 'not_found';
    if (status === 401 || status === 403) return 'unauthorized';
    return 'internal';
}

/** The file name of a `Content-Disposition` (`filename*=UTF-8''…` as the server writes it, or `filename="…"`); `file` when there is none */
export function dispositionName(header: string | null): string {
    const extended = header?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    if (extended !== undefined) {
        try {
            const name = decodeURIComponent(extended.trim());
            if (name.length > 0) return name;
        } catch {
            // falls through to the plain name
        }
    }
    const plain = header?.match(/filename="([^"]*)"/i)?.[1];
    return plain !== undefined && plain.length > 0 ? plain : 'file';
}

function failed(code: FileReadCode, message: string): FileReadOutcome {
    return { ok: false, code, message };
}

/** Reads the body up to `MAX_READ_BYTES`; undefined when it is longer, after cancelling the rest */
async function readCapped(response: Response): Promise<ArrayBuffer | undefined> {
    const body = response.body;
    if (body === null) {
        const whole = await response.arrayBuffer();
        return whole.byteLength > MAX_READ_BYTES ? undefined : whole;
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_READ_BYTES) {
            await reader.cancel().catch(() => undefined);
            return undefined;
        }
        chunks.push(value);
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return data.buffer;
}

/**
 * Reads a stored file of the app for the runtime. An id that is not a UUID is `not_found` without a request; a refused
 * request maps its status with `fileReadCode`; a request that does not reach the server is `offline`; a body over
 * `MAX_READ_BYTES` (by `Content-Length` or as it streams) is cut off and `too_large`. The reference carries the
 * requested id, the name of `Content-Disposition`, the bare media type of `Content-Type` and the size of the bytes
 */
export async function readStoredFile(appId: string, id: unknown, fetcher: FileFetch): Promise<FileReadOutcome> {
    if (!isFileId(id)) return failed('not_found', 'A file id is a UUID');
    let response: Response;
    try {
        response = await fetcher(`/apps/${encodeURIComponent(appId)}/files/${id}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    } catch {
        return failed('offline', 'The server could not be reached');
    }
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return failed(fileReadCode(response.status), `The read was refused (${response.status})`);
    }
    const length = Number(response.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(length) && length > MAX_READ_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        return failed('too_large', 'The file is larger than 10 MiB');
    }
    let data: ArrayBuffer | undefined;
    try {
        data = await readCapped(response);
    } catch {
        return failed('offline', 'The connection broke while reading the file');
    }
    if (data === undefined) return failed('too_large', 'The file is larger than 10 MiB');
    const type = (response.headers.get('content-type')?.split(';')[0] ?? '').trim().toLowerCase();
    // The runtime's protocol takes names of at most 255 and types of at most 127 characters
    const name = dispositionName(response.headers.get('content-disposition')).slice(0, 255);
    return { ok: true, file: { id, name, size: data.byteLength, type: type.slice(0, 127) }, data };
}

import { describe, expect, it, vi } from 'vitest';
import { MAX_FILE_BYTES } from '../src/domain/UiFile.js';
import { MAX_READ_BYTES, dispositionName, fileReadCode, isFileId, readStoredFile } from '../src/browser/fileRead.js';
import type { FileFetch } from '../src/browser/fileRead.js';

const APP = '5f0c2b8e-1d4a-4c3b-9e2f-0a1b2c3d4e5f';
const ID = '0b6e8c1a-3f1e-4a52-9a43-2f4f1c8f2d10';

function fetchWith(response: () => Response | Promise<Response>) {
    return vi.fn<FileFetch>(async () => response());
}

/** A body that streams `chunks` chunks of `size` bytes and gives no Content-Length */
function streamed(chunks: number, size: number): Response {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (sent === chunks) controller.close();
            else {
                sent += 1;
                controller.enqueue(new Uint8Array(size));
            }
        }
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });
}

describe('the live view host reading a file for the runtime', () => {
    it('should keep the 10 MiB limit of the file store', () => {
        expect(MAX_READ_BYTES).toBe(MAX_FILE_BYTES);
    });

    it.each([
        [404, 'not_found'],
        [401, 'unauthorized'],
        [403, 'unauthorized'],
        [400, 'internal'],
        [500, 'internal'],
        [503, 'internal']
    ])('should map the status %i to %s', async (status, code) => {
        // Arrange
        const fetcher = fetchWith(() => new Response('{"error":"x"}', { status }));

        // Act
        const outcome = await readStoredFile(APP, ID, fetcher);

        // Assert
        expect(fileReadCode(status)).toBe(code);
        expect(outcome).toMatchObject({ ok: false, code });
    });

    it('should answer offline when the request does not reach the server', async () => {
        // Arrange
        const fetcher = vi.fn<FileFetch>(() => Promise.reject(new TypeError('Failed to fetch')));

        // Act
        const outcome = await readStoredFile(APP, ID, fetcher);

        // Assert
        expect(outcome).toMatchObject({ ok: false, code: 'offline' });
    });

    it.each([['not-a-uuid'], ['../files'], [''], [42], [undefined]])('should answer not_found for the id %j without a request', async (id) => {
        // Arrange
        const fetcher = fetchWith(() => new Response('x'));

        // Act
        const outcome = await readStoredFile(APP, id, fetcher);

        // Assert
        expect(outcome).toMatchObject({ ok: false, code: 'not_found' });
        expect(fetcher).not.toHaveBeenCalled();
        expect(isFileId(id)).toBe(false);
    });

    it('should fetch the download route of the page origin and answer the reference and the bytes', async () => {
        // Arrange
        const fetcher = fetchWith(
            () =>
                new Response(new Uint8Array([1, 2, 3]), {
                    status: 200,
                    headers: { 'content-type': 'image/png', 'content-length': '3', 'content-disposition': "attachment; filename*=UTF-8''plan%20%C3%A9.png" }
                })
        );

        // Act
        const outcome = await readStoredFile(APP, ID.toUpperCase(), fetcher);

        // Assert
        expect(fetcher).toHaveBeenCalledWith(`/apps/${APP}/files/${ID.toUpperCase()}`, expect.objectContaining({ method: 'GET', credentials: 'same-origin' }));
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.file).toEqual({ id: ID.toUpperCase(), name: 'plan é.png', size: 3, type: 'image/png' });
        expect([...new Uint8Array(outcome.data)]).toEqual([1, 2, 3]);
    });

    it('should answer too_large for a Content-Length over 10 MiB without reading the body', async () => {
        // Arrange
        const response = new Response(new Uint8Array(1), { status: 200, headers: { 'content-length': String(MAX_READ_BYTES + 1) } });
        const arrayBuffer = vi.spyOn(response, 'arrayBuffer');

        // Act
        const outcome = await readStoredFile(APP, ID, fetchWith(() => response));

        // Assert
        expect(outcome).toMatchObject({ ok: false, code: 'too_large' });
        expect(arrayBuffer).not.toHaveBeenCalled();
    });

    it('should cut off a streamed body that grows past 10 MiB and answer too_large', async () => {
        // Arrange
        const chunk = 1024 * 1024;

        // Act
        const over = await readStoredFile(APP, ID, fetchWith(() => streamed(11, chunk)));
        const exact = await readStoredFile(APP, ID, fetchWith(() => streamed(10, chunk)));

        // Assert
        expect(over).toMatchObject({ ok: false, code: 'too_large' });
        expect(exact.ok && exact.data.byteLength).toBe(MAX_READ_BYTES);
    });

    it('should read the name of a Content-Disposition, or fall back to file', () => {
        expect(dispositionName("attachment; filename*=UTF-8''a%28b%29.png")).toBe('a(b).png');
        expect(dispositionName('attachment; filename="c.png"')).toBe('c.png');
        expect(dispositionName("attachment; filename*=UTF-8''%E0%A4%A")).toBe('file');
        expect(dispositionName(null)).toBe('file');
    });
});

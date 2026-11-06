import { describe, expect, it, vi } from 'vitest';
import type { FileFetch } from '../src/browser/fileRead.js';
import { releaseStoredFile } from '../src/browser/fileRelease.js';

const APP = '5f0c2b8e-1d4a-4c3b-9e2f-0a1b2c3d4e5f';
const ID = '0b6e8c1a-3f1e-4a52-9a43-2f4f1c8f2d10';

function fetchWith(response: () => Response | Promise<Response>) {
    return vi.fn<FileFetch>(async () => response());
}

describe('the live view host releasing a file for the runtime', () => {
    it('should send DELETE to the file route of the page origin and answer ok for 204', async () => {
        // Arrange
        const fetcher = fetchWith(() => new Response(null, { status: 204 }));

        // Act
        const outcome = await releaseStoredFile(APP, ID, fetcher);

        // Assert
        expect(outcome).toEqual({ ok: true });
        expect(fetcher).toHaveBeenCalledWith(`/apps/${APP}/files/${ID}`, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' });
    });

    it.each([
        [404, 'a file released before or swept'],
        [409, 'a file the app or its live state still references, left for the sweep']
    ])('should answer ok for %i (%s)', async (status) => {
        // Arrange
        const fetcher = fetchWith(() => new Response('{"error":"x"}', { status }));

        // Act
        const outcome = await releaseStoredFile(APP, ID, fetcher);

        // Assert
        expect(outcome).toEqual({ ok: true });
    });

    it.each([[400], [403], [500], [503]])('should answer internal for %i', async (status) => {
        // Arrange
        const fetcher = fetchWith(() => new Response('{"error":"x"}', { status }));

        // Act
        const outcome = await releaseStoredFile(APP, ID, fetcher);

        // Assert
        expect(outcome).toMatchObject({ ok: false, code: 'internal' });
    });

    it('should answer offline when the request does not reach the server, without throwing', async () => {
        // Arrange
        const fetcher = vi.fn<FileFetch>(() => Promise.reject(new TypeError('Failed to fetch')));

        // Act
        const outcome = await releaseStoredFile(APP, ID, fetcher);

        // Assert
        expect(outcome).toMatchObject({ ok: false, code: 'offline' });
    });

    it.each([['not-a-uuid'], ['../files'], [''], [42], [undefined]])('should answer ok for the id %j without a request, as it names no stored file', async (id) => {
        // Arrange
        const fetcher = fetchWith(() => new Response(null, { status: 204 }));

        // Act
        const outcome = await releaseStoredFile(APP, id, fetcher);

        // Assert
        expect(outcome).toEqual({ ok: true });
        expect(fetcher).not.toHaveBeenCalled();
    });
});

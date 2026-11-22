import { describe, expect, it, vi } from 'vitest';
import type { FileFetch } from '../src/browser/fileRead.js';
import { exportRecordsFile } from '../src/browser/fileExport.js';

const APP = '5f0c2b8e-1d4a-4c3b-9e2f-0a1b2c3d4e5f';
const MESSAGE = { source: '$.data.people', name: 'People.csv', request: { columns: [{ key: 'name', field: 'name', title: 'Name' }] } };

describe('the live view host exporting records for the runtime', () => {
    it('should POST the settings to the export route of the page origin, save the file and answer the rows', async () => {
        // Arrange
        const fetcher = vi.fn<FileFetch>(async () => new Response('Name\r\nAda\r\n', { status: 200, headers: { 'X-Export-Rows': '1' } }));
        const save = vi.fn<(file: Blob, name: string) => void>();

        // Act
        const outcome = await exportRecordsFile(APP, MESSAGE, fetcher, save);

        // Assert
        expect(outcome).toEqual({ ok: true, rows: 1 });
        expect(fetcher).toHaveBeenCalledWith(`/apps/${APP}/export`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(MESSAGE) });
        expect(save.mock.calls[0]?.[1]).toBe('People.csv');
        expect(await save.mock.calls[0]?.[0].text()).toBe('Name\r\nAda\r\n');
    });

    it.each([
        [413, 'too_large'],
        [404, 'not_found'],
        [403, 'unauthorized'],
        [500, 'internal']
    ])('should save nothing and answer the code of a %i', async (status, code) => {
        // Arrange
        const save = vi.fn<(file: Blob, name: string) => void>();

        // Act
        const outcome = await exportRecordsFile(APP, MESSAGE, vi.fn<FileFetch>(async () => new Response('{}', { status })), save);

        // Assert
        expect(outcome).toMatchObject({ ok: false, code });
        expect(save).not.toHaveBeenCalled();
    });

    it('should answer offline when the request does not reach the server', async () => {
        // Act
        const outcome = await exportRecordsFile(APP, MESSAGE, vi.fn<FileFetch>(async () => Promise.reject(new TypeError('down'))), vi.fn());

        // Assert
        expect(outcome).toMatchObject({ ok: false, code: 'offline' });
    });
});

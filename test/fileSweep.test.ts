import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startStatenet } from '@punyts/statenet';
import type { RunningStatenet } from '@punyts/statenet';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { UNREFERENCED_FILE_GRACE_MS } from '../src/domain/UiFile.js';
import { StatenetClient } from '../src/infrastructure/sync/statenetClient.js';
import { call, FORM_DOCUMENT, httpHarness, tempData } from './helpers.js';
import type { HttpHarness, TempData } from './helpers.js';

/*
 * Graphics story G2.5a: does the file sweep delete a file that only live state holds?
 *
 * A file is uploaded, then referenced only by a value a running view (or a page of a Persisted app) set, never by
 * the document or a tool write. Its upload time is moved back past the grace period (`files.json` is rewritten, so
 * the test waits for no clock), and a second upload runs the sweep. The file must still be there.
 *
 * Before the fix (Nov 2026) the sweep searched only `app.json` and `state.json`, so with a statenet (where no
 * `state.json` is written) and for Persisted apps it deleted such a file. It now reads the state through the app
 * repository, the same state `ui_state_get` returns, in every mode.
 */

const VIEW = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

async function eventually<T>(read: () => T | Promise<T>, check: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (check(value)) return value;
        if (Date.now() > deadline) throw new Error(`Timed out; last value: ${JSON.stringify(value)}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

async function upload(origin: string, appId: string, bytes: Buffer, name: string): Promise<{ id: string; name: string; size: number; type: string }> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)]), name);
    const response = await fetch(`${origin}/apps/${appId}/files`, { method: 'POST', body: form });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string; name: string; size: number; type: string };
}

/** Moves every file of the app back past the grace period, as if a day had passed */
async function ageFiles(dataDir: string, appId: string): Promise<void> {
    const index = join(dataDir, appId.toLowerCase(), 'files.json');
    const entries = JSON.parse(await readFile(index, 'utf8')) as { createdAt: string }[];
    const old = new Date(Date.now() - UNREFERENCED_FILE_GRACE_MS - 60_000).toISOString();
    await writeFile(index, JSON.stringify(entries.map((entry) => ({ ...entry, createdAt: old }))));
}

/** A view's socket to the server, after its hello */
async function openView(origin: string, appId: string): Promise<WebSocket> {
    const socket = new WebSocket(`${origin.replace('http', 'ws')}/apps/${appId}/sync?view=${VIEW}&kind=browser`, { headers: { Origin: origin } });
    const frames: Record<string, unknown>[] = [];
    socket.on('message', (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
    await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'hello', namespace: `apps.${appId.toLowerCase()}`, revision: 0, clientId: VIEW, protocol: 1 }));
    await eventually(() => frames, (all) => all.some((frame) => frame['type'] === 'welcome' || frame['type'] === 'snapshot'));
    return socket;
}

describe('the file sweep and files held only in live state (G2.5a)', () => {
    let data: TempData | undefined;
    let statenetData: TempData | undefined;
    let statenet: RunningStatenet | undefined;
    let harness: HttpHarness | undefined;
    const closers: (() => void)[] = [];

    afterEach(async () => {
        for (const close of closers.splice(0)) close();
        await harness?.close();
        await statenet?.close();
        await data?.cleanup();
        await statenetData?.cleanup();
        harness = undefined;
        statenet = undefined;
        data = undefined;
        statenetData = undefined;
    });

    async function start(withStatenet: boolean): Promise<HttpHarness> {
        data = await tempData();
        if (withStatenet) {
            statenetData = await tempData();
            statenet = await startStatenet({ port: 0, dataDir: statenetData.dir });
        }
        harness = await httpHarness(data.dir, undefined, statenet === undefined ? {} : { statenet: statenet.url });
        return harness;
    }

    async function createApp(running: HttpHarness, sync?: 'persisted'): Promise<string> {
        const created = await call(running.client, 'ui_app_create', { name: 'Sweep', document: FORM_DOCUMENT, ...(sync !== undefined && { sync }) });
        expect(created.isError).toBe(false);
        return created.body['appId'] as string;
    }

    /** Waits until the server's state of the app carries the file id */
    async function heldLive(running: HttpHarness, appId: string, fileId: string): Promise<void> {
        await eventually(
            () => call(running.client, 'ui_state_get', { appId }),
            (result) => JSON.stringify(result.body['state'] ?? {}).includes(fileId)
        );
    }

    /** Ages the files, uploads another one (which sweeps) and answers whether the first file is still served */
    async function sweepAndCheck(running: HttpHarness, appId: string, fileId: string): Promise<number> {
        await ageFiles(data!.dir, appId);
        await upload(running.server.origin, appId, Buffer.from('trigger'), 'trigger.txt');
        return (await fetch(`${running.server.origin}/apps/${appId}/files/${fileId}`)).status;
    }

    it('should keep a file a view holds in Full mode with the data folder as storage', async () => {
        // Arrange
        const running = await start(false);
        const appId = await createApp(running);
        const file = await upload(running.server.origin, appId, PNG, 'sketch.png');
        const view = await openView(running.server.origin, appId);
        closers.push(() => view.close());
        view.send(JSON.stringify({ type: 'change', change: { id: 'pick-1', path: '$.data.photo', op: 'set', value: file, base: 0 } }));
        await heldLive(running, appId, file.id);
        await eventually(
            () => readFile(join(data!.dir, appId.toLowerCase(), 'state.json'), 'utf8').catch(() => ''),
            (text) => text.includes(file.id)
        );

        // Act
        const status = await sweepAndCheck(running, appId, file.id);

        // Assert
        expect(status).toBe(200);
    });

    it('should remove an old file that neither the document nor the state references', async () => {
        // Arrange
        const running = await start(true);
        const appId = await createApp(running);
        const file = await upload(running.server.origin, appId, PNG, 'orphan.png');

        // Act
        const status = await sweepAndCheck(running, appId, file.id);

        // Assert
        expect(status).toBe(404);
    });

    it('should keep a file a view holds in Full mode with a statenet', async () => {
        // Arrange
        const running = await start(true);
        const appId = await createApp(running);
        const file = await upload(running.server.origin, appId, PNG, 'sketch.png');
        const view = await openView(running.server.origin, appId);
        closers.push(() => view.close());
        view.send(JSON.stringify({ type: 'change', change: { id: 'pick-1', path: '$.data.photo', op: 'set', value: file, base: 0 } }));
        await heldLive(running, appId, file.id);

        // Act
        const status = await sweepAndCheck(running, appId, file.id);

        // Assert
        expect(status).toBe(200);
    });

    it('should keep a file a page of a Persisted app holds', async () => {
        // Arrange
        const running = await start(true);
        const appId = await createApp(running, 'persisted');
        const file = await upload(running.server.origin, appId, PNG, 'sketch.png');
        const page = new StatenetClient(statenet!.url, `apps.${appId.toLowerCase()}`);
        closers.push(() => page.stop());
        await page.ready();
        page.send([{ id: 'pick-1', path: '$.data.photo', op: 'set', value: file }]);
        await heldLive(running, appId, file.id);

        // Act
        const status = await sweepAndCheck(running, appId, file.id);

        // Assert
        expect(status).toBe(200);
    });
});

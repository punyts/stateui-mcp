import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { UNREFERENCED_FILE_GRACE_MS } from '../src/domain/UiFile.js';
import { call, createApp, httpHarness, tempData } from './helpers.js';
import type { CreatedApp, HttpHarness, TempData } from './helpers.js';

/*
 * Graphics story G2.5a: does the file sweep delete a file that only live state holds?
 *
 * A file is uploaded, then referenced only by a value a running view set, never by the app part or a tool write. Its
 * upload time is moved back past the grace period (`files.json` is rewritten, so the test waits for no clock), and a
 * second upload runs the sweep. The file must still be there. The sweep reads the state of the app's instance, the same
 * state `ui_state_get` returns.
 */

const VIEW = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const HELD_AT = '$.screens.home.children.form.children.email.value';

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

/** A view's socket to the server, after its hello to the namespace of the app's instance */
async function openView(harness: HttpHarness, app: CreatedApp): Promise<WebSocket> {
    const { origin } = harness.server;
    const found = await harness.server.services.useCases.findPartApp.execute(app.name);
    if (found.kind !== 'found') throw new Error('the app is stored');
    const namespace = harness.server.services.instanceViews.namespace(found.part);
    const socket = new WebSocket(`${origin.replace('http', 'ws')}/apps/${app.id}/sync?view=${VIEW}&kind=browser`, { headers: { Origin: origin } });
    const frames: Record<string, unknown>[] = [];
    socket.on('message', (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
    await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'hello', namespace, revision: 0, clientId: VIEW, protocol: 1 }));
    await eventually(() => frames, (all) => all.some((frame) => frame['type'] === 'welcome' || frame['type'] === 'snapshot'));
    return socket;
}

describe('the file sweep and files held only in live state (G2.5a)', () => {
    let data: TempData | undefined;
    let harness: HttpHarness | undefined;
    const closers: (() => void)[] = [];

    afterEach(async () => {
        for (const close of closers.splice(0)) close();
        await harness?.close();
        await data?.cleanup();
        harness = undefined;
        data = undefined;
    });

    async function start(): Promise<{ running: HttpHarness; app: CreatedApp }> {
        data = await tempData();
        harness = await httpHarness(data.dir);
        return { running: harness, app: await createApp(harness.client, 'sweep') };
    }

    /** Waits until the server's state of the app carries the file id */
    async function heldLive(running: HttpHarness, app: CreatedApp, fileId: string): Promise<void> {
        await eventually(
            () => call(running.client, 'ui_state_get', { app: app.name }),
            (result) => JSON.stringify(result.body['state'] ?? {}).includes(fileId)
        );
    }

    /** Ages the files, uploads another one (which sweeps) and answers whether the first file is still served */
    async function sweepAndCheck(running: HttpHarness, app: CreatedApp, fileId: string): Promise<number> {
        await ageFiles(data!.dir, app.id);
        await upload(running.server.origin, app.id, Buffer.from('trigger'), 'trigger.txt');
        return (await fetch(`${running.server.origin}/apps/${app.id}/files/${fileId}`)).status;
    }

    it('should keep a file a view holds in the state of the instance', async () => {
        // Arrange
        const { running, app } = await start();
        const file = await upload(running.server.origin, app.id, PNG, 'sketch.png');
        const view = await openView(running, app);
        closers.push(() => view.close());
        view.send(JSON.stringify({ type: 'change', change: { id: 'pick-1', path: HELD_AT, op: 'set', value: file, base: 0 } }));
        await heldLive(running, app, file.id);

        // Act
        const status = await sweepAndCheck(running, app, file.id);

        // Assert
        expect(status).toBe(200);
    });

    it('should refuse to release a file a view holds (409, G2.5) and release it once the view lets go', async () => {
        // Arrange
        const { running, app } = await start();
        const file = await upload(running.server.origin, app.id, PNG, 'signature.png');
        const view = await openView(running, app);
        closers.push(() => view.close());
        view.send(JSON.stringify({ type: 'change', change: { id: 'pick-1', path: HELD_AT, op: 'set', value: file, base: 0 } }));
        await heldLive(running, app, file.id);
        const url = `${running.server.origin}/apps/${app.id}/files/${file.id}`;

        // Act
        const held = await fetch(url, { method: 'DELETE' });
        const kept = await fetch(url);
        view.send(JSON.stringify({ type: 'change', change: { id: 'pick-2', path: HELD_AT, op: 'set', value: '', base: 1 } }));
        await eventually(
            () => call(running.client, 'ui_state_get', { app: app.name }),
            (result) => !JSON.stringify(result.body['state'] ?? {}).includes(file.id)
        );
        const released = await fetch(url, { method: 'DELETE' });

        // Assert
        expect(held.status).toBe(409);
        expect(kept.status).toBe(200);
        expect(released.status).toBe(204);
        expect((await fetch(url)).status).toBe(404);
    });

    it('should remove an old file that neither the app nor the state references', async () => {
        // Arrange
        const { running, app } = await start();
        const file = await upload(running.server.origin, app.id, PNG, 'orphan.png');

        // Act
        const status = await sweepAndCheck(running, app, file.id);

        // Assert
        expect(status).toBe(404);
    });
});

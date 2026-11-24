import { testWire } from '../src/testing/syncWire.js';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { MAX_FILE_BYTES, MAX_FILES_PER_APP } from '../src/domain/UiFile.js';
import { loadChunk3d } from '../src/infrastructure/http/runtimeBundle.js';
import { runtimeCsp } from '../src/infrastructure/http/security.js';
import { FORM_ROOT, call, createApp, httpHarness, noBrowser, rootOf, tempData } from './helpers.js';
import type { HttpHarness, TempData } from './helpers.js';

const PNG_BYTES = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]);

let data: TempData;
let harness: HttpHarness;
let origin = '';
let appId = '';
let appNamespace = '';
let owner = '';

/** The `/paths` URL of a file of the app */
function filePath(id: string, app = appId): string {
    return `/paths/${owner}/apps/${app.toLowerCase()}/files/${id}`;
}

beforeAll(async () => {
    data = await tempData();
    harness = await httpHarness(data.dir, noBrowser);
    origin = harness.server.origin;
    appId = (await createApp(harness.client, 'form', FORM_ROOT)).id;
    const found = await harness.server.services.useCases.findPartApp.execute('form');
    if (found.kind !== 'found') throw new Error('the form app is stored');
    appNamespace = harness.server.services.instanceViews.namespace(found.part);
    owner = harness.server.services.instanceViews.owner;
});

afterAll(async () => {
    await harness.close();
    await data.cleanup();
});

function upload(path: string, bytes: Buffer, name: string, field = 'file'): Promise<Response> {
    const form = new FormData();
    form.append(field, new Blob([new Uint8Array(bytes)]), name);
    return fetch(`${origin}${path}`, { method: 'POST', body: form });
}

/** A request with a Host header of our choosing, which `fetch` does not allow */
function rawGet(path: string, host: string): Promise<{ status: number }> {
    return new Promise((resolve, reject) => {
        const url = new URL(origin);
        const req = httpRequest({ host: url.hostname, port: url.port, path, headers: { Host: host } }, (response) => {
            response.resume();
            resolve({ status: response.statusCode ?? 0 });
        });
        req.on('error', reject);
        req.end();
    });
}

describe('GET /', () => {
    it('should list the apps with a link to each live view', async () => {
        const response = await fetch(`${origin}/`);
        const html = await response.text();

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/html');
        expect(html).toContain(`href="/apps/${appId}"`);
        expect(html).toContain(`<a href="/apps/${appId}">form</a>`);
    });

    it('should list every app, the most recently changed first', async () => {
        // Arrange
        const created = await createApp(harness.client, 'corner-shop', rootOf({}), { title: 'Corner shop' });
        const partId = created.id;

        // Act
        const html = await (await fetch(`${origin}/`)).text();

        // Assert
        expect(html).toContain(`<a href="/apps/${partId}">corner-shop</a>`);
        expect(html).toContain(`href="/apps/${appId}"`);
        expect(html.indexOf(partId)).toBeLessThan(html.indexOf(appId));
    });

    it('should send a policy that allows no script', async () => {
        const response = await fetch(`${origin}/`);

        expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
        expect(response.headers.get('content-security-policy')).not.toContain('script-src');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    });
});

describe('GET /apps/:appId', () => {
    it('should serve a page with no inline script, the host script and an exact policy', async () => {
        const response = await fetch(`${origin}/apps/${appId}`);
        const html = await response.text();
        const csp = response.headers.get('content-security-policy') ?? '';

        expect(response.status).toBe(200);
        expect(html).toContain('<script type="module" src="/assets/host.js"></script>');
        expect(html.replace('<script type="module" src="/assets/host.js"></script>', '')).not.toContain('<script');
        expect(html).not.toContain('style="');
        expect(html).toContain(`data-app-id="${appId}"`);
        expect(html).toContain('<title>form</title>');
        expect(html).toContain(`data-namespace="${appNamespace}"`);
        expect(html).toContain(`data-paths="/paths/${owner}/apps/${appId.toLowerCase()}"`);
        expect(html).toMatch(/data-grant="[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"/);
        expect(csp).toContain("script-src 'self'");
        expect(csp).not.toContain('unsafe');
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain(`frame-src http://127.0.0.1:${harness.server.runtimePort}`);
    });

    it('should point the frame at the content-hashed runtime page on the runtime origin', async () => {
        const html = await (await fetch(`${origin}/apps/${appId}`)).text();
        const runtime = /data-runtime-url="([^"]+)"/.exec(html)?.[1] ?? '';
        const runtimeOrigin = `http://127.0.0.1:${harness.server.runtimePort}`;

        const page = await fetch(runtime);
        const script = await fetch(runtime.replace('.html', '.js'));

        expect(harness.server.runtimePort).not.toBe(harness.server.port);
        expect(runtime).toMatch(new RegExp(`^${runtimeOrigin}/runtime/[0-9a-f]{16}\.html$`));
        expect(page.status).toBe(200);
        expect(page.headers.get('content-security-policy')).toContain("script-src 'self' 'unsafe-eval'");
        expect(page.headers.get('content-security-policy')).toContain("connect-src 'none'");
        expect(page.headers.get('content-security-policy')).toContain(`frame-ancestors ${origin}`);
        expect(script.status).toBe(200);
        expect(script.headers.get('cache-control')).toContain('immutable');
        expect((await script.text()).length).toBeGreaterThan(100_000);
        expect((await fetch(`${runtimeOrigin}/runtime/0000000000000000.html`)).status).toBe(404);
    });

    it('should serve the runtime only from the runtime origin, and nothing else there', async () => {
        const html = await (await fetch(`${origin}/apps/${appId}`)).text();
        const path = new URL(/data-runtime-url="([^"]+)"/.exec(html)?.[1] ?? '').pathname;
        const runtimeOrigin = `http://127.0.0.1:${harness.server.runtimePort}`;

        expect((await fetch(`${origin}${path}`)).status).toBe(404);
        expect((await fetch(`${runtimeOrigin}/`)).status).toBe(404);
        expect((await fetch(`${runtimeOrigin}/apps/${appId}`)).status).toBe(404);
        expect((await fetch(`${runtimeOrigin}/mcp`, { method: 'POST' })).status).toBe(404);
    });

    it('should frame the runtime by the host name the page was opened with', async () => {
        const port = new URL(origin).port;
        const response = await new Promise<{ html: string; csp: string }>((resolve, reject) => {
            const req = httpRequest({ host: '127.0.0.1', port, path: `/apps/${appId}`, headers: { Host: `localhost:${port}` } }, (res) => {
                let html = '';
                res.on('data', (chunk: Buffer) => (html += chunk.toString('utf8')));
                res.on('end', () => resolve({ html, csp: String(res.headers['content-security-policy'] ?? '') }));
            });
            req.on('error', reject);
            req.end();
        });

        expect(response.html).toContain(`data-runtime-url="http://localhost:${harness.server.runtimePort}/runtime/`);
        expect(response.csp).toContain(`frame-src http://localhost:${harness.server.runtimePort}`);
    });

    it('should link the runtime stylesheet that removes the body margin and lets the root fill the frame', async () => {
        const html = await (await fetch(`${origin}/apps/${appId}`)).text();
        const runtime = /data-runtime-url="([^"]+)"/.exec(html)?.[1] ?? '';

        const page = await (await fetch(runtime)).text();
        const sheet = await fetch(new URL('./runtime.css', runtime));
        const css = await sheet.text();

        expect(page).toContain('<link rel="stylesheet" href="./runtime.css">');
        expect(sheet.status).toBe(200);
        expect(sheet.headers.get('content-type')).toContain('text/css');
        expect(css).toContain('margin: 0');
        expect(css).toContain('min-height: 100%');
    });

    it('should answer 404 for an unknown app and 400 for an id that is not a UUID', async () => {
        const unknown = await fetch(`${origin}/apps/11111111-1111-4111-8111-111111111111`);
        const malformed = await fetch(`${origin}/apps/not-a-uuid`);

        expect(unknown.status).toBe(404);
        expect(malformed.status).toBe(400);
    });

    it('should serve the host script and the stylesheet', async () => {
        const script = await fetch(`${origin}/assets/host.js`);
        const css = await fetch(`${origin}/assets/page.css`);

        expect(script.headers.get('content-type')).toContain('text/javascript');
        expect(await script.text()).toContain('/report');
        expect(css.headers.get('content-type')).toContain('text/css');
    });
});

describe('the 3D chunk on the runtime origin', () => {
    const CHUNK_HASH = 'fedcba9876543210';
    const CHUNK_SCRIPT = "globalThis.__stateui3d = { version: 'fake', createScene3d: function () { return {}; } };\n";
    let chunkData: TempData;
    let chunkHarness: HttpHarness;
    let chunkAppId = '';
    let bareData: TempData;
    let bareHarness: HttpHarness;
    let bareAppId = '';

    beforeAll(async () => {
        chunkData = await tempData();
        const chunkDir = join(chunkData.dir, 'chunk');
        await mkdir(chunkDir);
        await writeFile(join(chunkDir, 'manifest.json'), JSON.stringify({ hash: CHUNK_HASH, script: `${CHUNK_HASH}.js` }));
        await writeFile(join(chunkDir, `${CHUNK_HASH}.js`), CHUNK_SCRIPT);
        chunkHarness = await httpHarness(join(chunkData.dir, 'data'), noBrowser, { chunk3dDir: chunkDir });
        chunkAppId = (await createApp(chunkHarness.client, 'scene', FORM_ROOT)).id;
        // A folder with no manifest stands for a server without @punyts/stateui-3d
        bareData = await tempData();
        bareHarness = await httpHarness(join(bareData.dir, 'data'), noBrowser, { chunk3dDir: bareData.dir });
        bareAppId = (await createApp(bareHarness.client, 'flat', FORM_ROOT)).id;
    });

    afterAll(async () => {
        await chunkHarness.close();
        await chunkData.cleanup();
        await bareHarness.close();
        await bareData.cleanup();
    });

    it('should keep the frame policy: no blob, scripts only from the runtime origin and no connections', () => {
        const csp = runtimeCsp('http://127.0.0.1:4100');

        expect(csp).toContain("script-src 'self' 'unsafe-eval'");
        expect(csp).toContain("connect-src 'none'");
        expect(csp).toContain('img-src data: https: http://127.0.0.1:4100');
        expect(csp).toContain('media-src https: http://127.0.0.1:4100');
        expect(csp).not.toContain('blob:');
        expect(csp).not.toContain('worker-src');
    });

    it('should serve the chunk by its hash with the immutable cache of the runtime script, and 404 another hash', async () => {
        const runtimeOrigin = `http://127.0.0.1:${chunkHarness.server.runtimePort}`;

        const chunk = await fetch(`${runtimeOrigin}/runtime/${CHUNK_HASH}.js`);
        const other = await fetch(`${runtimeOrigin}/runtime/0123456789abcdef.js`);
        const onMain = await fetch(`${chunkHarness.server.origin}/runtime/${CHUNK_HASH}.js`);

        expect(chunk.status).toBe(200);
        expect(chunk.headers.get('content-type')).toContain('text/javascript');
        expect(chunk.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        expect(await chunk.text()).toBe(CHUNK_SCRIPT);
        expect(other.status).toBe(404);
        expect(onMain.status).toBe(404);
    });

    it('should name the chunk to the host page in data-chunk-3d', async () => {
        const html = await (await fetch(`${chunkHarness.server.origin}/apps/${chunkAppId}`)).text();

        expect(html).toMatch(new RegExp(`data-runtime-url="[^"]+" data-chunk-3d="${CHUNK_HASH}"`));
    });

    it('should start without a chunk, name none and serve none', async () => {
        const html = await (await fetch(`${bareHarness.server.origin}/apps/${bareAppId}`)).text();
        const runtimeOrigin = `http://127.0.0.1:${bareHarness.server.runtimePort}`;

        expect(html).toContain('data-runtime-url="');
        expect(html).not.toContain('data-chunk-3d');
        expect((await fetch(`${runtimeOrigin}/runtime/${CHUNK_HASH}.js`)).status).toBe(404);
    });

    it('should read no chunk from a folder without a manifest, and refuse a manifest without a valid hash', async () => {
        const badDir = join(bareData.dir, 'bad');
        await mkdir(badDir);
        await writeFile(join(badDir, 'manifest.json'), JSON.stringify({ hash: '../runtime' }));

        expect(loadChunk3d(bareData.dir)).toBeUndefined();
        expect(() => loadChunk3d(badDir)).toThrow(/no valid hash/);
    });
});

describe('request checks', () => {
    it('should refuse a Host header that is not a loopback name (DNS rebinding)', async () => {
        expect((await rawGet('/', 'evil.example')).status).toBe(403);
        expect((await rawGet('/', `localhost:${new URL(origin).port}`)).status).toBe(200);
    });

    it('should refuse a cross-origin POST', async () => {
        const response = await fetch(`${origin}/apps/${appId}/report`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
            body: JSON.stringify({ type: 'ready' })
        });

        expect(response.status).toBe(403);
    });

    it('should give a request to a loopback name loopback origins behind public ones, so a page on this machine loads', async () => {
        // Arrange
        const behindData = await tempData();
        const behind = await httpHarness(behindData.dir, noBrowser, { publicOrigins: { main: 'https://ui.example', runtime: 'https://run.ui.example' } });
        const behindId = (await createApp(behind.client, 'form', FORM_ROOT)).id;

        try {
            // Act
            const local = await fetch(`${behind.server.origin}/apps/${behindId}`);
            const html = await local.text();
            const runtime = /data-runtime-url="([^"]+)"/.exec(html)?.[1] ?? '';
            const frame = await fetch(runtime);

            // Assert
            expect(local.status).toBe(200);
            expect(runtime.startsWith(`http://127.0.0.1:${behind.server.runtimePort}/runtime/`)).toBe(true);
            expect(frame.headers.get('content-security-policy')).toContain(`frame-ancestors ${behind.server.origin}`);
        } finally {
            await behind.close();
            await behindData.cleanup();
        }
    });

    it('should answer an unknown path with 404', async () => {
        expect((await fetch(`${origin}/nothing`)).status).toBe(404);
    });

    it('should take a POST from another origin only on a path the embedding server names', async () => {
        // Arrange
        const crossData = await tempData();
        const crossHarness = await httpHarness(crossData.dir, noBrowser, {
            routes: async (request, response) => {
                if (!(request.url ?? '').startsWith('/answer')) return false;
                response.writeHead(204).end();
                return true;
            },
            crossOriginPost: (path) => path === '/answer'
        });
        const post = (path: string, method = 'POST'): Promise<Response> => fetch(`${crossHarness.server.origin}${path}`, { method, headers: { origin: 'https://idp.example' } });

        try {
            // Act
            const named = await post('/answer?x=1');
            const deleted = await post('/answer', 'DELETE');
            const other = await post(`/apps/${appId}/report`);

            // Assert
            expect(named.status).toBe(204);
            expect(deleted.status).toBe(403);
            expect(other.status).toBe(403);
        } finally {
            await crossHarness.close();
            await crossData.cleanup();
        }
    });
});

describe('POST /apps/:appId/files', () => {
    it('should store a file, sniff its type and let ui_file_read read it', async () => {
        const response = await upload(`/apps/${appId}/files`, Buffer.from('a,b\n1,2\n'), 'rows.csv');
        const body = (await response.json()) as { id: string; name: string; size: number; type: string };
        const read = await call(harness.client, 'ui_file_read', { app: 'form', fileId: body.id });

        expect(response.status).toBe(201);
        expect(body).toMatchObject({ name: 'rows.csv', size: 8, type: 'text/csv' });
        expect(read.body).toMatchObject({ text: 'a,b\n1,2\n', truncated: false });
    });

    it('should ignore the type the client claims', async () => {
        const form = new FormData();
        form.append('file', new Blob([PNG_BYTES], { type: 'text/plain' }), 'sneaky.txt');

        const response = await fetch(`${origin}/apps/${appId}/files`, { method: 'POST', body: form });

        expect(((await response.json()) as { type: string }).type).toBe('image/png');
    });

    it('should serve a stored file as an attachment under a sandbox policy', async () => {
        const stored = (await (await upload(`/apps/${appId}/files`, Buffer.from('hi'), 'a "quoted" name.txt')).json()) as { id: string };

        const response = await fetch(`${origin}${filePath(stored.id)}`);

        expect(response.status).toBe(200);
        expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename\*=UTF-8''/);
        expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
        expect(response.headers.get('content-type')).toBe('text/plain');
        expect(await response.text()).toBe('hi');
    });

    it('should accept exactly 10 MiB and refuse one byte more with 413', async () => {
        const exact = await upload(`/apps/${appId}/files`, Buffer.alloc(MAX_FILE_BYTES, 97), 'big.txt');
        const over = await upload(`/apps/${appId}/files`, Buffer.alloc(MAX_FILE_BYTES + 1, 97), 'bigger.txt');

        expect(exact.status).toBe(201);
        expect(over.status).toBe(413);
        expect(((await over.json()) as { error: string }).error).toBe('too_large');
    });

    it('should refuse HTML, SVG, executables and empty files with 415', async () => {
        const html = await upload(`/apps/${appId}/files`, Buffer.from('<!doctype html><script>1</script>'), 'page.txt');
        const svg = await upload(`/apps/${appId}/files`, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x.svg');
        const exe = await upload(`/apps/${appId}/files`, Buffer.from([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3]), 'tool.exe');
        const empty = await upload(`/apps/${appId}/files`, Buffer.alloc(0), 'empty.txt');

        expect([html.status, svg.status, exe.status, empty.status]).toEqual([415, 415, 415, 415]);
        expect(((await exe.json()) as { error: string }).error).toBe('unsupported_type');
    });

    it('should answer 400 without a file field or without multipart, and 404 for an unknown app', async () => {
        const wrongField = await upload(`/apps/${appId}/files`, Buffer.from('x'), 'a.txt', 'other');
        const notMultipart = await fetch(`${origin}/apps/${appId}/files`, { method: 'POST', body: 'plain' });
        const unknown = await upload('/apps/11111111-1111-4111-8111-111111111111/files', Buffer.from('x'), 'a.txt');

        expect(wrongField.status).toBe(400);
        expect(notMultipart.status).toBe(400);
        expect(unknown.status).toBe(404);
    });

    it('should answer 409 with the reason once an app holds the most files', async () => {
        const quotaApp = (await createApp(harness.client, 'quota', rootOf({}))).id;

        for (let n = 0; n < MAX_FILES_PER_APP; n++) {
            expect((await upload(`/apps/${quotaApp}/files`, Buffer.from(`file ${n}`), `f${n}.txt`)).status).toBe(201);
        }
        const over = await upload(`/apps/${quotaApp}/files`, Buffer.from('one more'), 'more.txt');

        expect(over.status).toBe(409);
        expect(await over.json()).toEqual({ error: 'quota', reason: 'files' });
    });
});

describe('DELETE /apps/:appId/files/:fileId', () => {
    async function stored(name: string): Promise<string> {
        return ((await (await upload(`/apps/${appId}/files`, Buffer.from(name), name)).json()) as { id: string }).id;
    }

    /** A DELETE with headers of our choosing, such as a Host that `fetch` does not allow */
    function rawDelete(path: string, headers: Record<string, string>): Promise<number> {
        return new Promise((resolve, reject) => {
            const url = new URL(origin);
            const req = httpRequest({ host: url.hostname, port: url.port, path, method: 'DELETE', headers }, (response) => {
                response.resume();
                resolve(response.statusCode ?? 0);
            });
            req.on('error', reject);
            req.end();
        });
    }

    it('should remove a file nothing references with 204, then answer 404 for it (a release is idempotent)', async () => {
        const id = await stored('gone.txt');
        const bytes = join(data.dir, appId.toLowerCase(), 'files', id);
        const storedBefore = existsSync(bytes);

        const first = await fetch(`${origin}/apps/${appId}/files/${id}`, { method: 'DELETE', headers: { origin } });
        const second = await fetch(`${origin}/apps/${appId}/files/${id}`, { method: 'DELETE' });
        const read = await fetch(`${origin}${filePath(id)}`);

        expect(first.status).toBe(204);
        expect(await first.text()).toBe('');
        expect(second.status).toBe(404);
        expect(((await second.json()) as { error: string }).error).toBe('not_found');
        expect(read.status).toBe(404);
        expect([storedBefore, existsSync(bytes)]).toEqual([true, false]);
    });

    it('should answer 409 and keep a file the state of the instance references', async () => {
        const id = await stored('held.txt');
        await call(harness.client, 'ui_state_set', { app: 'form', path: '$.screens.home.children.form.children.email.value', value: id });

        const response = await fetch(`${origin}/apps/${appId}/files/${id}`, { method: 'DELETE' });
        const read = await fetch(`${origin}${filePath(id)}`);
        await call(harness.client, 'ui_state_set', { app: 'form', path: '$.screens.home.children.form.children.email.value', value: '' });
        const afterLetGo = await fetch(`${origin}/apps/${appId}/files/${id}`, { method: 'DELETE' });

        expect(response.status).toBe(409);
        expect(((await response.json()) as { error: string }).error).toBe('referenced');
        expect(read.status).toBe(200);
        expect(afterLetGo.status).toBe(204);
    });

    it("should answer 404 for another app's file and an unknown app, and 400 for ids that are not UUIDs", async () => {
        const otherApp = (await createApp(harness.client, 'release-other', rootOf({}))).id;
        const id = await stored('mine.txt');

        const fromOther = await fetch(`${origin}/apps/${otherApp}/files/${id}`, { method: 'DELETE' });
        const unknownApp = await fetch(`${origin}/apps/11111111-1111-4111-8111-111111111111/files/${id}`, { method: 'DELETE' });
        const badFile = await fetch(`${origin}/apps/${appId}/files/not-a-uuid`, { method: 'DELETE' });
        const badApp = await fetch(`${origin}/apps/not-a-uuid/files/${id}`, { method: 'DELETE' });

        expect([fromOther.status, unknownApp.status, badFile.status, badApp.status]).toEqual([404, 404, 400, 400]);
        expect((await fetch(`${origin}${filePath(id)}`)).status).toBe(200);
    });

    it('should refuse a cross-origin DELETE and a foreign Host header with 403, and keep the file', async () => {
        const id = await stored('guarded.txt');
        const path = `/apps/${appId}/files/${id}`;

        const crossOrigin = await fetch(`${origin}${path}`, { method: 'DELETE', headers: { origin: 'http://evil.example' } });
        const foreignHost = await rawDelete(path, { Host: 'evil.example' });

        expect(crossOrigin.status).toBe(403);
        expect(((await crossOrigin.json()) as { error: string }).error).toBe('forbidden_origin');
        expect(foreignHost).toBe(403);
        expect((await fetch(`${origin}${filePath(id)}`)).status).toBe(200);
    });
});

describe('GET /paths/<owner>/apps/:appId/files/:fileId', () => {
    async function stored(bytes: Buffer, name: string): Promise<string> {
        return ((await (await upload(`/apps/${appId}/files`, bytes, name)).json()) as { id: string }).id;
    }

    async function pageGrant(): Promise<string> {
        const html = await (await fetch(`${origin}/apps/${appId}`)).text();
        return /data-grant="([^"]+)"/.exec(html)?.[1] ?? '';
    }

    it('should serve a picture inline, immutable, with its hash as the ETag and byte ranges offered', async () => {
        // Arrange
        const id = await stored(PNG_BYTES, 'plan.png');

        // Act
        const response = await fetch(`${origin}${filePath(id)}`);
        const body = Buffer.from(await response.arrayBuffer());

        // Assert
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/png');
        expect(response.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''plan.png");
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
        expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
        expect(response.headers.get('accept-ranges')).toBe('bytes');
        expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);
        expect(body.equals(PNG_BYTES)).toBe(true);
    });

    it('should answer one byte range with 206, a range past the end with 416, and several ranges with the whole file', async () => {
        // Arrange
        const id = await stored(Buffer.from('0123456789'), 'digits.txt');
        const read = (range: string) => fetch(`${origin}${filePath(id)}`, { headers: { range } });

        // Act
        const [middle, tail, from, past, several] = await Promise.all([read('bytes=2-5'), read('bytes=-3'), read('bytes=7-'), read('bytes=10-'), read('bytes=0-1, 4-5')]);

        // Assert
        expect([middle.status, await middle.text(), middle.headers.get('content-range')]).toEqual([206, '2345', 'bytes 2-5/10']);
        expect([tail.status, await tail.text(), tail.headers.get('content-range')]).toEqual([206, '789', 'bytes 7-9/10']);
        expect([from.status, await from.text()]).toEqual([206, '789']);
        expect([past.status, past.headers.get('content-range')]).toEqual([416, 'bytes */10']);
        expect([several.status, await several.text()]).toEqual([200, '0123456789']);
    });

    it('should answer 304 to a request with the ETag, and the headers alone to a HEAD', async () => {
        // Arrange
        const id = await stored(Buffer.from('cached'), 'cached.txt');
        const etag = (await fetch(`${origin}${filePath(id)}`)).headers.get('etag') ?? '';

        // Act
        const again = await fetch(`${origin}${filePath(id)}`, { headers: { 'if-none-match': etag } });
        const head = await fetch(`${origin}${filePath(id)}`, { method: 'HEAD' });

        // Assert
        expect(again.status).toBe(304);
        expect(head.status).toBe(200);
        expect(head.headers.get('content-length')).toBe('6');
        expect(await head.text()).toBe('');
    });

    it('should answer 404 alike for an unknown file, another app, another owner, a path no source has and a bad segment', async () => {
        // Arrange
        const id = await stored(Buffer.from('mine'), 'mine.txt');
        const otherApp = (await createApp(harness.client, 'paths-other', rootOf({}))).id;
        const paths = [
            filePath('11111111-1111-4111-8111-111111111111'),
            filePath(id, otherApp),
            `/paths/someone-else/apps/${appId.toLowerCase()}/files/${id}`,
            `/paths/${owner}/apps/${appId.toLowerCase()}/files/${id}/more`,
            `/paths/${owner}/apps/${appId.toLowerCase()}/notes/${id}`,
            `/paths/${owner}/apps/not-a-uuid/files/${id}`,
            `/paths/${owner}/apps/${appId.toLowerCase()}/files/a.b`,
            '/paths'
        ];

        // Act
        const statuses = await Promise.all(paths.map(async (path) => (await fetch(`${origin}${path}`)).status));

        // Assert
        expect(statuses).toEqual(paths.map(() => 404));
    });

    it('should refuse any query but a grant with 400, and no longer serve the download route', async () => {
        // Arrange
        const id = await stored(Buffer.from('q'), 'q.txt');

        // Act
        const query = await fetch(`${origin}${filePath(id)}?x=1`);
        const twice = await fetch(`${origin}${filePath(id)}?g=a&g=b`);
        const old = await fetch(`${origin}/apps/${appId}/files/${id}`);

        // Assert
        expect([query.status, twice.status, old.status]).toEqual([400, 400, 404]);
    });

    it("should read with the page's grant, and answer 404 for a grant tampered with or of another app", async () => {
        // Arrange
        const id = await stored(PNG_BYTES, 'granted.png');
        const grant = await pageGrant();
        const [body, mac] = grant.split('.') as [string, string];
        const tampered = `${body}.${mac.startsWith('A') ? 'B' : 'A'}${mac.slice(1)}`;

        // Act
        const good = await fetch(`${origin}${filePath(id)}?g=${grant}`);
        const bad = await fetch(`${origin}${filePath(id)}?g=${tampered}`);
        const otherApp = (await createApp(harness.client, 'paths-grant-other', rootOf({}))).id;
        const elsewhere = await fetch(`${origin}${filePath(id, otherApp)}?g=${grant}`);

        // Assert
        expect(good.status).toBe(200);
        expect([bad.status, elsewhere.status]).toEqual([404, 404]);
    });
});

describe('GET /apps/:appId/sync and POST /apps/:appId/report', () => {
    const VIEW = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
    const LIVE_PATH = '$.screens.home.children.form.children.email.value';
    const TYPED_PATH = '$.screens.home.children.form.children.email.value';

    interface OpenSocket {
        readonly socket: WebSocket;
        readonly received: Record<string, unknown>[];
        next(match: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
        send(message: object): void;
    }

    /** A view's sync socket: it records every frame and resolves a wait when a matching one comes */
    function openSync(id: string, headers: Record<string, string> = { Origin: origin }): Promise<OpenSocket> {
        const socket = new WebSocket(`${origin.replace('http', 'ws')}/apps/${id}/sync?view=${VIEW}&kind=browser`, { headers });
        const received: Record<string, unknown>[] = [];
        const waits: { match: (message: Record<string, unknown>) => boolean; resolve: (message: Record<string, unknown>) => void }[] = [];
        const wire = testWire();
        socket.on('message', (data, isBinary) => {
            const message = wire.readSocket(data, isBinary);
            received.push(message);
            for (const wait of [...waits]) {
                if (!wait.match(message)) continue;
                waits.splice(waits.indexOf(wait), 1);
                wait.resolve(message);
            }
        });
        const next = (match: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
            const found = received.find(match);
            if (found !== undefined) return Promise.resolve(found);
            return new Promise((resolve, reject) => {
                waits.push({ match, resolve });
                setTimeout(() => reject(new Error('no matching frame')), 5000);
            });
        };
        return new Promise((resolve, reject) => {
            socket.once('open', () => resolve({ socket, received, next, send: (message) => socket.send(wire.write(message)) }));
            socket.once('error', reject);
        });
    }

    /** The status a refused upgrade answers with */
    function refusedStatus(id: string, view: string, headers: Record<string, string> = {}): Promise<number> {
        return new Promise((resolve, reject) => {
            const socket = new WebSocket(`${origin.replace('http', 'ws')}/apps/${id}/sync?view=${view}`, { headers });
            socket.once('unexpected-response', (_request, response) => {
                resolve(response.statusCode ?? 0);
                socket.terminate();
            });
            socket.once('open', () => {
                socket.close();
                reject(new Error('the upgrade was accepted'));
            });
            socket.once('error', () => undefined);
        });
    }

    function hello(view: OpenSocket): void {
        view.send({ type: 'hello', namespace: appNamespace, revision: 0, clientId: VIEW, protocol: 4 });
    }

    function report(body: Record<string, unknown>): Promise<Response> {
        return fetch(`${origin}/apps/${appId}/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ viewId: VIEW, ...body }) });
    }

    it('should send the app first, sync the state and a tool write, and detach when the socket closes', async () => {
        // Arrange
        const view = await openSync(appId);

        // Act
        const first = await view.next((message) => message['type'] === 'view');
        hello(view);
        const welcome = await view.next((message) => message['type'] === 'welcome');
        const attachedWhileOpen = harness.server.services.hub.viewCount(appId);
        await call(harness.client, 'ui_state_set', { app: 'form', path: LIVE_PATH, value: 'yes' });
        const changes = await view.next((message) => message['type'] === 'changes');
        view.socket.close();
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Assert
        expect(first['message']).toMatchObject({ type: 'app', reason: 'attach' });
        expect(JSON.stringify(first['message'])).toContain('"component":"panel"');
        expect(welcome).toMatchObject({ type: 'welcome' });
        expect(attachedWhileOpen).toBe(1);
        expect(changes['changes']).toEqual([expect.objectContaining({ path: LIVE_PATH, op: 'set', value: 'yes' })]);
        expect(harness.server.services.hub.viewCount(appId)).toBe(0);
    });

    it('should apply a change a view sends and queue its emit for ui_events_read', async () => {
        const view = await openSync(appId);
        hello(view);
        await view.next((message) => message['type'] === 'welcome');

        view.send({ type: 'change', change: { id: 'typed-1', path: TYPED_PATH, op: 'set', value: 'x', base: 0 } });
        const ack = await view.next((message) => message['type'] === 'ack');
        view.send({ type: 'emit', name: 'form.saved', value: { ok: true } });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const state = await call(harness.client, 'ui_state_get', { app: 'form' });
        const events = await call(harness.client, 'ui_events_read', { app: 'form' });
        view.socket.close();

        expect(ack).toMatchObject({ id: 'typed-1', result: 'applied' });
        expect(JSON.stringify(state.body['state'])).toContain('"value":"x"');
        expect((events.body['events'] as { name: string; payload: unknown }[]).at(-1)).toMatchObject({ name: 'form.saved', payload: { ok: true } });
    });

    it('should refuse a view id that is not a UUID, an unknown app and another origin', async () => {
        const malformed = await refusedStatus(appId, 'x');
        const unknown = await refusedStatus('11111111-1111-4111-8111-111111111111', VIEW);
        const crossOrigin = await refusedStatus(appId, VIEW, { Origin: 'http://evil.example' });

        expect([malformed, unknown, crossOrigin]).toEqual([400, 404, 403]);
    });

    it('should keep the runtime errors a view reports and show them in ui_state_get', async () => {
        const response = await report({ type: 'errors', errors: [{ code: 'SUI-RUN-BINDING', message: 'boom', statePath: '$.app' }, { nope: true }], revision: 1 });
        const validated = await call(harness.client, 'ui_state_get', { app: 'form' });

        expect(response.status).toBe(200);
        expect((validated.body['preview'] as { errors: { code: string }[] }).errors.map((error) => error.code)).toContain('SUI-RUN-BINDING');
    });

    it('should drop the errors of an earlier load when the view renders again', async () => {
        // Arrange
        await report({ type: 'errors', errors: [{ code: 'SUI-RUN-STALE', message: 'old bundle' }], revision: 1, load: 1 });

        // Act
        const ready = await report({ type: 'ready', revision: 1, load: 2 });
        await report({ type: 'errors', errors: [{ code: 'SUI-RUN-BINDING', message: 'still there' }], revision: 1, load: 2 });
        const validated = await call(harness.client, 'ui_state_get', { app: 'form' });

        // Assert
        expect(ready.status).toBe(200);
        expect((validated.body['preview'] as { errors: { code: string }[] }).errors.map((error) => error.code)).toEqual(['SUI-RUN-BINDING']);
    });

    it('should refuse a report that is not valid, the state report that no longer exists and the emit report the sync socket replaced', async () => {
        const noView = await fetch(`${origin}/apps/${appId}/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const unknownType = await report({ type: 'launch' });
        const state = await report({ type: 'state', revision: 1, snapshot: { data: {} } });
        const emit = await report({ type: 'emit', name: 'form.saved' });
        const notJson = await fetch(`${origin}/apps/${appId}/report`, { method: 'POST', body: 'x' });

        expect([noView.status, unknownType.status, state.status, emit.status, notJson.status]).toEqual([400, 400, 400, 400, 400]);
    });
});

describe('GET /apps/:appId/sync for a tenant that may only look', () => {
    const VIEW = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
    const PATH = '$.screens.home.children.form.children.email.value';

    it('should reject every change of the view with access, the path sent first by number after, and drop its emits', async () => {
        // Arrange
        const viewData = await tempData();
        const viewHarness = await httpHarness(viewData.dir, noBrowser, { access: 'view' });
        try {
            const viewOrigin = viewHarness.server.origin;
            const id = (await createApp(viewHarness.client, 'form', FORM_ROOT)).id;
            const found = await viewHarness.server.services.useCases.findPartApp.execute('form');
            if (found.kind !== 'found') throw new Error('the form app is stored');
            const socket = new WebSocket(`${viewOrigin.replace('http', 'ws')}/apps/${id}/sync?view=${VIEW}&kind=browser`, { headers: { Origin: viewOrigin } });
            const wire = testWire();
            const received: Record<string, unknown>[] = [];
            socket.on('message', (data, isBinary) => received.push(wire.readSocket(data, isBinary)));
            await new Promise((resolve, reject) => {
                socket.once('open', resolve);
                socket.once('error', reject);
            });
            socket.send(wire.write({ type: 'hello', namespace: viewHarness.server.services.instanceViews.namespace(found.part), revision: 0, clientId: VIEW, protocol: 4 }));

            // Act
            socket.send(wire.write({ type: 'change', change: { id: 'look-1', path: PATH, op: 'set', value: 'x', base: 0 } }));
            socket.send(wire.write({ type: 'emit', name: 'form.saved' }));
            socket.send(wire.write({ type: 'change', change: { id: 'look-2', path: PATH, op: 'set', value: 'y', base: 0 } }));
            const deadline = Date.now() + 5000;
            while (received.filter((message) => message['type'] === 'ack').length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
            const events = await call(viewHarness.client, 'ui_events_read', { app: 'form' });
            const state = await call(viewHarness.client, 'ui_state_get', { app: 'form' });
            socket.close();

            // Assert
            expect(received.filter((message) => message['type'] === 'ack')).toEqual([
                { type: 'ack', id: 'look-1', result: 'rejected', reason: 'This app is shared with you to look at only', code: 'access' },
                { type: 'ack', id: 'look-2', result: 'rejected', reason: 'This app is shared with you to look at only', code: 'access' }
            ]);
            expect(received.some((message) => message['type'] === 'error')).toBe(false);
            expect(events.body['events']).toEqual([]);
            expect(JSON.stringify(state.body['state'])).not.toContain('"value":"x"');
        } finally {
            await viewHarness.close();
            await viewData.cleanup();
        }
    });
});

describe('the embedded endpoint', () => {
    it('should not serve MCP, which the server speaks on stdio only', async () => {
        expect((await fetch(origin + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
    });
});

describe('POST /apps/:appId/export', () => {
    const exportBody = (overrides: Record<string, unknown> = {}) => ({
        source: '$.data.people',
        name: 'People.csv',
        request: {
            columns: [
                { key: 'name', field: 'name', title: 'Name', filter: 'text' },
                { key: 'state', field: 'state', title: 'State', filter: 'select', options: { open: 'Open', done: 'Done' } }
            ],
            filter: '',
            filters: { name: 'a' },
            sortBy: 'name',
            sortDir: 'desc'
        },
        ...overrides
    });
    let exportAppId = '';
    /** An app bound to a dataset of people, one of them with a field no column shows */
    async function seedPeople(): Promise<string> {
        if (exportAppId !== '') return exportAppId;
        const steps: [string, Record<string, unknown>][] = [
            ['ui_model_write', { model: 'person', operations: [{ op: 'set', field: 'name', type: 'string', required: true }, { op: 'set', field: 'state', type: 'string' }, { op: 'set', field: 'secret', type: 'string' }] }],
            ['ui_data_write', { dataset: 'people', model: 'person', operations: [{ op: 'set', path: 'p1', value: { name: 'Ada', state: 'open', secret: 'x' } }, { op: 'set', path: 'p2', value: { name: 'Grace', state: 'done' } }, { op: 'set', path: 'p3', value: { name: 'Hopper', state: 'open' } }] }]
        ];
        for (const [name, args] of steps) {
            const result = await call(harness.client, name, args);
            if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.body)}`);
        }
        exportAppId = (await createApp(harness.client, 'export-people', FORM_ROOT, { data: { people: { dataset: 'people' } } })).id;
        return exportAppId;
    }
    const post = (body: unknown): Promise<Response> => fetch(`${origin}/apps/${exportAppId}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });

    it("should answer a CSV of the instance's records filtered, sorted and cut to the columns, as an attachment", async () => {
        // Arrange
        await seedPeople();

        // Act
        const response = await post(exportBody());

        // Assert
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
        expect(response.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''People.csv");
        expect(response.headers.get('x-export-rows')).toBe('2');
        expect(await response.text()).toBe('Name,State\r\nGrace,Done\r\nAda,Open\r\n');
    });

    it('should refuse a source outside the data, a name that is not a csv, rows in the request and an unknown app', async () => {
        // Arrange
        await seedPeople();

        // Act
        const statuses = [
            (await post(exportBody({ source: '$.server.keys' }))).status,
            (await post(exportBody({ name: 'people.html' }))).status,
            (await post({ ...exportBody(), rows: [] })).status,
            (await post(exportBody({ source: '$.data.nothing' }))).status,
            (await fetch(`${origin}/apps/11111111-1111-4111-8111-111111111111/export`, { method: 'POST', headers: { Origin: origin }, body: JSON.stringify(exportBody()) })).status
        ];

        // Assert
        expect(statuses).toEqual([400, 400, 400, 404, 404]);
    });

    it('should refuse a cross-origin export', async () => {
        // Arrange
        await seedPeople();

        // Act
        const response = await fetch(`${origin}/apps/${exportAppId}/export`, { method: 'POST', headers: { Origin: 'http://evil.test' }, body: JSON.stringify(exportBody()) });

        // Assert
        expect(response.status).toBe(403);
    });
});

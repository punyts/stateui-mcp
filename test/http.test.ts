import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { MAX_FILE_BYTES, MAX_FILES_PER_APP } from '../src/domain/UiFile.js';
import { EXPECTED_TOOLS } from './expectedTools.js';
import { FORM_SHELL, call, createApp, httpHarness, noBrowser, shellOf, tempData } from './helpers.js';
import type { HttpHarness, TempData } from './helpers.js';

const PNG_BYTES = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]);

let data: TempData;
let harness: HttpHarness;
let origin = '';
let appId = '';
let appNamespace = '';

beforeAll(async () => {
    data = await tempData();
    harness = await httpHarness(data.dir, noBrowser);
    origin = harness.server.origin;
    appId = (await createApp(harness.client, 'form', FORM_SHELL)).id;
    const found = await harness.server.services.useCases.findPartApp.execute('form');
    if (found.kind !== 'found') throw new Error('the form app is stored');
    appNamespace = harness.server.services.instanceViews.namespace(found.part);
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
        const created = await createApp(harness.client, 'corner-shop', shellOf({}), { title: 'Corner shop' });
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

    it('should answer an unknown path with 404', async () => {
        expect((await fetch(`${origin}/nothing`)).status).toBe(404);
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

        const response = await fetch(`${origin}/apps/${appId}/files/${stored.id}`);

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
        const quotaApp = (await createApp(harness.client, 'quota', shellOf({}))).id;

        for (let n = 0; n < MAX_FILES_PER_APP; n++) {
            expect((await upload(`/apps/${quotaApp}/files`, Buffer.from(`file ${n}`), `f${n}.txt`)).status).toBe(201);
        }
        const over = await upload(`/apps/${quotaApp}/files`, Buffer.from('one more'), 'more.txt');

        expect(over.status).toBe(409);
        expect(await over.json()).toEqual({ error: 'quota', reason: 'files' });
    });
});

describe('GET /apps/:appId/sync and POST /apps/:appId/report', () => {
    const VIEW = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
    const LIVE_PATH = '$.app.children.form.children.email.value';
    const TYPED_PATH = '$.app.children.form.children.email.value';

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
        socket.on('message', (data) => {
            const message = JSON.parse(String(data)) as Record<string, unknown>;
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
            socket.once('open', () => resolve({ socket, received, next, send: (message) => socket.send(JSON.stringify(message)) }));
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
        view.send({ type: 'hello', namespace: appNamespace, revision: 0, clientId: VIEW, protocol: 1 });
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

describe('/mcp session flow', () => {
    const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const INITIALIZE = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '1' } }
    };

    /** The JSON-RPC message of a response that is either JSON or one server-sent event */
    async function rpc(response: Response): Promise<{ result?: Record<string, unknown>; error?: { code: number } }> {
        const text = await response.text();
        const line = text.split('\n').find((candidate) => candidate.startsWith('data: '));
        return JSON.parse(line === undefined ? text : line.slice(6)) as { result?: Record<string, unknown>; error?: { code: number } };
    }

    it('should open a session on initialize, serve tools/list with its id and close it on DELETE', async () => {
        const init = await fetch(`${origin}/mcp`, { method: 'POST', headers: HEADERS, body: JSON.stringify(INITIALIZE) });
        const sessionId = init.headers.get('mcp-session-id') ?? '';
        const initialized = await rpc(init);
        await fetch(`${origin}/mcp`, { method: 'POST', headers: { ...HEADERS, 'mcp-session-id': sessionId }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
        const list = await rpc(
            await fetch(`${origin}/mcp`, { method: 'POST', headers: { ...HEADERS, 'mcp-session-id': sessionId }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })
        );
        const closed = await fetch(`${origin}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } });
        const afterClose = await fetch(`${origin}/mcp`, { method: 'POST', headers: { ...HEADERS, 'mcp-session-id': sessionId }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) });

        expect(sessionId).not.toBe('');
        expect(initialized.result?.['instructions']).toEqual(expect.stringContaining('Build steps, in this order'));
        expect((list.result?.['tools'] as unknown[]).length).toBe(EXPECTED_TOOLS.length);
        expect(closed.status).toBe(200);
        expect(afterClose.status).toBe(404);
    });

    it('should refuse a request with no session that is not initialize', async () => {
        const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });

        expect(response.status).toBe(400);
    });

    it('should answer a GET for an unknown session with 404 and a body that is not JSON with 400', async () => {
        const unknown = await fetch(`${origin}/mcp`, { headers: { accept: 'text/event-stream', 'mcp-session-id': 'nope' } });
        const garbage = await fetch(`${origin}/mcp`, { method: 'POST', headers: HEADERS, body: '{not json' });

        expect(unknown.status).toBe(404);
        expect(garbage.status).toBe(400);
    });

    it('should keep two sessions apart', async () => {
        const first = await fetch(`${origin}/mcp`, { method: 'POST', headers: HEADERS, body: JSON.stringify(INITIALIZE) });
        const second = await fetch(`${origin}/mcp`, { method: 'POST', headers: HEADERS, body: JSON.stringify(INITIALIZE) });

        expect(first.headers.get('mcp-session-id')).not.toBe(second.headers.get('mcp-session-id'));
        await first.text();
        await second.text();
    });
});

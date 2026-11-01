import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES, MAX_FILES_PER_APP } from '../src/domain/UiFile.js';
import { FORM_DOCUMENT, call, httpHarness, noBrowser, tempData } from './helpers.js';
import type { HttpHarness, TempData } from './helpers.js';

const PNG_BYTES = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]);

let data: TempData;
let harness: HttpHarness;
let origin = '';
let appId = '';

beforeAll(async () => {
    data = await tempData();
    harness = await httpHarness(data.dir, noBrowser);
    origin = harness.server.origin;
    const created = await call(harness.client, 'ui_app_create', { name: 'form <b>bold</b>', document: FORM_DOCUMENT });
    appId = created.body['appId'] as string;
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
    it('should list the apps with a link to each live view and escape the names', async () => {
        const response = await fetch(`${origin}/`);
        const html = await response.text();

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/html');
        expect(html).toContain(`href="/apps/${appId}"`);
        expect(html).toContain('form &lt;b&gt;bold&lt;/b&gt;');
        expect(html).not.toContain('<b>bold</b>');
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
        expect(html).toContain('<title>form &lt;b&gt;bold&lt;/b&gt;</title>');
        expect(csp).toContain("script-src 'self'");
        expect(csp).not.toContain('unsafe');
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain("frame-src 'self'");
    });

    it('should point the frame at the content-hashed runtime page', async () => {
        const html = await (await fetch(`${origin}/apps/${appId}`)).text();
        const runtime = /data-runtime-url="([^"]+)"/.exec(html)?.[1] ?? '';

        const page = await fetch(`${origin}${runtime}`);
        const script = await fetch(`${origin}${runtime.replace('.html', '.js')}`);

        expect(runtime).toMatch(/^\/runtime\/[0-9a-f]{16}\.html$/);
        expect(page.status).toBe(200);
        expect(page.headers.get('content-security-policy')).toContain("script-src 'self' 'unsafe-eval'");
        expect(page.headers.get('content-security-policy')).toContain("connect-src 'none'");
        expect(script.status).toBe(200);
        expect(script.headers.get('cache-control')).toContain('immutable');
        expect((await script.text()).length).toBeGreaterThan(100_000);
        expect((await fetch(`${origin}/runtime/0000000000000000.html`)).status).toBe(404);
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
        const read = await call(harness.client, 'ui_file_read', { appId, fileId: body.id });

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
        const created = await call(harness.client, 'ui_app_create', { name: 'quota' });
        const quotaApp = created.body['appId'] as string;

        for (let n = 0; n < MAX_FILES_PER_APP; n++) {
            expect((await upload(`/apps/${quotaApp}/files`, Buffer.from(`file ${n}`), `f${n}.txt`)).status).toBe(201);
        }
        const over = await upload(`/apps/${quotaApp}/files`, Buffer.from('one more'), 'more.txt');

        expect(over.status).toBe(409);
        expect(await over.json()).toEqual({ error: 'quota', reason: 'files' });
    });
});

describe('GET /apps/:appId/events and POST /apps/:appId/report', () => {
    const VIEW = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';

    async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
        const decoder = new TextDecoder();
        let text = '';
        const deadline = Date.now() + 5000;
        while (!text.includes(needle) && Date.now() < deadline) {
            const { value, done } = await reader.read();
            if (done) break;
            text += decoder.decode(value);
        }
        return text;
    }

    function report(body: Record<string, unknown>): Promise<Response> {
        return fetch(`${origin}/apps/${appId}/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ viewId: VIEW, ...body }) });
    }

    it('should stream the app on connect and every later write, and detach when the view closes', async () => {
        const controller = new AbortController();
        const response = await fetch(`${origin}/apps/${appId}/events?view=${VIEW}&kind=browser`, { signal: controller.signal });
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();

        const first = await readUntil(reader, '"reason":"attach"');
        const attachedWhileOpen = harness.server.services.hub.viewCount(appId);
        await call(harness.client, 'ui_state_set', { appId, path: '$.data.live', value: 'yes' });
        const second = await readUntil(reader, '"reason":"state"');
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(response.headers.get('content-type')).toContain('text/event-stream');
        expect(first).toContain('"type":"app"');
        expect(first).toContain('"component":"panel"');
        expect(attachedWhileOpen).toBe(1);
        expect(second).toContain('"live":"yes"');
        expect(harness.server.services.hub.viewCount(appId)).toBe(0);
    });

    it('should refuse a view id that is not a UUID and an unknown app', async () => {
        const malformed = await fetch(`${origin}/apps/${appId}/events?view=x`);
        const unknown = await fetch(`${origin}/apps/11111111-1111-4111-8111-111111111111/events?view=${VIEW}`);

        expect(malformed.status).toBe(400);
        expect(unknown.status).toBe(404);
    });

    it('should queue an emit report for ui_events_read', async () => {
        const response = await report({ type: 'emit', name: 'form.saved', payload: { ok: true } });
        const events = await call(harness.client, 'ui_events_read', { appId });

        expect(response.status).toBe(200);
        expect((events.body['events'] as { name: string; payload: unknown }[]).at(-1)).toMatchObject({ name: 'form.saved', payload: { ok: true } });
    });

    it('should keep the runtime errors a view reports and show them in ui_validate', async () => {
        const response = await report({ type: 'errors', errors: [{ code: 'SUI-RUN-BINDING', message: 'boom', statePath: '$.app' }, { nope: true }], revision: 1 });
        const validated = await call(harness.client, 'ui_validate', { appId });

        expect(response.status).toBe(200);
        expect((validated.body['preview'] as { errors: { code: string }[] }).errors.map((error) => error.code)).toContain('SUI-RUN-BINDING');
    });

    it('should save a preview snapshot at the rendered revision and refuse a stale one with 409', async () => {
        const current = (await call(harness.client, 'ui_app_get', { appId, depth: 0, path: 'app' })).body['revision'] as number;

        const saved = await report({ type: 'state', revision: current, snapshot: { data: { typed: 'x' }, app: {} } });
        const stale = await report({ type: 'state', revision: current - 1, snapshot: { data: { typed: 'old' }, app: {} } });

        expect(saved.status).toBe(200);
        expect(stale.status).toBe(409);
        expect(((await stale.json()) as { currentRevision: number }).currentRevision).toBe(current);
    });

    it('should refuse a report that is not valid', async () => {
        const noView = await fetch(`${origin}/apps/${appId}/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const unknownType = await report({ type: 'launch' });
        const notJson = await fetch(`${origin}/apps/${appId}/report`, { method: 'POST', body: 'x' });

        expect([noView.status, unknownType.status, notJson.status]).toEqual([400, 400, 400]);
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
        expect(initialized.result?.['instructions']).toEqual(expect.stringContaining('Working loop'));
        expect((list.result?.['tools'] as unknown[]).length).toBe(19);
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

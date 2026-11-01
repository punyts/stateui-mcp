/**
 * The host script of the live view page (`GET /apps/:appId`). It runs in the page, not in Node, and has no imports:
 * the server serves the compiled file as `/assets/host.js` under a policy that allows scripts from the page's own
 * origin only.
 *
 * It does what the minion UI's preview host does for the runtime: it puts the content-hashed runtime page into a
 * sandboxed iframe (`allow-scripts`, so an opaque origin), speaks the versioned message protocol of
 * `@punyts/stateui-app/protocol` with a per-load nonce, and checks every message by source and nonce. Where the
 * minion UI talks to the API over a socket, this host talks to the server over one server-sent event stream (server
 * to view) and `POST /apps/:appId/report` (view to server).
 *
 * `document.body.dataset` tells Playwright what the view shows: `status` is `loading`, `ready` or `failed`, and
 * `revision` is the revision the runtime rendered.
 */

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

const PROTOCOL_VERSION = 1;
const MAX_WRITES = 500;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SNAPSHOT_THROTTLE_MS = 1000;
const ALLOWED_FILE_TYPES = [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'text/csv',
    'text/markdown',
    'application/json'
];

interface PathWrite {
    path: string;
    value?: Json;
    remove?: true;
}

interface AppMessage {
    type: 'app';
    reason: 'attach' | 'document' | 'state';
    revision: number;
    document: JsonRecord;
    stateSnapshot: JsonRecord;
    icons: Record<string, string>;
}

type ServerMessage =
    | AppMessage
    | { type: 'command'; id: string; target: string; command: string; value?: Json; expiresAt: string }
    | { type: 'locale'; locale: string }
    | { type: 'theme'; kind: string; name: string }
    | { type: 'snapshot-request'; requestId: string }
    | { type: 'deleted' };

interface RuntimeMessage {
    v?: unknown;
    nonce?: unknown;
    type?: unknown;
    [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJson(value: unknown): value is Json {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isJson);
    if (isRecord(value)) return Object.values(value).every(isJson);
    return false;
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
    if (isRecord(a) && isRecord(b)) {
        const keys = Object.keys(a);
        return keys.length === Object.keys(b).length && keys.every((key) => key in b && deepEqual(a[key], b[key]));
    }
    return false;
}

const SEGMENT = /^[^.\s]+$/;

/**
 * The leaf writes that turn `a` into `b` below `path`, or false when a write cannot carry the change: an array of
 * another length, a key a path cannot hold, a non-JSON value or too many writes. A key only `a` has is left alone,
 * because a snapshot is sparse (it holds what changed, not everything)
 */
function diffLeaves(path: string, a: unknown, b: unknown, writes: PathWrite[]): boolean {
    if (deepEqual(a, b)) return true;
    if (isRecord(b) && (a === undefined || isRecord(a))) {
        const before = a ?? {};
        for (const key of Object.keys(b)) {
            if (!SEGMENT.test(key)) return false;
            if (!diffLeaves(`${path}.${key}`, before[key], b[key], writes)) return false;
        }
        return writes.length <= MAX_WRITES;
    }
    if (Array.isArray(b) && Array.isArray(a)) {
        if (a.length !== b.length) return false;
        return a.every((item, index) => diffLeaves(`${path}.${index}`, item, b[index], writes));
    }
    if (path === '$.data' || path === '$.app' || !isJson(b)) return false;
    writes.push({ path, value: b });
    return writes.length <= MAX_WRITES;
}

/** A document change as writes: `data` and `app` change through writes, anything else (theme, locales, composed) is a full load */
function planDocumentUpdate(previous: JsonRecord, next: JsonRecord): PathWrite[] | 'none' | 'load' {
    const { data: previousData, app: previousApp, ...previousRest } = previous;
    const { data: nextData, app: nextApp, ...nextRest } = next;
    if (!deepEqual(previousRest, nextRest)) return 'load';
    const writes: PathWrite[] = [];
    const ok = diffDocumentPart('$.data', previousData ?? {}, nextData ?? {}, writes) && diffDocumentPart('$.app', previousApp, nextApp, writes);
    if (!ok || writes.length > MAX_WRITES) return 'load';
    return writes.length === 0 ? 'none' : writes;
}

/** Like `diffLeaves`, but a key that only the old document has is removed: a document is complete, not sparse */
function diffDocumentPart(path: string, a: unknown, b: unknown, writes: PathWrite[]): boolean {
    if (deepEqual(a, b)) return true;
    if (isRecord(a) && isRecord(b)) {
        for (const key of Object.keys(a)) {
            if (key in b) continue;
            if (!SEGMENT.test(key)) return false;
            writes.push({ path: `${path}.${key}`, remove: true });
        }
        for (const key of Object.keys(b)) {
            if (!SEGMENT.test(key)) return false;
            const child = `${path}.${key}`;
            const value = b[key];
            if (!(key in a)) {
                if (!isJson(value)) return false;
                writes.push({ path: child, value });
            } else if (!diffDocumentPart(child, a[key], value, writes)) {
                return false;
            }
        }
        return writes.length <= MAX_WRITES;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        return a.every((item, index) => diffDocumentPart(`${path}.${index}`, item, b[index], writes));
    }
    if (path === '$.data' || path === '$.app' || !isJson(b)) return false;
    writes.push({ path, value: b });
    return writes.length <= MAX_WRITES;
}

function createNonce(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function iconsMessage(icons: Record<string, string>, skip: ReadonlySet<string>): Record<string, { outline: string[] }> | undefined {
    const map: Record<string, { outline: string[] }> = {};
    for (const [name, d] of Object.entries(icons)) if (!skip.has(name)) map[name] = { outline: [d] };
    return Object.keys(map).length > 0 ? map : undefined;
}

/** `{ data, app }` for a load: what the stored snapshot holds, with the document's own data under it, or nothing when it holds neither */
function loadState(document: JsonRecord, snapshot: JsonRecord): { data: Json; app: Json } | undefined {
    const data = snapshot['data'];
    const app = snapshot['app'];
    if (!isRecord(data) && !isRecord(app)) return undefined;
    const documentData = document['data'];
    return {
        data: isRecord(data) ? data : isRecord(documentData) ? documentData : {},
        app: isRecord(app) ? app : {}
    };
}

class LiveView {
    private readonly appId: string;
    private readonly viewId = crypto.randomUUID();
    private readonly viewKind: string;
    private readonly runtimeUrl: string;
    private readonly nonce = createNonce();
    private frame: HTMLIFrameElement | undefined;
    private frameLoaded = false;
    private ready = false;
    private pending: AppMessage | undefined;
    private sentDocument: JsonRecord | undefined;
    private sentState: { data: JsonRecord; app: JsonRecord } = { data: {}, app: {} };
    private runtimeState: { data: JsonRecord; app: JsonRecord } | undefined;
    private readonly sentIcons = new Set<string>();
    private revision = 0;
    private mode: string | undefined;
    private locale: string | undefined;
    private readonly queuedCommands: Extract<ServerMessage, { type: 'command' }>[] = [];
    private snapshotTimer: number | undefined;
    private lastSnapshotAt = 0;
    private snapshotWaiting = false;
    private readonly uploads = new Map<number, XMLHttpRequest>();

    constructor(private readonly body: HTMLElement) {
        this.appId = body.dataset['appId'] ?? '';
        this.viewKind = body.dataset['viewKind'] === 'headless' ? 'headless' : 'browser';
        this.runtimeUrl = body.dataset['runtimeUrl'] ?? '';
        const query = new URLSearchParams(window.location.search);
        this.mode = query.get('mode') ?? undefined;
        this.locale = query.get('locale') ?? undefined;
    }

    start(): void {
        this.setStatus('loading');
        window.addEventListener('message', (event) => this.onRuntimeMessage(event));
        window.addEventListener('pagehide', () => this.flushSnapshot());
        const source = new EventSource(`/apps/${this.appId}/events?view=${this.viewId}&kind=${this.viewKind}`);
        source.addEventListener('message', (event: MessageEvent<string>) => this.onServerMessage(event.data));
    }

    private setStatus(status: 'loading' | 'ready' | 'failed', note?: string): void {
        this.body.dataset['status'] = status;
        if (note !== undefined) this.body.dataset['note'] = note;
        else delete this.body.dataset['note'];
    }

    private report(body: Record<string, unknown>): void {
        void fetch(`/apps/${this.appId}/report`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ viewId: this.viewId, ...body }),
            keepalive: true
        }).catch(() => undefined);
    }

    private post(message: Record<string, unknown>): void {
        this.frame?.contentWindow?.postMessage({ v: PROTOCOL_VERSION, nonce: this.nonce, ...message }, '*');
    }

    private onServerMessage(text: string): void {
        let message: ServerMessage;
        try {
            message = JSON.parse(text) as ServerMessage;
        } catch {
            return;
        }
        switch (message.type) {
            case 'app':
                this.onApp(message);
                break;
            case 'command':
                this.onCommand(message);
                break;
            case 'locale':
                this.locale = message.locale;
                if (this.ready) this.post({ type: 'locale', locale: message.locale });
                break;
            case 'theme':
                if (message.kind === 'mode') this.mode = message.name;
                if (this.ready) this.post({ type: 'theme', kind: message.kind, name: message.name });
                break;
            case 'snapshot-request':
                this.report({ type: 'snapshot-reply', requestId: message.requestId, snapshot: this.runtimeState ?? null });
                break;
            case 'deleted':
                this.setStatus('failed', 'This app was deleted');
                this.frame?.remove();
                this.frame = undefined;
                break;
        }
    }

    private ensureFrame(): void {
        if (this.frame !== undefined) return;
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.title = 'App';
        frame.addEventListener('load', () => {
            this.frameLoaded = true;
            if (this.pending !== undefined) {
                const app = this.pending;
                this.pending = undefined;
                this.sendLoad(app);
            }
        });
        frame.src = `${this.runtimeUrl}#${this.nonce}`;
        this.body.append(frame);
        this.frame = frame;
    }

    private onApp(app: AppMessage): void {
        this.ensureFrame();
        if (!this.frameLoaded) {
            this.pending = app;
            return;
        }
        if (this.sentDocument === undefined || !this.ready) {
            this.sendLoad(app);
            return;
        }
        if (app.reason === 'state') {
            this.applyState(app);
            return;
        }
        const plan = planDocumentUpdate(this.sentDocument, app.document);
        if (plan === 'load') {
            this.sendLoad(app);
            return;
        }
        if (plan !== 'none') {
            const icons = iconsMessage(app.icons, this.sentIcons);
            this.post({ type: 'write', writes: plan, ...(icons !== undefined && { icons }) });
            Object.keys(app.icons).forEach((name) => this.sentIcons.add(name));
        }
        this.sentDocument = app.document;
        this.markRendered(app.revision);
    }

    private applyState(app: AppMessage): void {
        const base = this.runtimeState ?? this.sentState;
        const writes: PathWrite[] = [];
        const snapshotData = app.stateSnapshot['data'];
        const snapshotApp = app.stateSnapshot['app'];
        const ok =
            (snapshotData === undefined || diffLeaves('$.data', base.data, snapshotData, writes)) &&
            (snapshotApp === undefined || diffLeaves('$.app', base.app, snapshotApp, writes));
        if (!ok) {
            this.sendLoad(app);
            return;
        }
        if (writes.length > 0) this.post({ type: 'write', writes });
        this.markRendered(app.revision);
    }

    private sendLoad(app: AppMessage): void {
        const state = loadState(app.document, app.stateSnapshot);
        const icons = iconsMessage(app.icons, new Set());
        this.ready = false;
        this.setStatus('loading');
        this.post({ type: 'load', document: app.document, ...(state !== undefined && { state }), ...(icons !== undefined && { icons }) });
        this.sentDocument = app.document;
        this.sentState = {
            data: state !== undefined && isRecord(state.data) ? state.data : {},
            app: state !== undefined && isRecord(state.app) ? state.app : {}
        };
        this.runtimeState = undefined;
        this.sentIcons.clear();
        Object.keys(app.icons).forEach((name) => this.sentIcons.add(name));
        this.revision = app.revision;
    }

    private markRendered(revision: number): void {
        this.revision = revision;
        this.body.dataset['revision'] = String(revision);
        this.report({ type: 'rendered', revision });
    }

    private onCommand(command: Extract<ServerMessage, { type: 'command' }>): void {
        if (Date.parse(command.expiresAt) <= Date.now()) return;
        if (!this.ready) {
            this.queuedCommands.push(command);
            return;
        }
        this.sendCommand(command);
    }

    private sendCommand(command: Extract<ServerMessage, { type: 'command' }>): void {
        const target = command.target.startsWith('$.') ? command.target : `$.${command.target}`;
        this.post({ type: 'command', target, command: command.command, ...(command.value !== undefined && { value: command.value }) });
    }

    private onRuntimeMessage(event: MessageEvent<unknown>): void {
        if (this.frame === undefined || event.source !== this.frame.contentWindow) return;
        const message = event.data as RuntimeMessage;
        if (!isRecord(message) || message['v'] !== PROTOCOL_VERSION || message['nonce'] !== this.nonce) return;
        switch (message['type']) {
            case 'ready':
                this.onReady();
                break;
            case 'snapshot':
                this.onSnapshot(message);
                break;
            case 'emit':
                if (typeof message['name'] === 'string') {
                    this.report({ type: 'emit', name: message['name'], ...(message['payload'] !== undefined && { payload: message['payload'] }) });
                }
                break;
            case 'error':
                if (Array.isArray(message['errors'])) this.report({ type: 'errors', errors: message['errors'], revision: this.revision });
                break;
            case 'file':
                this.onFile(message);
                break;
            case 'fileCancel':
                if (typeof message['requestId'] === 'number') this.uploads.get(message['requestId'])?.abort();
                break;
            default:
                break;
        }
    }

    private onReady(): void {
        this.ready = true;
        this.body.dataset['revision'] = String(this.revision);
        this.setStatus('ready');
        // A load mounts the app again from the document, so the language and the theme are sent again after it
        if (this.mode !== undefined) this.post({ type: 'theme', kind: 'mode', name: this.mode });
        if (this.locale !== undefined) this.post({ type: 'locale', locale: this.locale });
        for (const command of this.queuedCommands.splice(0)) {
            if (Date.parse(command.expiresAt) > Date.now()) this.sendCommand(command);
        }
        this.report({ type: 'ready', revision: this.revision });
    }

    private onSnapshot(message: RuntimeMessage): void {
        const data = message['data'];
        const app = message['app'];
        if (!isRecord(data) || !isRecord(app)) return;
        this.runtimeState = { data, app };
        this.snapshotWaiting = true;
        const wait = Math.max(0, SNAPSHOT_THROTTLE_MS - (Date.now() - this.lastSnapshotAt));
        if (this.snapshotTimer !== undefined) return;
        this.snapshotTimer = window.setTimeout(() => this.flushSnapshot(), wait);
    }

    private flushSnapshot(): void {
        if (this.snapshotTimer !== undefined) {
            window.clearTimeout(this.snapshotTimer);
            this.snapshotTimer = undefined;
        }
        if (!this.snapshotWaiting || this.runtimeState === undefined) return;
        this.snapshotWaiting = false;
        this.lastSnapshotAt = Date.now();
        this.report({ type: 'state', revision: this.revision, snapshot: this.runtimeState });
    }

    private onFile(message: RuntimeMessage): void {
        const requestId = message['requestId'];
        const name = message['name'];
        const size = message['size'];
        const mediaType = message['mediaType'];
        const data = message['data'];
        if (typeof requestId !== 'number' || typeof name !== 'string' || typeof size !== 'number' || typeof mediaType !== 'string') return;
        if (!(data instanceof ArrayBuffer)) return;
        if (size > MAX_FILE_BYTES) {
            this.fileFailed(requestId, 'too_large', 'The file is larger than 10 MiB');
            return;
        }
        const bare = (mediaType.split(';')[0] ?? '').trim().toLowerCase();
        if (!ALLOWED_FILE_TYPES.includes(bare)) {
            this.fileFailed(requestId, 'unsupported_type', 'This file type is not allowed');
            return;
        }
        const form = new FormData();
        form.append('file', new Blob([data], { type: bare }), name);
        const request = new XMLHttpRequest();
        this.uploads.set(requestId, request);
        request.open('POST', `/apps/${this.appId}/files`);
        request.upload.addEventListener('progress', (event) => {
            if (event.lengthComputable) this.post({ type: 'fileProgress', requestId, loaded: event.loaded, total: event.total });
        });
        request.addEventListener('load', () => {
            this.uploads.delete(requestId);
            if (request.status === 201) {
                try {
                    const file = JSON.parse(request.responseText) as unknown;
                    if (isRecord(file)) {
                        this.post({ type: 'fileResult', requestId, ok: true, file: { id: file['id'], name: file['name'], size: file['size'], type: file['type'] } });
                        return;
                    }
                } catch {
                    // falls through to the internal error
                }
                this.fileFailed(requestId, 'internal', 'The server answered something unreadable');
                return;
            }
            const codes: Record<number, string> = { 404: 'not_found', 409: 'quota', 413: 'too_large', 415: 'unsupported_type' };
            this.fileFailed(requestId, codes[request.status] ?? 'internal', `The upload was refused (${request.status})`);
        });
        request.addEventListener('error', () => {
            this.uploads.delete(requestId);
            this.fileFailed(requestId, 'offline', 'The server could not be reached');
        });
        request.addEventListener('abort', () => {
            this.uploads.delete(requestId);
        });
        request.send(form);
    }

    private fileFailed(requestId: number, code: string, message: string): void {
        this.post({ type: 'fileResult', requestId, ok: false, code, message });
    }
}

new LiveView(document.body).start();

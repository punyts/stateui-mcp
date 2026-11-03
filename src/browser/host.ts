/**
 * The host script of the live view page (`GET /apps/:appId`). It runs in the page, not in Node. The server serves it
 * bundled (esbuild, with `@punyts/state-sync`) as `/assets/host.js` under a policy that allows scripts from the page's
 * own origin only.
 *
 * It does what the minion UI's preview host does for the runtime: it puts the content-hashed runtime page into a
 * sandboxed iframe served from the runtime origin (the server's second port, `allow-scripts allow-same-origin`: the
 * frame keeps that origin, which is not the page's, so it cannot reach the page; a browser that refuses frames with an
 * opaque origin still shows it), speaks the versioned message protocol of `@punyts/stateui-app/protocol` with a
 * per-load nonce, and checks every message by source, origin and nonce.
 *
 * The app runs in Full mode: one WebSocket (`/apps/:appId/sync`) carries the state-sync protocol between the page's
 * sync client and the app's authority on the server, and `{ type: 'view', message }` frames from the server (the
 * document, commands, locale, theme, deletion). The sync client keeps the confirmed state and the changes not yet
 * acknowledged in `localStorage`, with the document beside them, so the app opens and takes changes offline and sends
 * them when the socket is back.
 *
 * A Persisted app (`data-statenet-url` on the body) has no server logic: the sync client connects straight to the
 * statenet, and the socket to the server carries only the view frames, reconnecting on its own.
 * `POST /apps/:appId/report` tells the server when the view is ready, what it rendered
 * and its errors.
 *
 * `document.body.dataset` tells Playwright what the view shows: `status` is `loading`, `ready` or `failed`, `revision`
 * is the document revision the runtime rendered, and `sync` is the sync status (`connecting`, `online`, `offline`).
 */

import { createMemoryLocalStore, createSyncClient, createWebLocalStore } from '@punyts/state-sync';
import type { JsonValue, LocalChange, LocalStore, StoreBridge, SyncClient, SyncState, SyncStatusReport, SyncTransport } from '@punyts/state-sync';

type Json = JsonValue;
type JsonRecord = { [key: string]: Json };

/** The app events an app server's logic sends to the views: failures and `notify.<name>` */
function isLogicEvent(name: string): boolean {
    return name === 'logic.failed' || /^notify\.[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name);
}

/** The synced part of the runtime store that the frame shows */
interface ViewState {
    data: JsonRecord;
    app: JsonRecord;
}

type ChangeOp = 'set' | 'replace' | 'merge' | 'delete';

const PROTOCOL_VERSION = 1;
const MAX_WRITES = 500;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
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
/** Keys of a node that belong to the document, never to the synced state */
const NODE_KEYS: readonly string[] = ['component', 'on', 'layout', 'placement', 'theme'];
const CONTENT_PREFIX = '_';
const SEGMENT = /^[^.\s]+$/;
const VIEW_FRAME = '{"type":"view"';

interface PathWrite {
    path: string;
    value?: Json;
    remove?: true;
}

interface AppMessage {
    type: 'app';
    reason: 'attach' | 'document';
    revision: number;
    document: JsonRecord;
    icons: Record<string, string>;
}

type ServerMessage =
    | AppMessage
    | { type: 'command'; id: string; target: string; command: string; value?: Json; expiresAt: string }
    | { type: 'locale'; locale: string }
    | { type: 'theme'; kind: string; name: string }
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

function copy<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
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

/** The writes that turn `a` into `b` below `path`; a key that only `a` has is removed. False when writes cannot carry it */
function diffComplete(path: string, a: unknown, b: unknown, writes: PathWrite[]): boolean {
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
            } else if (!diffComplete(child, a[key], value, writes)) {
                return false;
            }
        }
        return writes.length <= MAX_WRITES;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        return a.every((item, index) => diffComplete(`${path}.${index}`, item, b[index], writes));
    }
    if (path === '$.data' || path === '$.app' || !isJson(b)) return false;
    writes.push({ path, value: b });
    return writes.length <= MAX_WRITES;
}

/**
 * The writes that turn the articulation `before` into `after` below `path` in `$.app`, where the frame holds the whole
 * node tree of the document and the synced state holds only the articulation. It descends while the document has an
 * object at the path (a node, or an object property) and writes a value whole below it, so the runtime store, which
 * creates no parents, finds the parent. A value the state no longer has cannot be put back by a write: false, a load
 */
function diffArticulation(path: string, before: unknown, after: unknown, documentValue: unknown, writes: PathWrite[]): boolean {
    if (deepEqual(before, after)) return true;
    if (after === undefined || path === '$.app' ? !isRecord(after) : false) return false;
    if (isRecord(after) && isRecord(documentValue)) {
        if (isRecord(before) && Object.keys(before).some((key) => !(key in after))) return false;
        for (const key of Object.keys(after)) {
            if (!SEGMENT.test(key)) return false;
            if (!diffArticulation(`${path}.${key}`, isRecord(before) ? before[key] : undefined, after[key], documentValue[key], writes)) return false;
        }
        return writes.length <= MAX_WRITES;
    }
    if (path === '$.app') return false;
    writes.push({ path, value: after as Json });
    return writes.length <= MAX_WRITES;
}

/** A document change as writes: the `app` tree changes through writes, anything else (theme, locales, composed) is a full load. `data` is the synced state's */
function planDocumentUpdate(previous: JsonRecord, next: JsonRecord): PathWrite[] | 'none' | 'load' {
    const { data: _previousData, app: previousApp, ...previousRest } = previous;
    const { data: _nextData, app: nextApp, ...nextRest } = next;
    if (!deepEqual(previousRest, nextRest)) return 'load';
    const writes: PathWrite[] = [];
    if (!diffComplete('$.app', previousApp, nextApp, writes) || writes.length > MAX_WRITES) return 'load';
    return writes.length === 0 ? 'none' : writes;
}

/** Content and the structure keys of a node cut out of a value below `$.app`; undefined when nothing is left */
function articulation(value: Json): Json | undefined {
    if (Array.isArray(value)) {
        const items = value.map(articulation).filter((item): item is Json => item !== undefined);
        return items.length === 0 && value.length > 0 ? undefined : items;
    }
    if (!isRecord(value)) return value;
    const isNode = typeof value['component'] === 'string';
    const kept: JsonRecord = {};
    for (const [key, item] of Object.entries(value)) {
        if (key.startsWith(CONTENT_PREFIX) || (isNode && NODE_KEYS.includes(key))) continue;
        const part = articulation(item);
        if (part !== undefined) kept[key] = part;
    }
    return Object.keys(kept).length === 0 && Object.keys(value).length > 0 ? undefined : kept;
}

/**
 * The part of a runtime change that is synced, or undefined: `$.data`, and below `$.app` the articulation (no `_`
 * content, no `component`, `on`, `layout`, `placement` or `theme` of a node). `$.theme` and `$.locale` stay in the view
 */
function toSyncedChange(path: string, op: ChangeOp, value: Json | undefined): { path: string; op: ChangeOp; value?: Json } | undefined {
    const segments = path.split('.');
    const branch = segments[1];
    if (segments[0] !== '$' || (branch !== 'data' && branch !== 'app') || !segments.every((segment) => SEGMENT.test(segment))) return undefined;
    let kept = value;
    if (branch === 'app') {
        const below = segments.slice(2);
        if (below.some((segment) => segment.startsWith(CONTENT_PREFIX))) return undefined;
        if (below.length > 0 && NODE_KEYS.includes(below[below.length - 1] as string)) return undefined;
        if (kept !== undefined) {
            kept = articulation(kept);
            if (kept === undefined) return undefined;
        }
    }
    if (op === 'delete') return { path, op };
    return kept === undefined ? undefined : { path, op, value: kept };
}

/** Applies one change to a view state in place, as the sync client does: missing parents are created, a delete below one does nothing */
function applyTo(state: ViewState, path: string, op: ChangeOp, value: Json | undefined): void {
    const [, branch, ...rest] = path.split('.') as [string, 'data' | 'app', ...string[]];
    if (rest.length === 0) {
        state[branch] = op === 'delete' || !isRecord(value) ? {} : copy(value);
        return;
    }
    let container: Record<string, unknown> = state[branch];
    for (const segment of rest.slice(0, -1)) {
        let child = container[segment];
        if (typeof child !== 'object' || child === null) {
            if (op === 'delete') return;
            child = {};
            container[segment] = child;
        }
        container = child as Record<string, unknown>;
    }
    const last = rest[rest.length - 1] as string;
    if (op === 'delete') {
        if (Array.isArray(container) && /^\d+$/.test(last)) container.splice(Number(last), 1);
        else delete container[last];
    } else if (op === 'merge' && isRecord(container[last]) && isRecord(value)) {
        container[last] = { ...(container[last] as JsonRecord), ...copy(value) };
    } else {
        container[last] = copy(value);
    }
}

function viewState(state: SyncState): ViewState {
    return { data: isRecord(state['data']) ? copy(state['data']) : {}, app: isRecord(state['app']) ? copy(state['app']) : {} };
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

function isAppMessage(value: unknown): value is AppMessage {
    return isRecord(value) && value['type'] === 'app' && typeof value['revision'] === 'number' && isRecord(value['document']) && isRecord(value['icons']);
}

/** `localStorage`, or memory when the page may not use it */
function localStore(): LocalStore {
    try {
        window.localStorage.getItem('stateui');
        return createWebLocalStore(window.localStorage, 'stateui-sync');
    } catch {
        return createMemoryLocalStore();
    }
}

class LiveView {
    private readonly appId: string;
    private readonly viewId = crypto.randomUUID();
    private readonly viewKind: string;
    private readonly runtimeUrl: string;
    private readonly runtimeOrigin: string;
    private readonly namespace: string;
    /** The statenet's URL for a Persisted app; `undefined` in Full mode */
    private readonly statenetUrl: string | undefined;
    private readonly syncMode: 'full' | 'persisted';
    private viewSocket: WebSocket | undefined;
    private viewRetry = 0;
    private stopped = false;
    private readonly store = localStore();
    private readonly nonce = createNonce();
    private client: SyncClient | undefined;
    private frame: HTMLIFrameElement | undefined;
    private frameLoaded = false;
    /** A load was posted to the frame: from here on state goes to it as writes */
    private loaded = false;
    private ready = false;
    /** The document the view shows or will show */
    private app: AppMessage | undefined;
    private sentDocument: JsonRecord | undefined;
    /** The synced state as the sync client shows it; undefined until it has one */
    private synced: ViewState | undefined;
    /** The synced part of what the frame holds, as far as the host knows */
    private shown: ViewState = { data: {}, app: {} };
    private readonly listeners = new Set<(changes: LocalChange[]) => void>();
    private syncStatus: { mode: 'full' | 'persisted'; status: string; waiting: number };
    private readonly sentIcons = new Set<string>();
    private revision = 0;
    private mode: string | undefined;
    private locale: string | undefined;
    private readonly queuedCommands: Extract<ServerMessage, { type: 'command' }>[] = [];
    private readonly uploads = new Map<number, XMLHttpRequest>();

    constructor(private readonly body: HTMLElement) {
        this.appId = body.dataset['appId'] ?? '';
        this.viewKind = body.dataset['viewKind'] === 'headless' ? 'headless' : 'browser';
        this.runtimeUrl = body.dataset['runtimeUrl'] ?? '';
        this.runtimeOrigin = new URL(this.runtimeUrl, window.location.href).origin;
        this.namespace = `apps.${this.appId.toLowerCase()}`;
        this.statenetUrl = body.dataset['statenetUrl'] || undefined;
        this.syncMode = this.statenetUrl === undefined ? 'full' : 'persisted';
        this.syncStatus = { mode: this.syncMode, status: 'connecting', waiting: 0 };
        const query = new URLSearchParams(window.location.search);
        this.mode = query.get('mode') ?? undefined;
        this.locale = query.get('locale') ?? undefined;
    }

    start(): void {
        this.setStatus('loading');
        this.body.dataset['sync'] = 'connecting';
        window.addEventListener('message', (event) => this.onRuntimeMessage(event));
        const cached: unknown = this.store.read(this.namespace, 'document');
        if (isAppMessage(cached)) this.onApp({ type: 'app', reason: 'attach', revision: cached.revision, document: cached.document, icons: cached.icons });
        this.client = createSyncClient({
            namespace: this.namespace,
            bridge: this.bridge(),
            transport: this.transport(),
            localStore: this.store,
            clientId: this.viewId,
            onStatus: (report) => this.onSyncStatus(report),
            onEmit: (name, value) => {
                if (this.loaded && isLogicEvent(name)) this.post({ type: 'event', name, ...(value === undefined ? {} : { payload: value }) });
            },
            onRejected: (rejection) => {
                if (this.loaded) this.post({ type: 'event', name: 'sync.rejected', payload: { path: rejection.path, reason: rejection.reason } });
            }
        });
        this.client.start();
        if (this.statenetUrl !== undefined) this.openViewSocket();
    }

    /** The sync client's view of the frame: state comes in as loads and writes, the frame's own changes go out */
    private bridge(): StoreBridge {
        return {
            load: (state) => this.showState(viewState(state)),
            write: (path, value) => {
                const next = copy(this.synced ?? this.shown);
                applyTo(next, path, value === undefined ? 'delete' : 'set', value);
                this.showState(next);
            },
            subscribe: (onChanges) => {
                this.listeners.add(onChanges);
                return () => this.listeners.delete(onChanges);
            }
        };
    }

    private viewSocketUrl(): string {
        return `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/apps/${this.appId}/sync?view=${this.viewId}&kind=${this.viewKind}`;
    }

    /** A Persisted app's socket to the server, for the view frames only; it reconnects with a growing delay */
    private openViewSocket(): void {
        if (this.stopped) return;
        const socket = new WebSocket(this.viewSocketUrl());
        this.viewSocket = socket;
        socket.addEventListener('open', () => {
            this.viewRetry = 0;
        });
        socket.addEventListener('message', (event: MessageEvent<unknown>) => {
            if (typeof event.data === 'string' && event.data.startsWith(VIEW_FRAME)) this.onViewFrame(event.data);
        });
        socket.addEventListener('close', () => {
            if (this.stopped || this.viewSocket !== socket) return;
            const delay = Math.min(30_000, 500 * 2 ** this.viewRetry++);
            window.setTimeout(() => this.openViewSocket(), delay);
        });
    }

    /**
     * The sync client's WebSocket. Full mode: the page's socket to the server, where view frames go to the host and
     * everything else to the sync client. Persisted mode: a socket to the statenet, sync only
     */
    private transport(): SyncTransport {
        const persisted = this.statenetUrl !== undefined;
        const url = this.statenetUrl ?? this.viewSocketUrl();
        return {
            connect: (handlers) => {
                const socket = new WebSocket(url);
                let closed = false;
                socket.addEventListener('open', () => handlers.onOpen());
                socket.addEventListener('message', (event: MessageEvent<unknown>) => {
                    if (typeof event.data !== 'string') return;
                    if (!persisted && event.data.startsWith(VIEW_FRAME)) this.onViewFrame(event.data);
                    else handlers.onMessage(event.data);
                });
                socket.addEventListener('close', () => {
                    if (closed) return;
                    closed = true;
                    handlers.onClose();
                });
                return {
                    send: (text) => {
                        if (socket.readyState === WebSocket.OPEN) socket.send(text);
                    },
                    close: () => socket.close()
                };
            }
        };
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
        this.frame?.contentWindow?.postMessage({ v: PROTOCOL_VERSION, nonce: this.nonce, ...message }, this.runtimeOrigin);
    }

    private onViewFrame(text: string): void {
        let frame: { message?: ServerMessage };
        try {
            frame = JSON.parse(text) as { message?: ServerMessage };
        } catch {
            return;
        }
        const message = frame.message;
        if (!isRecord(message as unknown)) return;
        switch (message?.type) {
            case 'app':
                if (!isAppMessage(message)) return;
                try {
                    this.store.write(this.namespace, 'document', { type: 'app', reason: 'attach', revision: message.revision, document: message.document, icons: message.icons });
                } catch {
                    // a full local store keeps the app working in memory; the document comes again with the next connection
                }
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
            case 'deleted':
                this.stopped = true;
                this.viewSocket?.close();
                this.client?.stop();
                for (const part of ['confirmed', 'outbox', 'document'] as const) this.store.remove(this.namespace, part);
                this.setStatus('failed', 'This app was deleted');
                this.frame?.remove();
                this.frame = undefined;
                break;
        }
    }

    private onSyncStatus(report: SyncStatusReport): void {
        this.syncStatus = { mode: this.syncMode, status: report.status, waiting: report.waiting };
        this.body.dataset['sync'] = report.status;
        if (this.loaded) this.post({ type: 'write', writes: [{ path: '$.runtime.sync', value: this.syncStatus }] });
    }

    private ensureFrame(): void {
        if (this.frame !== undefined) return;
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        frame.title = 'App';
        frame.addEventListener('load', () => {
            this.frameLoaded = true;
            if (this.app !== undefined) this.sendLoad();
        });
        frame.src = `${this.runtimeUrl}#${this.nonce}`;
        this.body.append(frame);
        this.frame = frame;
    }

    private onApp(app: AppMessage): void {
        const previous = this.app;
        this.app = app;
        this.ensureFrame();
        if (!this.frameLoaded) return;
        if (!this.loaded || this.sentDocument === undefined || previous === undefined) {
            this.sendLoad();
            return;
        }
        const plan = planDocumentUpdate(this.sentDocument, app.document);
        if (plan === 'load') {
            this.sendLoad();
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

    /** Shows a synced state: as writes once the frame has a load, else it goes into the next load */
    private showState(next: ViewState): void {
        this.synced = next;
        if (!this.loaded || this.app === undefined) return;
        const writes: PathWrite[] = [];
        const ok =
            diffComplete('$.data', this.shown.data, next.data, writes) &&
            diffArticulation('$.app', this.shown.app, next.app, this.app.document['app'], writes);
        if (!ok) {
            this.sendLoad();
            return;
        }
        this.shown = copy(next);
        if (writes.length > 0) this.post({ type: 'write', writes });
    }

    private sendLoad(): void {
        const app = this.app;
        if (app === undefined || !this.frameLoaded) return;
        const icons = iconsMessage(app.icons, new Set());
        const documentData = app.document['data'];
        this.shown = this.synced !== undefined ? copy(this.synced) : { data: isRecord(documentData) ? copy(documentData) : {}, app: {} };
        this.ready = false;
        this.setStatus('loading');
        this.post({
            type: 'load',
            document: app.document,
            mode: this.syncMode,
            ...(this.synced !== undefined && { state: this.synced }),
            ...(icons !== undefined && { icons })
        });
        this.post({ type: 'write', writes: [{ path: '$.runtime.sync', value: this.syncStatus }] });
        this.loaded = true;
        this.sentDocument = app.document;
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
        if (this.frame === undefined || event.source !== this.frame.contentWindow || event.origin !== this.runtimeOrigin) return;
        const message = event.data as RuntimeMessage;
        if (!isRecord(message) || message['v'] !== PROTOCOL_VERSION || message['nonce'] !== this.nonce) return;
        switch (message['type']) {
            case 'ready':
                this.onReady();
                break;
            case 'change':
                this.onChange(message['change']);
                break;
            case 'emit':
                if (typeof message['name'] === 'string') this.client?.emit(message['name'], message['payload'] as Json | undefined);
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

    /** A change the user made in the frame: what is synced goes to the sync client, which sends it or keeps it for later */
    private onChange(change: unknown): void {
        if (!isRecord(change) || typeof change['path'] !== 'string') return;
        const op = change['op'];
        if (op !== 'set' && op !== 'replace' && op !== 'merge' && op !== 'delete') return;
        const value = change['value'];
        if (value !== undefined && !isJson(value)) return;
        const synced = toSyncedChange(change['path'], op, value);
        if (synced === undefined) return;
        applyTo(this.shown, synced.path, synced.op, synced.value);
        if (this.synced !== undefined) applyTo(this.synced, synced.path, synced.op, synced.value);
        const local: LocalChange = { id: crypto.randomUUID(), ...synced };
        for (const listener of [...this.listeners]) listener([local]);
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

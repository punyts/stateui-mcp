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
 * An owner app (`data-namespace` on the body, `instances.<persona>.<ownerId>.<appId>`) syncs with the default
 * persona's instance: besides `$.data` and `$.app`, its state holds the articulation of each screen (`$.screens`) and
 * the route (`$.route`). A load lays that state over the assembled app as the runtime's `instance`; a route another
 * view moved arrives as a `navigate` command, since the runtime protects `$.route`. `?screen=<name>&params=<json>` in
 * the page URL navigates there once the app is ready.
 *
 * Files: a `file` from the runtime is uploaded to `POST /apps/:appId/files` (answered with `fileProgress` and
 * `fileResult`), and a `fileRead` is fetched from `GET /apps/:appId/files/:fileId` (`fileRead.ts`) and answered with
 * `fileData`, its bytes in the transfer list. A `fileRelease` is sent as `DELETE /apps/:appId/files/:fileId`
 * (`fileRelease.ts`) and answered with `fileReleased`: `ok: true` when the file is gone or was never there, and also when
 * the server keeps it because the app or its live state still references it (`409`; the sweep removes it later). The
 * DELETE waits until the sync client has no change waiting for its ack (at most `RELEASE_SETTLE_MS`), so the write that
 * let go of the file reaches the server first.
 *
 * `POST /apps/:appId/report` tells the server when the view is ready, what it rendered
 * and its errors.
 *
 * `document.body.dataset` tells Playwright what the view shows: `status` is `loading`, `ready` or `failed`, `revision`
 * is the document revision the runtime rendered, and `sync` is the sync status (`connecting`, `online`, `offline`).
 */

import { createMemoryLocalStore, createSyncClient, createWebLocalStore } from '@punyts/state-sync';
import { MAX_WRITES, SEGMENT, copy, deepEqual, diffComplete, isJson, isRecord, planDocumentUpdate } from './documentUpdate.js';
import type { Json, JsonRecord, PathWrite } from './documentUpdate.js';
import { readStoredFile } from './fileRead.js';
import { createReleaseGate, releaseStoredFile } from './fileRelease.js';
import { ALLOWED_FILE_TYPES } from '../domain/UiFile.js';
import type { LocalChange, LocalStore, StoreBridge, SyncClient, SyncState, SyncStatusReport, SyncTransport } from '@punyts/state-sync';

/** The app events an app server's logic sends to the views: failures and `notify.<name>` */
function isLogicEvent(name: string): boolean {
    return name === 'logic.failed' || /^notify\.[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name);
}

/** The synced part of the runtime store that the frame shows; `screens` and `route` only for an owner app's instance */
interface ViewState {
    data: JsonRecord;
    app: JsonRecord;
    screens: JsonRecord;
    route?: Json;
    /** An instance's `{ active }`: the persona's choice of theme and overlays (`$.theme.active`) */
    theme?: Json;
}

type ChangeOp = 'set' | 'replace' | 'merge' | 'delete';

const PROTOCOL_VERSION = 1;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** The hash that names a chunk script beside the runtime page, as `load.chunks` takes it */
const CHUNK_HASH = /^[0-9a-f]{16}$/;
/** Keys of a node that belong to the document, never to the synced state */
const NODE_KEYS: readonly string[] = ['component', 'on', 'layout', 'placement', 'theme'];
const CONTENT_PREFIX = '_';
const VIEW_FRAME = '{"type":"view"';

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

/**
 * The writes that turn the articulation `before` into `after` below `path` in `$.app`, where the frame holds the whole
 * node tree of the document and the synced state holds only the articulation. It descends while the document has an
 * object at the path (a node, or an object property) and writes a value whole below it, so the runtime store, which
 * creates no parents, finds the parent. A value the state no longer has cannot be put back by a write: false, a load
 */
/** The properties a record view takes its records in */
const RECORD_COLLECTIONS = ['records', 'items'];

/** `$.app` and `$.screens.{name}`: the root of a node tree, which only a load mounts */
function isTreeRoot(path: string): boolean {
    return path === '$.app' || /^\$\.screens\.[^.]+$/.test(path);
}

function diffArticulation(path: string, before: unknown, after: unknown, documentValue: unknown, writes: PathWrite[]): boolean {
    if (deepEqual(before, after)) return true;
    if (after === undefined || isTreeRoot(path) ? !isRecord(after) : false) return false;
    if (isRecord(after) && isRecord(documentValue)) {
        if (isRecord(before) && Object.keys(before).some((key) => !(key in after))) return false;
        for (const key of Object.keys(after)) {
            if (!SEGMENT.test(key)) return false;
            if (RECORD_COLLECTIONS.includes(key) && typeof documentValue['component'] === 'string') {
                // A record view's collection is written whole (a query), so it replaces the document's records
                if (!deepEqual(isRecord(before) ? before[key] : undefined, after[key])) writes.push({ path: `${path}.${key}`, value: after[key] as Json });
                continue;
            }
            if (!diffArticulation(`${path}.${key}`, isRecord(before) ? before[key] : undefined, after[key], documentValue[key], writes)) return false;
        }
        return writes.length <= MAX_WRITES;
    }
    if (isTreeRoot(path)) return false;
    writes.push({ path, value: after as Json });
    return writes.length <= MAX_WRITES;
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
 * content, no `component`, `on`, `layout`, `placement` or `theme` of a node). An instance also syncs the articulation
 * below `$.screens.{name}`, `$.route` and `$.theme.active` (the persona's choice of theme and overlays, never the
 * tokens). `$.locale` stays in the view
 */
function toSyncedChange(path: string, op: ChangeOp, value: Json | undefined, instance: boolean): { path: string; op: ChangeOp; value?: Json } | undefined {
    const segments = path.split('.');
    const branch = segments[1];
    const branches = instance ? ['data', 'app', 'screens', 'route', 'theme'] : ['data', 'app'];
    if (segments[0] !== '$' || branch === undefined || !branches.includes(branch) || !segments.every((segment) => SEGMENT.test(segment))) return undefined;
    if (branch === 'theme') {
        // Only the active names, one string per kind (and theme), as the instance keeps them
        if (segments[2] !== 'active' || segments.length > 4) return undefined;
        if (op === 'delete') return { path, op };
        if (segments.length === 4 ? typeof value !== 'string' : !isRecord(value) || !Object.values(value).every((name) => typeof name === 'string')) return undefined;
        return { path, op, value: value as Json };
    }
    let kept = value;
    if (branch === 'app' || branch === 'screens') {
        const below = segments.slice(branch === 'app' ? 2 : 3);
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
    const [, branch, ...rest] = path.split('.') as [string, keyof ViewState, ...string[]];
    if (branch === 'route' && rest.length === 0) {
        if (op === 'delete' || value === undefined) delete state.route;
        else state.route = copy(value);
        return;
    }
    if (rest.length === 0) {
        state[branch as 'data' | 'app' | 'screens'] = op === 'delete' || !isRecord(value) ? {} : copy(value);
        return;
    }
    if (branch === 'route' && !isRecord(state.route)) {
        if (op === 'delete') return;
        state.route = {};
    }
    if (branch === 'theme' && !isRecord(state.theme)) {
        if (op === 'delete') return;
        state.theme = {};
    }
    let container: Record<string, unknown> = state[branch] as Record<string, unknown>;
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

/**
 * The writes that show another view's choice of theme: `$.theme.active.theme` first, since switching the theme looks the
 * overlay names up again in the new theme, then each overlay kind that changed. A name removed is left as the view has it
 */
function themeWrites(before: Json | undefined, after: Json | undefined, writes: PathWrite[]): void {
    const was = isRecord(before) && isRecord(before['active']) ? before['active'] : {};
    const now = isRecord(after) && isRecord(after['active']) ? after['active'] : {};
    const kinds = Object.keys(now).sort((left, right) => (left === 'theme' ? -1 : right === 'theme' ? 1 : 0));
    for (const kind of kinds) {
        const name = now[kind];
        if (typeof name === 'string' && SEGMENT.test(kind) && name !== was[kind]) writes.push({ path: `$.theme.active.${kind}`, value: name });
    }
}

function viewState(state: SyncState): ViewState {
    const route = state['route'];
    return {
        data: isRecord(state['data']) ? copy(state['data']) : {},
        app: isRecord(state['app']) ? copy(state['app']) : {},
        screens: isRecord(state['screens']) ? copy(state['screens']) : {},
        ...(route !== undefined && { route: copy(route) }),
        ...(isRecord(state['theme']) && { theme: copy(state['theme']) })
    };
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
    /** The hash of the 3D renderer chunk the runtime origin serves (`data-chunk-3d`), sent in `load` as `chunks`; undefined when there is none */
    private readonly chunk3d: string | undefined;
    private readonly namespace: string;
    /** An owner app's view: the state is the default persona's instance */
    private readonly instance: boolean;
    /** `?screen=` and `?params=`: where the view navigates once the app is first ready */
    private openAt: { screen: string; params?: Json } | undefined;
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
    private shown: ViewState = { data: {}, app: {}, screens: {} };
    private readonly listeners = new Set<(changes: LocalChange[]) => void>();
    private syncStatus: { mode: 'full'; status: string; waiting: number };
    private readonly sentIcons = new Set<string>();
    private revision = 0;
    /** Counts the loads and in-place renders, so the server can drop the errors an earlier one reported */
    private load = 0;
    private mode: string | undefined;
    /**
     * The overlay this view applied for the server (a screenshot's mode, `?mode=`), by kind: the change it causes stays
     * in this view and is not synced as the persona's choice. Any other change of that kind clears it
     */
    private readonly viewThemes = new Map<string, string>();
    private locale: string | undefined;
    private readonly queuedCommands: Extract<ServerMessage, { type: 'command' }>[] = [];
    private readonly uploads = new Map<number, XMLHttpRequest>();
    /** Holds a file release back until the frame's changes have reached the server (`fileRelease.ts`) */
    private readonly releaseGate = createReleaseGate();

    constructor(private readonly body: HTMLElement) {
        this.appId = body.dataset['appId'] ?? '';
        this.viewKind = body.dataset['viewKind'] === 'headless' ? 'headless' : 'browser';
        this.runtimeUrl = body.dataset['runtimeUrl'] ?? '';
        this.runtimeOrigin = new URL(this.runtimeUrl, window.location.href).origin;
        const chunk3d = body.getAttribute('data-chunk-3d') ?? '';
        this.chunk3d = CHUNK_HASH.test(chunk3d) ? chunk3d : undefined;
        this.namespace = body.dataset['namespace'] || `apps.${this.appId.toLowerCase()}`;
        this.instance = this.namespace.startsWith('instances.');
        this.syncStatus = { mode: 'full', status: 'connecting', waiting: 0 };
        const query = new URLSearchParams(window.location.search);
        this.mode = query.get('mode') ?? undefined;
        this.locale = query.get('locale') ?? undefined;
        const screen = query.get('screen');
        if (screen !== null && screen !== '') {
            let params: Json | undefined;
            try {
                const parsed: unknown = JSON.parse(query.get('params') ?? 'null');
                params = isRecord(parsed) && isJson(parsed) ? parsed : undefined;
            } catch {
                params = undefined;
            }
            this.openAt = { screen, ...(params !== undefined && { params }) };
        }
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

    /**
     * The sync client's WebSocket: the page's socket to the server, where view frames go to the host and everything else
     * to the sync client
     */
    private transport(): SyncTransport {
        const url = this.viewSocketUrl();
        return {
            connect: (handlers) => {
                const socket = new WebSocket(url);
                let closed = false;
                socket.addEventListener('open', () => handlers.onOpen());
                socket.addEventListener('message', (event: MessageEvent<unknown>) => {
                    if (typeof event.data !== 'string') return;
                    if (event.data.startsWith(VIEW_FRAME)) this.onViewFrame(event.data);
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

    /** `keepalive` bodies are limited to 64 KiB, so the state, which can be larger, goes without it */
    private report(body: Record<string, unknown>, keepalive = true): void {
        void fetch(`/apps/${this.appId}/report`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ viewId: this.viewId, ...body }),
            keepalive
        }).catch(() => undefined);
    }

    /** Posts to the runtime; the buffers in `transfer` move to the frame (`fileData`) */
    private post(message: Record<string, unknown>, transfer: Transferable[] = []): void {
        this.frame?.contentWindow?.postMessage({ v: PROTOCOL_VERSION, nonce: this.nonce, ...message }, { targetOrigin: this.runtimeOrigin, transfer });
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
                if (this.ready) this.postViewTheme(message.kind, message.name);
                break;
            case 'deleted':
                this.client?.stop();
                for (const part of ['confirmed', 'outbox', 'document'] as const) this.store.remove(this.namespace, part);
                this.setStatus('failed', 'This app was deleted');
                this.frame?.remove();
                this.frame = undefined;
                break;
        }
    }

    private onSyncStatus(report: SyncStatusReport): void {
        this.syncStatus = { mode: 'full', status: report.status, waiting: report.waiting };
        this.releaseGate.update(report.status, report.waiting);
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
            this.load++;
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
            diffArticulation('$.app', this.shown.app, next.app, this.app.document['app'], writes) &&
            this.diffScreens(next, writes);
        if (!ok) {
            this.sendLoad();
            return;
        }
        const moved = this.instance && !deepEqual(this.shown.route, next.route) && isRecord(next.route) && typeof next.route['screen'] === 'string';
        if (this.instance) themeWrites(this.shown.theme, next.theme, writes);
        this.shown = copy(next);
        if (writes.length > 0) this.post({ type: 'write', writes });
        // The runtime protects $.route: a route another view moved is followed with navigate
        if (moved && isRecord(next.route)) {
            const params = next.route['params'];
            this.post({ type: 'command', target: next.route['screen'] as string, command: 'navigate', ...(params !== undefined && { value: params }) });
        }
    }

    /** The writes of each screen's articulation, against the screen's root in the document; false when one needs a load */
    private diffScreens(next: ViewState, writes: PathWrite[]): boolean {
        if (!this.instance) return true;
        const screens = isRecord(this.app?.document['screens']) ? this.app.document['screens'] : {};
        for (const name of new Set([...Object.keys(this.shown.screens), ...Object.keys(next.screens)])) {
            const screen = screens[name];
            if (!isRecord(screen) || !SEGMENT.test(name)) continue;
            const before = this.shown.screens[name] ?? {};
            const after = next.screens[name] ?? {};
            if (!diffArticulation(`$.screens.${name}`, before, after, screen['root'], writes)) return false;
        }
        return true;
    }

    private sendLoad(): void {
        const app = this.app;
        if (app === undefined || !this.frameLoaded) return;
        const icons = iconsMessage(app.icons, new Set());
        const documentData = app.document['data'];
        this.shown = this.synced !== undefined ? copy(this.synced) : { data: isRecord(documentData) ? copy(documentData) : {}, app: {}, screens: {} };
        this.ready = false;
        this.load++;
        this.setStatus('loading');
        this.post({
            type: 'load',
            document: app.document,
            mode: 'full',
            ...(this.synced !== undefined && (this.instance ? { instance: this.instanceOf(this.synced) } : { state: { data: this.synced.data, app: this.synced.app } })),
            ...(icons !== undefined && { icons }),
            ...(this.chunk3d !== undefined && { chunks: { '3d': this.chunk3d } })
        });
        this.post({ type: 'write', writes: [{ path: '$.runtime.sync', value: this.syncStatus }] });
        this.loaded = true;
        this.sentDocument = app.document;
        this.sentIcons.clear();
        Object.keys(app.icons).forEach((name) => this.sentIcons.add(name));
        this.revision = app.revision;
    }

    /** The synced state as the runtime's `instance`: the app node, the screens, the data and the route */
    private instanceOf(state: ViewState): JsonRecord {
        return {
            app: state.app,
            screens: state.screens,
            data: state.data,
            ...(isRecord(state.route) && { route: state.route }),
            ...(isRecord(state.theme) && { theme: state.theme })
        };
    }

    private markRendered(revision: number): void {
        this.revision = revision;
        this.body.dataset['revision'] = String(revision);
        this.report({ type: 'rendered', revision, load: this.load });
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
        // A navigate target is a screen name, not a path
        const target = command.command === 'navigate' || command.target.startsWith('$.') ? command.target : `$.${command.target}`;
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
                if (Array.isArray(message['errors'])) this.report({ type: 'errors', errors: message['errors'], revision: this.revision, load: this.load });
                break;
            case 'file':
                this.onFile(message);
                break;
            case 'fileCancel':
                if (typeof message['requestId'] === 'number') this.uploads.get(message['requestId'])?.abort();
                break;
            case 'fileRead':
                this.onFileRead(message);
                break;
            case 'fileRelease':
                this.onFileRelease(message);
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
        if (this.mode !== undefined) this.postViewTheme('mode', this.mode);
        if (this.locale !== undefined) this.post({ type: 'locale', locale: this.locale });
        for (const command of this.queuedCommands.splice(0)) {
            if (Date.parse(command.expiresAt) > Date.now()) this.sendCommand(command);
        }
        const at = this.openAt;
        this.openAt = undefined;
        if (at !== undefined) this.post({ type: 'command', target: at.screen, command: 'navigate', ...(at.params !== undefined && { value: at.params }) });
        this.report({ type: 'ready', revision: this.revision, load: this.load });
    }

    /** A change the user made in the frame: what is synced goes to the sync client, which sends it or keeps it for later */
    private onChange(change: unknown): void {
        if (!isRecord(change) || typeof change['path'] !== 'string') return;
        const op = change['op'];
        if (op !== 'set' && op !== 'replace' && op !== 'merge' && op !== 'delete') return;
        const value = change['value'];
        if (value !== undefined && !isJson(value)) return;
        if (this.isViewTheme(change['path'], value)) return;
        const synced = toSyncedChange(change['path'], op, value, this.instance);
        if (synced === undefined) return;
        applyTo(this.shown, synced.path, synced.op, synced.value);
        if (this.synced !== undefined) applyTo(this.synced, synced.path, synced.op, synced.value);
        const local: LocalChange = { id: crypto.randomUUID(), ...synced };
        for (const listener of [...this.listeners]) listener([local]);
    }

    /** Applies an overlay in this view only: the change it causes is not synced */
    private postViewTheme(kind: string, name: string): void {
        this.viewThemes.set(kind, name);
        this.post({ type: 'theme', kind, name });
    }

    /** True for the change a view-only overlay caused (and forgets it); any other change of that kind clears it */
    private isViewTheme(path: string, value: unknown): boolean {
        const match = /^\$\.theme\.active\.([^.]+)$/.exec(path);
        const kind = match?.[1];
        if (kind === undefined || !this.viewThemes.has(kind)) return false;
        const expected = this.viewThemes.get(kind);
        this.viewThemes.delete(kind);
        return value === expected;
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

    /** A component reads a stored file: fetched from the page's own origin and posted back as `fileData` with the bytes moved */
    private onFileRead(message: RuntimeMessage): void {
        const requestId = message['requestId'];
        if (typeof requestId !== 'number') return;
        void readStoredFile(this.appId, message['id'], (url, init) => fetch(url, init)).then((outcome) => {
            if (outcome.ok) this.post({ type: 'fileData', requestId, ok: true, file: outcome.file, data: outcome.data }, [outcome.data]);
            else this.post({ type: 'fileData', requestId, ok: false, code: outcome.code, message: outcome.message });
        });
    }

    /**
     * A component gives a stored file back: a DELETE on the page's own origin, answered with `fileReleased`. It waits
     * until the frame's changes before it (the write that let go of the file) are acknowledged, so the server's live
     * state no longer references the file
     */
    private onFileRelease(message: RuntimeMessage): void {
        const requestId = message['requestId'];
        if (typeof requestId !== 'number') return;
        void this.releaseGate.settled().then(() => releaseStoredFile(this.appId, message['id'], (url, init) => fetch(url, init))).then((outcome) => {
            this.post({ type: 'fileReleased', requestId, ...outcome });
        });
    }

    private fileFailed(requestId: number, code: string, message: string): void {
        this.post({ type: 'fileResult', requestId, ok: false, code, message });
    }
}

new LiveView(document.body).start();

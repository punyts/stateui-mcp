/**
 * The live view of an app in a page. It runs in the page, not in Node: in the statenet view page (`statenetView.ts`,
 * served by Vite or a CDN) and in the page of a server that serves its own (`hostPage.ts`, `/assets/host.js` of
 * `startHttpServer`). How it reaches its server is its channel (`viewChannel.ts`): the sync protocol, the server's
 * view messages (the document, commands, locale, theme, deletion), its reports and app events, and the files.
 *
 * It does what the minion UI's preview host does for the runtime: it puts the content-hashed runtime page into a
 * sandboxed iframe served from the runtime origin (a second port, `allow-scripts allow-same-origin`: the frame keeps
 * that origin, which is not the page's, so it cannot reach the page; a browser that refuses frames with an opaque
 * origin still shows it), speaks the versioned message protocol of `@punyts/stateui-app/protocol` with a per-load
 * nonce, and checks every message by source, origin and nonce.
 *
 * A page with `data-surface="page"` that loaded the page bundle (`window.stateuiPage`, `@punyts/stateui-app`'s
 * `runtime-bundle/page-entry.ts`) runs the app in the page itself: the same runtime (`createRuntime`, `inPage`) on an
 * element, `[data-app-frame]` or the one the page attaches it to (`attach`, through `stateuiHost.apps`), with the
 * same messages handed over by call instead of posted. The app then shares the page's origin, so the page's policy
 * allows what the runtime frame's allows (`APP_PAGE_CSP`).
 *
 * The app runs in Full mode: the page's sync client syncs the app's state, and the server's view messages bring the
 * document. The sync client keeps the confirmed state and the changes not yet acknowledged in `localStorage`, with
 * the document beside them, so the app opens and takes changes offline and sends them when the connection is back.
 *
 * An owner app (`data-namespace` on the body, `instances.<persona>.<ownerId>.<appId>`) syncs with the default
 * persona's instance: besides `$.data` and `$.app`, its state holds the articulation of each screen (`$.screens`) and
 * the route (`$.route`). A load lays that state over the assembled app as the runtime's `instance`; a route another
 * view moved arrives as a `navigate` command, since the runtime protects `$.route`. `?screen=<name>&params=<json>` in
 * the page URL navigates there once the app is ready.
 *
 * Files: a `file` from the runtime is uploaded through the channel (answered with `fileProgress` and `fileResult`),
 * a `fileRead` is read through it (`fileRead.ts`) and answered with `fileData`, its bytes in the transfer list, and a
 * `fileRelease` (`fileRelease.ts`) is answered with `fileReleased`: `ok: true` when the file is gone or was never
 * there, and also when the server keeps it because the app or its live state still references it (the sweep removes
 * it later). A release waits until the sync client has no change waiting for its ack (at most `RELEASE_SETTLE_MS`), so
 * the write that let go of the file reaches the server first. Ready, rendered and errors go to the server as reports.
 *
 * The page it runs in can take part: `data-host-keys` on the body names key chords (`mod+shift+e`, space-separated)
 * the runtime gives the page instead of the app, each raised on `window` as a `stateui:key` event (`detail.key`),
 * and every `emit` of the app is raised there too, as a `stateui:emit` event (`detail.name`, `detail.payload`), as
 * well as sent to the server. Every change of the synced state is raised as `stateui:change` (`detail.path`,
 * `detail.value`, undefined for a delete, and `detail.origin`, `user` for the person's own change in this view, else
 * `server`; a whole state the sync client loads comes as one change of `$.data`).
 *
 * A frame stays hidden (`visibility: hidden`) until its runtime says `ready`. Its `load` carries the mode, the language and
 * the screen to open, which the runtime applies in the same task as the mount, so the first frame painted is the app
 * as the person chose it: no blank page, and no light theme before a dark one.
 *
 * `window.stateuiHost` serves an editor laid over the page:
 * - `inspect({ at: { x, y } } | { paths })` asks the app frame about its nodes (the `inspect` message of the runtime)
 *   and resolves with its `inspected` answer, or undefined when the frame does not answer within `INSPECT_TIMEOUT_MS`.
 * - `navigate(screen, params?)` moves the app frame to a screen, as `?screen=` does (once it is ready, if it is not yet).
 * - `snapshot()` is a copy of what the app frame shows: the document and its icons and revision, and the synced
 *   `data` and `route` (undefined before the server sent a document). An editor draws its other screens with it, each
 *   a panel of its own (`mount`), and keeps their data in step from `stateui:change`.
 * - `mount(element, { document, icons?, keys?, inPage? })` puts a second runtime frame in `element` (with `inPage`, in
 *   the page surface, a runtime on an element of the page instead, whose `embeddedApp` nodes reach `apps`), driven by the page alone: it
 *   is loaded in `standalone` mode with the document given and the page's language and mode (`data-locale`,
 *   `data-mode` on the body), takes the page's writes and commands, and raises its emits on `element`
 *   (not on `window`) as `stateui:emit`; a chord named in `keys` comes to `window` as `stateui:key`. It never syncs.
 *   The panel it returns also has `inspect` (as above, of its own frame), `watch(paths, listener)` (where those nodes
 *   are, now and whenever they move, and the popovers open in the frame), `view({ locale?, mode? })` and `frame()`. Magnetic draws its whole editor, and
 *   its sign-in and link pages, with it.
 *
 * - `apps` is the page's app host (`AppHost` of `@punyts/stateui-app`), for an `embeddedApp` in an app the page mounts
 *   with `stateuiPage.mountApp` or `mount` with `inPage`: the live app itself is attached in the asking element, and a
 *   preview of it is its document on the page bundle's library, following the live app's store, given once the live app
 *   is mounted. Each mount of the live app in the page (a load, an `attach`) has a new store and raises `stateui:ready`
 *   on `window`, so a page opens its previews again. In the page surface only; it refuses every other app.
 *
 * A page with no `data-app-id` has no app of its own: it only mounts panels.
 *
 * `document.body.dataset` tells Playwright what the view shows: `status` is `loading`, `ready` or `failed`, `revision`
 * is the document revision the runtime rendered, and `sync` is the sync status (`connecting`, `online`, `offline`).
 */

import { createMemoryLocalStore, createSyncClient, createWebLocalStore, forgetNamespace, randomId } from '@punyts/state-sync';
import { MAX_WRITES, SEGMENT, copy, deepEqual, diffComplete, isJson, isRecord, planDocumentUpdate } from './documentUpdate.js';
import type { Json, JsonRecord, PathWrite } from './documentUpdate.js';
import { createReleaseGate } from './fileRelease.js';
import { ALLOWED_FILE_TYPES } from '../domain/UiFile.js';
import type { ServerMessage, ViewChannel } from './viewChannel.js';
import type { LocalChange, LocalStore, StoreBridge, SyncClient, SyncState, SyncStatusReport } from '@punyts/state-sync';
import type { AppAsk, AppDocument, AppHost, AppOpenRequest, AttachedApp, EmbeddedApp, OpenedApp, RuntimeCore, StateuiPage } from '@punyts/stateui-app';

/** A key chord the page may name in `data-host-keys`: modifiers (mod, shift, alt, in that order) and a letter or a digit */
const HOST_KEY = /^(mod\+)?(shift\+)?(alt\+)?([a-z0-9=-]|escape)$/;

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
/** How long `stateuiHost.inspect` waits for the frame to answer */
const INSPECT_TIMEOUT_MS = 2000;

type AppMessage = Extract<ServerMessage, { type: 'app' }>;
/** What a page that attaches the live app to one of its elements gives with it */
type AttachRequest = Pick<AppOpenRequest, 'screen' | 'onEmit' | 'onNavigate'>;
/** A navigation replaces `$.route` or writes below it */
const ROUTE_PATHS = ['$.route', '$.route.$all'];

/** The page bundle's global (`window.stateuiPage`), when the page loaded it */
function stateuiPage(): StateuiPage | undefined {
    const page = (window as unknown as { stateuiPage?: StateuiPage }).stateuiPage;
    return typeof page?.createRuntime === 'function' ? page : undefined;
}

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
    // `raised`: the events the nodes raised (`@punyts/stateui-app`'s dom/on/raised.ts), which server logic triggers on
    const branches = instance ? ['data', 'app', 'screens', 'route', 'theme', 'raised'] : ['data', 'app', 'raised'];
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

/** The branches of the synced state that the frame shows */
const VIEW_BRANCHES: readonly string[] = ['data', 'app', 'screens', 'route', 'theme'];

/** Applies one change to a view state in place, as the sync client does: missing parents are created, a delete below one does nothing */
function applyTo(state: ViewState, path: string, op: ChangeOp, value: Json | undefined): void {
    const [, branch, ...rest] = path.split('.') as [string, keyof ViewState, ...string[]];
    // The view holds what the frame shows; a synced branch it does not show (`$.raised`, the events) stays out of it
    if (!VIEW_BRANCHES.includes(branch)) return;
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

/** The live view of one app in the page: the runtime frame, its sync client and the channel to the server */
export class LiveView {
    readonly appId: string;
    readonly viewId = randomId();
    readonly viewKind: 'browser' | 'headless';
    private readonly runtimeUrl: string;
    private readonly runtimeOrigin: string;
    /** The hash of the 3D renderer chunk the runtime origin serves (`data-chunk-3d`), sent in `load` as `chunks`; undefined when there is none */
    private readonly chunk3d: string | undefined;
    private readonly namespace: string;
    /** The key chords the page handles itself (`data-host-keys`), sent in `load` as `keys` */
    private readonly hostKeys: string[];
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
    private channel!: ViewChannel;
    /** Holds a file release back until the frame's changes have reached the server (`fileRelease.ts`) */
    private readonly releaseGate = createReleaseGate();
    /** The `inspect` messages waiting for their answer, by id */
    private readonly inspections = new Map<number, (answer: JsonRecord | undefined) => void>();
    private inspection = 0;
    /**
     * Where the app runs: `frame`, a sandboxed frame from the runtime origin, or `page`, the page itself
     * (`data-surface="page"` on the body and the page bundle loaded), where the runtime is mounted on an element
     */
    readonly surface: 'frame' | 'page';
    /** The runtime in the page and the element it is mounted on; page surface only */
    private runtime: RuntimeCore | undefined;
    private holder: Element | undefined;
    /** The page's request the app is attached with (`attach`), and the end of its route watch */
    private attached: AttachRequest | undefined;
    private routeWatch: (() => void) | undefined;
    /** Who waits for the app to be mounted in the page (`mountedStore`) */
    private readonly mountWaiters: (() => void)[] = [];

    constructor(private readonly body: HTMLElement) {
        this.appId = body.dataset['appId'] ?? '';
        this.surface = body.dataset['surface'] === 'page' && stateuiPage() !== undefined ? 'page' : 'frame';
        this.viewKind = body.dataset['viewKind'] === 'headless' ? 'headless' : 'browser';
        this.runtimeUrl = body.dataset['runtimeUrl'] ?? '';
        this.runtimeOrigin = new URL(this.runtimeUrl, window.location.href).origin;
        const chunk3d = body.getAttribute('data-chunk-3d') ?? '';
        this.chunk3d = CHUNK_HASH.test(chunk3d) ? chunk3d : undefined;
        this.namespace = body.dataset['namespace'] || `apps.${this.appId.toLowerCase()}`;
        this.instance = this.namespace.startsWith('instances.');
        this.hostKeys = (body.dataset['hostKeys'] ?? '').split(/\s+/).filter((key) => HOST_KEY.test(key)).slice(0, 16);
        this.syncStatus = { mode: 'full', status: 'connecting', waiting: 0 };
        const query = new URLSearchParams(window.location.search);
        // The address wins over what the page says (`data-mode`, `data-locale`): a page sets the person's choice
        this.mode = query.get('mode') ?? body.dataset['mode'] ?? undefined;
        this.locale = query.get('locale') ?? body.dataset['locale'] ?? undefined;
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

    /** Starts the view with the channel to its server, made for this view's id and kind */
    start(channelFor: (view: LiveView) => ViewChannel): void {
        this.channel = channelFor(this);
        const revoked = this.body.dataset['revoked'];
        if (revoked !== undefined) {
            // Taken back while this browser was away: nothing of the app may stay here
            this.forget(revoked);
            return;
        }
        this.setStatus('loading');
        this.body.dataset['sync'] = 'connecting';
        if (this.surface === 'frame') window.addEventListener('message', (event) => this.onRuntimeMessage(event));
        // In the page, the host's key chords are taken before the app sees them, as the frame's runtime takes them
        else window.addEventListener('keydown', (event) => this.runtime?.key(event), true);
        const cached: unknown = this.store.read(this.namespace, 'document');
        if (isAppMessage(cached)) this.onApp({ type: 'app', reason: 'attach', revision: cached.revision, document: cached.document, icons: cached.icons });
        this.client = createSyncClient({
            namespace: this.namespace,
            bridge: this.bridge(),
            transport: this.channel.transport((message) => this.onServerMessage(message)),
            localStore: this.store,
            clientId: this.viewId,
            onStatus: (report) => this.onSyncStatus(report),
            onEmit: (name, value) => {
                if (this.channel.receive?.(name, value) === true) return;
                if (this.loaded && isLogicEvent(name)) this.post({ type: 'event', name, ...(value === undefined ? {} : { payload: value }) });
            },
            onRejected: (rejection) => {
                if (this.loaded) this.post({ type: 'event', name: 'sync.rejected', payload: { path: rejection.path, reason: rejection.reason } });
            },
            // The client has deleted its parts already; the frame still shows the app
            onRevoked: (message) => this.forget(message)
        });
        this.channel.started?.(this.client);
        this.client.start();
    }

    /** The sync client's view of the frame: state comes in as loads and writes, the frame's own changes go out */
    private bridge(): StoreBridge {
        return {
            load: (state) => {
                const next = viewState(state);
                this.showState(next);
                changed('$.data', next.data, 'server');
            },
            write: (path, value) => {
                const next = copy(this.synced ?? this.shown);
                applyTo(next, path, value === undefined ? 'delete' : 'set', value);
                this.showState(next);
                changed(path, value, 'server');
            },
            subscribe: (onChanges) => {
                this.listeners.add(onChanges);
                return () => this.listeners.delete(onChanges);
            }
        };
    }

    private setStatus(status: 'loading' | 'ready' | 'failed', note?: string): void {
        this.body.dataset['status'] = status;
        if (note !== undefined) this.body.dataset['note'] = note;
        else delete this.body.dataset['note'];
    }

    /** `keepalive` bodies are limited to 64 KiB, so the state, which can be larger, goes without it */
    private report(body: Record<string, unknown>): void {
        this.channel.report({ viewId: this.viewId, ...body });
    }

    /** Posts to the runtime; the buffers in `transfer` move to the frame (`fileData`); in the page it takes the message as it is */
    private post(message: Record<string, unknown>, transfer: Transferable[] = []): void {
        if (this.surface === 'page') {
            this.runtime?.handle({ v: PROTOCOL_VERSION, nonce: this.nonce, ...message });
            return;
        }
        this.frame?.contentWindow?.postMessage({ v: PROTOCOL_VERSION, nonce: this.nonce, ...message }, { targetOrigin: this.runtimeOrigin, transfer });
    }

    /** A message of the server: the document, a command, a locale or theme, the app's deletion, a refused change */
    private onServerMessage(message: ServerMessage): void {
        if (!isRecord(message as unknown)) return;
        switch (message.type) {
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
                this.forget('This app was deleted');
                break;
            case 'rejected':
                if (this.loaded) this.post({ type: 'event', name: 'sync.rejected', payload: { path: message.path, reason: message.reason } });
                break;
        }
    }

    /** Stops syncing, deletes what this browser keeps of the app, removes the frame and says why */
    private forget(note: string): void {
        this.client?.stop();
        forgetNamespace(this.store, this.namespace);
        this.setStatus('failed', note);
        this.frame?.remove();
        this.frame = undefined;
        this.unmount();
    }

    private onSyncStatus(report: SyncStatusReport): void {
        this.syncStatus = { mode: 'full', status: report.status, waiting: report.waiting };
        this.channel.status?.(report.status);
        this.releaseGate.update(report.status, report.waiting);
        this.body.dataset['sync'] = report.status;
        if (this.loaded) this.post({ type: 'write', writes: [{ path: '$.runtime.sync', value: this.syncStatus }] });
    }

    /** Makes the frame, or in the page the runtime on its element: the attached one, else `[data-app-frame]` */
    private ensureFrame(): void {
        if (this.surface === 'page') {
            const page = stateuiPage();
            const holder = this.holder ?? this.body.querySelector('[data-app-frame]') ?? undefined;
            if (this.runtime !== undefined || page === undefined || holder === undefined) return;
            this.holder = holder;
            // A message of the runtime is handled after the one it answers, as a frame's would be
            this.runtime = page.createRuntime({ host: holder, nonce: this.nonce, post: (message) => queueMicrotask(() => this.onRuntimeData(message)) });
            this.frameLoaded = true;
            return;
        }
        if (this.frame !== undefined) return;
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        frame.title = 'App';
        // Nothing shows until the app is mounted with its theme and language: no blank page, no light flash before dark
        frame.style.visibility = 'hidden';
        frame.addEventListener('load', () => {
            this.frameLoaded = true;
            if (this.app !== undefined) this.sendLoad();
        });
        frame.src = `${this.runtimeUrl}#${this.nonce}`;
        // A page that lays the frame out itself, such as a canvas, marks where it goes with `data-app-frame`
        (this.body.querySelector<HTMLElement>('[data-app-frame]') ?? this.body).append(frame);
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
        // The mode, the language and the screen to open go with the document, so the first frame painted shows them
        const at = this.openAt;
        this.openAt = undefined;
        this.post({
            type: 'load',
            document: app.document,
            mode: 'full',
            ...(this.synced !== undefined && (this.instance ? { instance: this.instanceOf(this.synced) } : { state: { data: this.synced.data, app: this.synced.app } })),
            ...(icons !== undefined && { icons }),
            ...(this.chunk3d !== undefined && { chunks: { '3d': this.chunk3d } }),
            ...(this.hostKeys.length > 0 && { keys: this.hostKeys }),
            ...(this.mode !== undefined && { active: { mode: this.mode } }),
            ...(this.locale !== undefined && { locale: this.locale }),
            ...(at !== undefined && { open: at })
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
        this.onRuntimeData(event.data);
    }

    /** A message of the runtime, from its frame or from the runtime in the page */
    private onRuntimeData(data: unknown): void {
        const message = data as RuntimeMessage;
        if (!isRecord(message) || message['v'] !== PROTOCOL_VERSION || message['nonce'] !== this.nonce) return;
        switch (message['type']) {
            case 'ready':
                this.onReady();
                break;
            case 'change':
                this.onChange(message['change']);
                break;
            case 'emit':
                if (typeof message['name'] === 'string') {
                    this.channel.event(message['name'], message['payload'] as Json | undefined);
                    window.dispatchEvent(new CustomEvent('stateui:emit', { detail: { name: message['name'], payload: message['payload'] } }));
                    this.attached?.onEmit(message['name'], message['payload']);
                }
                break;
            case 'key':
                if (typeof message['key'] === 'string' && this.hostKeys.includes(message['key'])) window.dispatchEvent(new CustomEvent('stateui:key', { detail: { key: message['key'] } }));
                break;
            case 'inspected':
                if (typeof message['id'] === 'number') this.inspections.get(message['id'])?.({ ...message } as JsonRecord);
                break;
            case 'error':
                if (Array.isArray(message['errors'])) this.report({ type: 'errors', errors: message['errors'], revision: this.revision, load: this.load });
                break;
            case 'file':
                this.onFile(message);
                break;
            case 'fileCancel':
                if (typeof message['requestId'] === 'number') this.channel.cancelUpload(message['requestId']);
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

    /** Moves the frame to a screen: at once when the app is ready, else once it is (as `?screen=` does) */
    navigate(screen: string, params?: Json): void {
        if (this.ready) this.post({ type: 'command', target: screen, command: 'navigate', ...(params !== undefined && { value: params }) });
        else this.openAt = { screen, ...(params !== undefined && { params }) };
    }

    /** A copy of what the frame shows: the document, and the synced data and route; undefined before there is a document */
    snapshot(): { document: JsonRecord; icons?: Record<string, string>; revision: number; data: JsonRecord; route?: Json } | undefined {
        const app = this.app;
        if (app === undefined) return undefined;
        const state = this.synced ?? this.shown;
        return {
            document: copy(app.document),
            ...(app.icons !== undefined && { icons: copy(app.icons) }),
            revision: app.revision,
            data: copy(state.data),
            ...(state.route !== undefined && { route: copy(state.route) })
        };
    }

    private onReady(): void {
        this.ready = true;
        this.body.dataset['revision'] = String(this.revision);
        this.setStatus('ready');
        if (this.frame !== undefined) this.frame.style.visibility = '';
        this.watchRoute();
        if (this.surface === 'page') {
            for (const waiter of this.mountWaiters.splice(0)) waiter();
            // Each mount has a store of its own: a page whose previews follow the live app opens them again
            window.dispatchEvent(new CustomEvent('stateui:ready'));
        }
        for (const command of this.queuedCommands.splice(0)) {
            if (Date.parse(command.expiresAt) > Date.now()) this.sendCommand(command);
        }
        this.report({ type: 'ready', revision: this.revision, load: this.load });
    }

    /**
     * Mounts the live app on `element`, a node of the page (an `embeddedApp`'s element), on `request.screen`; page
     * surface only. A mount elsewhere is disposed first, and the app loads again from the synced state. The app's emits
     * and the screens it moves to itself go to the request as well. Disposing it unmounts the app; the view keeps
     * syncing, and the next `attach` shows it again
     */
    attach(element: Element, request: AttachRequest): EmbeddedApp {
        if (this.surface !== 'page') throw new Error(`The app ${this.appId} runs in a frame and cannot be attached`);
        this.unmount();
        this.holder = element;
        this.attached = request;
        if (request.screen !== undefined) this.openAt = { screen: request.screen };
        this.ensureFrame();
        if (this.app !== undefined) this.sendLoad();
        return {
            navigate: (screen) => {
                this.navigate(screen);
                return undefined;
            },
            dispose: () => {
                if (this.attached !== request) return;
                this.unmount();
                this.holder = undefined;
                this.attached = undefined;
            }
        };
    }

    /** The store of the app mounted in the page, which previews of it follow; undefined in a frame or before a load */
    liveStore(): OpenedApp['follows'] {
        return this.runtime?.app()?.store;
    }

    /** The store of the app mounted in the page, once it is: now when it is ready, else at its next ready */
    mountedStore(): Promise<OpenedApp['follows']> {
        if (this.ready && this.runtime?.app()?.store !== undefined) return Promise.resolve(this.liveStore());
        return new Promise((resolve) => this.mountWaiters.push(() => resolve(this.liveStore())));
    }

    /** Disposes the runtime in the page; the next `ensureFrame` makes a new one, which a load then fills */
    private unmount(): void {
        this.routeWatch?.();
        this.routeWatch = undefined;
        if (this.runtime === undefined) return;
        this.runtime.dispose();
        this.runtime = undefined;
        this.frameLoaded = false;
        this.loaded = false;
        this.ready = false;
    }

    /** Tells the attached request the screen the app shows whenever the app moves itself */
    private watchRoute(): void {
        this.routeWatch?.();
        this.routeWatch = undefined;
        const app = this.runtime?.app();
        const store = app?.store;
        const request = this.attached;
        if (app === undefined || store === undefined || request === undefined) return;
        let shown = app.visibleScreen();
        const moved = (): void => {
            const screen = app.visibleScreen();
            if (screen === undefined || screen === shown) return;
            shown = screen;
            request.onNavigate(screen);
        };
        store.on(ROUTE_PATHS, moved);
        this.routeWatch = () => store.off(ROUTE_PATHS, moved);
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
        const local: LocalChange = { id: randomId(), ...synced };
        for (const listener of [...this.listeners]) listener([local]);
        changed(synced.path, synced.value, 'user');
    }

    /** Asks the frame about its nodes; undefined when it is not loaded or does not answer in time */
    inspect(query: { at: { x: number; y: number } } | { paths: string[] }): Promise<JsonRecord | undefined> {
        if (!this.ready) return Promise.resolve(undefined);
        const id = ++this.inspection;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.inspections.delete(id);
                resolve(undefined);
            }, INSPECT_TIMEOUT_MS);
            this.inspections.set(id, (answer) => {
                clearTimeout(timer);
                this.inspections.delete(id);
                resolve(answer);
            });
            this.post({ type: 'inspect', id, ...query });
        });
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
        void this.channel
            .upload(requestId, { name, type: bare, data }, (loaded, total) => this.post({ type: 'fileProgress', requestId, loaded, total }))
            .then((outcome) => {
                if (outcome === undefined) return;
                if (outcome.ok) this.post({ type: 'fileResult', requestId, ok: true, file: outcome.file });
                else this.fileFailed(requestId, outcome.code, outcome.message);
            });
    }

    /** A component reads a stored file: fetched from the page's own origin and posted back as `fileData` with the bytes moved */
    private onFileRead(message: RuntimeMessage): void {
        const requestId = message['requestId'];
        if (typeof requestId !== 'number') return;
        void this.channel.readFile(message['id']).then((outcome) => {
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
        void this.releaseGate.settled().then(() => this.channel.releaseFile(message['id'])).then((outcome) => {
            this.post({ type: 'fileReleased', requestId, ...outcome });
        });
    }

    private fileFailed(requestId: number, code: string, message: string): void {
        this.post({ type: 'fileResult', requestId, ok: false, code, message });
    }
}

/** Raises a change of the synced state on the page, for an editor that shows the state as it changes */
function changed(path: string, value: Json | undefined, origin: 'user' | 'server'): void {
    window.dispatchEvent(new CustomEvent('stateui:change', { detail: { path, value, origin } }));
}

/**
 * A runtime frame the page drives alone: loaded in `standalone` mode with a document the page gives, it takes the
 * page's writes and commands and raises its emits on its element. Nothing of it is synced or stored
 */
/** What `stateuiHost.mount` puts in an element: a document, its icons, the chords the page takes, and where it runs */
interface PanelApp {
    readonly document: JsonRecord;
    readonly icons?: Record<string, string>;
    readonly keys?: string[];
    /**
     * True: the panel runs in the page, on an element, rather than in a frame from the runtime origin (the page
     * surface only; elsewhere it is a frame). Its `embeddedApp` nodes reach the page's app host (`apps`)
     */
    readonly inPage?: boolean;
}

class PageView {
    private readonly nonce = createNonce();
    /** The frame from the runtime origin; undefined in the page */
    private readonly frame: HTMLIFrameElement | undefined;
    /** The frame, or in the page the element the runtime is mounted on */
    private readonly holder: HTMLElement;
    /** The runtime in the page (`inPage`); undefined for a frame */
    private readonly runtime: RuntimeCore | undefined;
    private readonly keys: ((event: KeyboardEvent) => void) | undefined;
    private ready = false;
    private readonly queued: Record<string, unknown>[] = [];
    private readonly listener = (event: MessageEvent<unknown>): void => this.onMessage(event);
    private readonly inspections = new Map<number, (answer: JsonRecord | undefined) => void>();
    private inspection = 0;
    private watcher: ((nodes: { path: string; rect: JsonRecord }[], floating: JsonRecord[]) => void) | undefined;

    constructor(
        private readonly element: HTMLElement,
        private readonly runtimeUrl: string,
        private readonly runtimeOrigin: string,
        app: PanelApp,
        title: string,
        apps: AppHost
    ) {
        const page = app.inPage === true ? stateuiPage() : undefined;
        if (page !== undefined) {
            // In the page: the runtime on an element of its own, its messages handed over by call as a frame's are posted
            const holder = document.createElement('div');
            holder.className = 'stateui-panel';
            holder.setAttribute('role', 'region');
            holder.setAttribute('aria-label', title);
            element.append(holder);
            this.holder = holder;
            this.frame = undefined;
            const runtime = page.createRuntime({ host: holder, nonce: this.nonce, post: (message) => queueMicrotask(() => this.receive(message)), apps });
            this.runtime = runtime;
            this.keys = (event) => runtime.key(event);
            if ((app.keys ?? []).length > 0) window.addEventListener('keydown', this.keys, true);
            this.send(PageView.loadOf(app));
            return;
        }
        this.runtime = undefined;
        this.keys = undefined;
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        frame.title = title;
        frame.style.visibility = 'hidden';
        frame.addEventListener('load', () => this.send(PageView.loadOf(app)));
        frame.src = `${this.runtimeUrl}#${this.nonce}`;
        window.addEventListener('message', this.listener);
        element.append(frame);
        this.frame = frame;
        this.holder = frame;
    }

    /** A panel's `load`: its document in `standalone` mode, with the page's language and mode (`data-locale`, `data-mode`) */
    private static loadOf(app: PanelApp): Record<string, unknown> {
        const icons = iconsMessage(app.icons ?? {}, new Set());
        const keys = (app.keys ?? []).filter((key) => HOST_KEY.test(key)).slice(0, 16);
        const { locale, mode } = document.body.dataset;
        return {
            type: 'load',
            document: app.document,
            mode: 'standalone',
            ...(icons !== undefined && { icons }),
            ...(keys.length > 0 && { keys }),
            ...(mode && { active: { mode } }),
            ...(locale && { locale })
        };
    }

    /** Writes paths of the frame's store (`$.data`, whole nodes below `$.screens`), once it is ready */
    write(writes: PathWrite[]): void {
        for (let start = 0; start < writes.length; start += MAX_WRITES) this.later({ type: 'write', writes: writes.slice(start, start + MAX_WRITES) });
    }

    /** Runs a command of a node, or `navigate` to a screen */
    command(target: string, command: string, value?: Json): void {
        this.later({ type: 'command', target, command, ...(value !== undefined && { value }) });
    }

    /** Asks the frame about its nodes, as the app view's `inspect`; undefined when it does not answer in time */
    inspect(query: { at: { x: number; y: number } } | { paths: string[] }): Promise<JsonRecord | undefined> {
        const id = ++this.inspection;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.inspections.delete(id);
                resolve(undefined);
            }, INSPECT_TIMEOUT_MS);
            this.inspections.set(id, (answer) => {
                clearTimeout(timer);
                this.inspections.delete(id);
                resolve(answer);
            });
            this.later({ type: 'inspect', id, ...query });
        });
    }

    /**
     * Follows where some nodes of the frame are: the listener gets their boxes now and each time they move or change
     * size, with the boxes of the popovers open in the frame (tips, menus, option lists; empty when none is). A new watch
     * replaces the last; an empty list stops
     */
    watch(paths: string[], listener: (nodes: { path: string; rect: JsonRecord }[], floating: JsonRecord[]) => void): void {
        this.watcher = listener;
        this.later({ type: 'watch', paths });
    }

    /** Switches the frame's language, or its mode (`system` follows the device) */
    view(change: { locale?: string; mode?: string }): void {
        if (change.mode !== undefined) this.later({ type: 'theme', kind: 'mode', name: change.mode });
        if (change.locale !== undefined) this.later({ type: 'locale', locale: change.locale });
    }

    /** The frame itself, or in the page the element the panel is mounted on, for a page that sizes or focuses it */
    frameElement(): HTMLElement {
        return this.holder;
    }

    dispose(): void {
        window.removeEventListener('message', this.listener);
        if (this.keys !== undefined) window.removeEventListener('keydown', this.keys, true);
        this.runtime?.dispose();
        this.holder.remove();
    }

    private later(message: Record<string, unknown>): void {
        if (this.ready) this.send(message);
        else this.queued.push(message);
    }

    private send(message: Record<string, unknown>): void {
        if (this.runtime !== undefined) this.runtime.handle({ v: PROTOCOL_VERSION, nonce: this.nonce, ...message });
        else this.frame?.contentWindow?.postMessage({ v: PROTOCOL_VERSION, nonce: this.nonce, ...message }, this.runtimeOrigin);
    }

    private onMessage(event: MessageEvent<unknown>): void {
        if (this.frame === undefined || event.source !== this.frame.contentWindow || event.origin !== this.runtimeOrigin) return;
        this.receive(event.data);
    }

    /** A message of the runtime: posted by the frame, or handed over by the runtime in the page */
    private receive(data: unknown): void {
        const message = data as RuntimeMessage;
        if (!isRecord(message) || message['v'] !== PROTOCOL_VERSION || message['nonce'] !== this.nonce) return;
        if (message['type'] === 'ready') {
            this.ready = true;
            this.holder.style.visibility = '';
            for (const queued of this.queued.splice(0)) this.send(queued);
            this.element.dispatchEvent(new CustomEvent('stateui:ready'));
        } else if (message['type'] === 'emit' && typeof message['name'] === 'string') {
            this.element.dispatchEvent(new CustomEvent('stateui:emit', { detail: { name: message['name'], payload: message['payload'] } }));
        } else if (message['type'] === 'error') {
            this.element.dispatchEvent(new CustomEvent('stateui:error', { detail: { errors: message['errors'] } }));
        } else if (message['type'] === 'inspected' && typeof message['id'] === 'number') {
            this.inspections.get(message['id'])?.({ ...message } as JsonRecord);
        } else if (message['type'] === 'watched' && Array.isArray(message['nodes'])) {
            this.watcher?.(message['nodes'] as { path: string; rect: JsonRecord }[], Array.isArray(message['floating']) ? (message['floating'] as JsonRecord[]) : []);
        } else if (message['type'] === 'key' && typeof message['key'] === 'string') {
            window.dispatchEvent(new CustomEvent('stateui:key', { detail: { key: message['key'] } }));
        }
    }
}

/**
 * The page's app host (`MountOptions.apps`) for the live app in the page: the live app itself is attached where it is
 * asked for (`LiveView.attach`), and a preview of it is its document as the page last had it, on the page bundle's
 * library, following the live app's store. It knows no other app
 */
function appHost(live: LiveView | undefined): AppHost {
    return {
        open: (ask: AppAsk): Promise<OpenedApp | AttachedApp> => {
            const page = stateuiPage();
            if (live === undefined || page === undefined || live.surface !== 'page' || ask.app !== live.appId) return Promise.reject(new Error(`No app ${ask.app} in this page`));
            if (ask.live) return Promise.resolve({ attach: (request) => live.attach(request.element, request) });
            // A preview waits for the live app it follows to be mounted
            return live.mountedStore().then((follows) => {
                const snapshot = live.snapshot();
                if (snapshot === undefined) throw new Error(`The app ${ask.app} has no document yet`);
                return {
                    document: { ...snapshot.document, data: snapshot.data } as unknown as AppDocument,
                    library: page.library,
                    options: { functions: page.functions },
                    ...(follows !== undefined && { follows })
                };
            });
        }
    };
}

/** `window.stateuiHost`: what an editor laid over the page uses */
export function installHostApi(live: LiveView | undefined): void {
    const apps = appHost(live);
    (window as unknown as { stateuiHost: unknown }).stateuiHost = {
        inspect: (query: { at: { x: number; y: number } } | { paths: string[] }) => (live === undefined ? Promise.resolve(undefined) : live.inspect(query)),
        navigate: (screen: string, params?: Json) => live?.navigate(screen, params),
        snapshot: () => live?.snapshot(),
        apps,
        mount: (element: HTMLElement, app: PanelApp, title = 'Panel') => {
            const runtimeUrl = document.body.dataset['runtimeUrl'] ?? '';
            const view = new PageView(element, runtimeUrl, new URL(runtimeUrl, window.location.href).origin, app, title, apps);
            return {
                write: (writes: PathWrite[]) => view.write(writes),
                command: (target: string, command: string, value?: Json) => view.command(target, command, value),
                inspect: (query: { at: { x: number; y: number } } | { paths: string[] }) => view.inspect(query),
                watch: (paths: string[], listener: (nodes: { path: string; rect: JsonRecord }[], floating: JsonRecord[]) => void) => view.watch(paths, listener),
                view: (change: { locale?: string; mode?: string }) => view.view(change),
                frame: () => view.frameElement(),
                dispose: () => view.dispose()
            };
        }
    };
}

/**
 * The page of the live views when the state lives in a statenet: what the Vite dev server serves locally
 * (`view/index.html`) and a CDN serves in production. It needs no server of its own: the apps and their state come
 * from the statenet, where stateui-mcp keeps them.
 *
 * - Without `?app=` it lists the apps: the directory namespace `stateui.apps`, whose `$.apps` the server keeps.
 * - With `?app=<id>` it shows the live view of that app (`host.ts` with `statenetChannel.ts`). It finds the app's
 *   namespace in the directory and asks the server there to open it (`stateui.open`), again whenever the server says
 *   it is (back) online.
 *
 * Where things are, first found wins:
 * - the statenet: `?statenet=ws://…/sync`, `VITE_STATENET_URL` at build time, else `ws://<page host>:4200/sync`
 * - the runtime frame: `data-runtime-url` on the body, which the Vite plugin writes (`{host}` is the page's host
 *   name), else `./runtime/runtime.html`
 * - the 3D chunk: `data-chunk-3d` on the body, from the Vite plugin
 *
 * `?kind=headless` (or a HeadlessChrome user agent) marks the view of the server's own headless browser.
 */

import { createSyncClient } from '@punyts/state-sync';
import type { JsonValue, LocalChange, StoreBridge, SyncState } from '@punyts/state-sync';
import { DIRECTORY_NAMESPACE, isRelayEnvelope, OPEN_EMIT, SERVER_EMIT } from '../domain/viewRelay.js';
import type { DirectoryEntry } from '../domain/viewRelay.js';
import { installHostApi, LiveView } from './host.js';
import { statenetChannel } from './statenetChannel.js';

const DEFAULT_STATENET_PORT = 4200;

const query = new URLSearchParams(window.location.search);

function buildTimeEnv(name: string): string | undefined {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const value = env?.[name];
    return value === undefined || value === '' ? undefined : value;
}

/** The statenet's WebSocket URL; only ws: and wss: URLs are taken from the query */
function statenetUrl(): string {
    const fromQuery = query.get('statenet');
    if (fromQuery !== null && /^wss?:\/\//.test(fromQuery)) return fromQuery;
    return buildTimeEnv('VITE_STATENET_URL') ?? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.hostname}:${DEFAULT_STATENET_PORT}/sync`;
}

function runtimeUrl(): string {
    const configured = document.body.dataset['runtimeUrl'] ?? buildTimeEnv('VITE_STATEUI_RUNTIME_URL') ?? './runtime/runtime.html';
    return new URL(configured.replace('{host}', window.location.hostname), window.location.href).href;
}

function isEntry(value: unknown): value is DirectoryEntry {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const entry = value as Record<string, unknown>;
    return typeof entry['name'] === 'string' && typeof entry['namespace'] === 'string';
}

/** A sync client of the directory: its `$.apps` as a plain object, and its server's emits */
function openDirectory(url: string, onApps: (apps: Record<string, DirectoryEntry>) => void, onOnline: () => void): ReturnType<typeof createSyncClient> {
    let state: SyncState = {};
    const changed = (): void => {
        const apps = state['apps'];
        const entries: Record<string, DirectoryEntry> = {};
        if (typeof apps === 'object' && apps !== null && !Array.isArray(apps)) {
            for (const [id, entry] of Object.entries(apps)) if (isEntry(entry)) entries[id] = entry;
        }
        onApps(entries);
    };
    const bridge: StoreBridge = {
        load: (next) => {
            state = next;
            changed();
        },
        write: (path, value) => {
            // The directory is written by the server only: `$.apps` or `$.apps.<id>`
            const keys = path.split('.').slice(1);
            if (keys[0] !== 'apps') return;
            if (keys.length === 1) state = { ...state, apps: value ?? {} };
            else if (keys.length === 2) {
                const apps = { ...((state['apps'] as Record<string, JsonValue> | undefined) ?? {}) };
                if (value === undefined) delete apps[keys[1] as string];
                else apps[keys[1] as string] = value;
                state = { ...state, apps };
            } else return;
            changed();
        },
        subscribe: (_onChanges: (changes: LocalChange[]) => void) => () => undefined
    };
    const client = createSyncClient({
        namespace: DIRECTORY_NAMESPACE,
        bridge,
        transport: {
            connect: (handlers) => {
                const socket = new WebSocket(url);
                let closed = false;
                socket.binaryType = 'arraybuffer';
                socket.addEventListener('open', () => handlers.onOpen());
                socket.addEventListener('message', (event: MessageEvent<unknown>) => {
                    if (typeof event.data === 'string') handlers.onMessage(event.data);
                    else if (event.data instanceof ArrayBuffer) handlers.onMessage(new Uint8Array(event.data));
                });
                socket.addEventListener('close', () => {
                    if (closed) return;
                    closed = true;
                    handlers.onClose();
                });
                return {
                    send: (data) => {
                        if (socket.readyState === WebSocket.OPEN) socket.send(data);
                    },
                    close: () => socket.close()
                };
            }
        },
        onStatus: (report) => {
            document.body.dataset['directory'] = report.status;
            if (report.status === 'online') onOnline();
        },
        onEmit: (name, value) => {
            // The server came (back): it opens the apps the pages ask for again
            if (name === SERVER_EMIT && isRelayEnvelope(value) && value.parts === 1 && value.text === '{"type":"ready"}') onOnline();
        }
    });
    client.start();
    return client;
}

function listPage(url: string): void {
    document.title = 'StateUI apps';
    document.body.className = 'list';
    const heading = document.createElement('h1');
    heading.textContent = 'StateUI apps';
    const content = document.createElement('div');
    document.body.append(heading, content);
    const status = document.createElement('p');
    status.className = 'muted';
    status.textContent = `Waiting for the statenet at ${url}…`;
    content.append(status);
    openDirectory(
        url,
        (apps) => {
            const entries = Object.entries(apps).sort(([, a], [, b]) => b.updatedAt.localeCompare(a.updatedAt));
            content.replaceChildren();
            if (entries.length === 0) {
                const empty = document.createElement('p');
                empty.className = 'muted';
                empty.textContent = 'No apps yet. An agent creates them through the MCP tools.';
                content.append(empty);
                return;
            }
            const table = document.createElement('table');
            const head = table.createTHead().insertRow();
            for (const title of ['Name', 'Revision', 'Updated']) head.append(Object.assign(document.createElement('th'), { textContent: title }));
            const body = table.createTBody();
            for (const [id, entry] of entries) {
                const row = body.insertRow();
                const link = document.createElement('a');
                const target = new URL(window.location.href);
                target.searchParams.set('app', id);
                link.href = target.search;
                link.textContent = entry.name;
                row.insertCell().append(link);
                row.insertCell().textContent = String(entry.revision);
                row.insertCell().textContent = entry.updatedAt;
            }
            content.append(table);
        },
        () => undefined
    );
}

function appPage(url: string, appId: string): void {
    const body = document.body;
    body.className = 'view';
    body.dataset['status'] = 'loading';
    const headless = query.get('kind') === 'headless' || /HeadlessChrome/.test(navigator.userAgent);
    let started = false;
    const directory = openDirectory(
        url,
        (apps) => {
            const entry = apps[appId] ?? apps[appId.toLowerCase()];
            if (entry === undefined) {
                if (!started) {
                    body.dataset['status'] = 'failed';
                    body.dataset['note'] = 'No app with this id';
                }
                return;
            }
            document.title = entry.name;
            if (started) return;
            started = true;
            delete body.dataset['note'];
            body.dataset['appId'] = appId;
            body.dataset['namespace'] = entry.namespace;
            body.dataset['viewKind'] = headless ? 'headless' : 'browser';
            body.dataset['runtimeUrl'] = runtimeUrl();
            const live = new LiveView(body);
            installHostApi(live);
            live.start((view) => statenetChannel({ statenetUrl: url, appId, viewId: view.viewId, viewKind: view.viewKind }));
        },
        () => {
            directory.emit(OPEN_EMIT, { appId });
        }
    );
}

const app = query.get('app');
const url = statenetUrl();
document.body.dataset['statenet'] = url;
if (app === null || app === '') listPage(url);
else appPage(url, app);

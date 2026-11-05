# stateui-mcp

A standalone MCP server for building StateUI apps. An agent creates and edits an app with tools, a person watches the same app live in a browser, and a headless Chromium (Playwright) renders it so the agent can take screenshots, click and type in it, and read the events it raises.

It is the single-user, local version of the `ui-builder` bounded context of AI Minion: same tools, arguments, results and error codes, with no workspaces, users, approval policy or Postgres. Apps are JSON files on disk.

## Install

Node 22 or newer. The `@punyts/*` packages are not on npm; this repository resolves them from a checkout of the monorepo (like `libraries/example`), so it runs from a clone of it.

```sh
cd libraries/stateui-mcp
npm run build
npx playwright install chromium   # once, for ui_preview, ui_screenshot and ui_interact
```

Without Chromium everything else works. `ui_preview` still returns the address a person can open (with `rendered: false` and a note), and `ui_screenshot` and `ui_interact` answer `browser-unavailable`.

The runtime bundle comes from `@punyts/stateui-app` (`dist/runtime-bundle/`, built by `npm run build:runtime-bundle` in that package). Use `--runtime-dir` to point at another build.

## Run

```sh
# Streamable HTTP: MCP at http://127.0.0.1:4100/mcp, apps at http://127.0.0.1:4100/
node dist/cli.js --port 4100 --data-dir ./data

# stdio: MCP on stdin and stdout, and the HTTP server still listens for the browser view
node dist/cli.js --stdio --port 4100 --data-dir ./data
```

| Option | Environment | Default |
|---|---|---|
| `--data-dir <dir>` | `STATEUI_MCP_DATA_DIR` | `./data` |
| `--port <n>` | `STATEUI_MCP_PORT` | `4100` (`0` picks a free port) |
| `--runtime-port <n>` | `STATEUI_MCP_RUNTIME_PORT` | the next port, `4101` (a free one when `--port` is `0`) |
| `--host <address>` | `STATEUI_MCP_HOST` | `127.0.0.1` |
| `--stdio` | | off |
| `--runtime-dir <dir>` | `STATEUI_MCP_RUNTIME_DIR` | the bundle in `@punyts/stateui-app` |
| `--statenet <url>` | `STATEUI_MCP_STATENET` | none: the state stays in the data folder |
| `--secret-key-file <file>` | `STATEUI_MCP_SECRET_KEY_FILE`, or the key itself in `STATEUI_MCP_SECRET_KEY` | none: an app that keeps `$.server` is refused |
| `--tool-log <file>` | `STATEUI_MCP_TOOL_LOG` | none: no tool calls are logged |

**Tool-call log.** With `--tool-log <file>` the server appends one JSON line per tool call: `{ at, tool, ok, errorCode?, requestChars, responseChars, target?, errorCount?, warningCount? }`. `requestChars` is the length of the JSON arguments, `responseChars` the length of the result's text (images are not counted), `errorCode` the `error` of a failed result, `errorCount` and `warningCount` the lengths of its `errors` and `warnings`, and `target` the call's `appId` (or `app`, with `/` and `screen`), cut to 80 characters. Nothing else is written: no arguments, no response bodies. A failed write is reported once on stderr and never fails the call. It is for measuring how agents use the tools.

`npm start` runs `node dist/cli.js`; `stateui-mcp --help` lists the options. In stdio mode every log line goes to stderr, because stdout is the protocol. `Ctrl+C`, `SIGTERM`, or the client closing stdin stops the server, closes the MCP sessions and closes the headless browser.

## Register it in an MCP client

Claude Code, HTTP (start the server first):

```sh
claude mcp add --transport http stateui http://127.0.0.1:4100/mcp
```

Claude Code, stdio (the client starts the server):

```sh
claude mcp add stateui -- node /path/to/libraries/stateui-mcp/dist/cli.js --stdio --port 4100 --data-dir /path/to/data
```

A `.mcp.json`:

```json
{
    "mcpServers": {
        "stateui-http": { "type": "http", "url": "http://127.0.0.1:4100/mcp" },
        "stateui-stdio": {
            "command": "node",
            "args": ["/path/to/libraries/stateui-mcp/dist/cli.js", "--stdio", "--port", "4100", "--data-dir", "/path/to/data"]
        }
    }
}
```

The server sends instructions with the working loop (components, create, write with `expectedRevision`, validate, preview, screenshot), the rules that cost a failed call (icon names from `ui_icons_list`, no integer-like record keys, no set through a missing parent), and how to read events. The tool descriptions carry the same guidance.

## Tools

The first sixteen are the `ui-builder` tools. The last three are new.

| Tool | Arguments | Result |
|---|---|---|
| `ui_components_list` | `query?`, `tier?` | `{ count, components: [{ name, tier, size, summary }] }` |
| `ui_component_get` | `name` | the catalog entry; an unknown name is `unknown-component` with `nearest` |
| `ui_icons_list` | `query?`, `category?`, `filled?`, `limit?` | `{ icons, total, more }` |
| `ui_tokens_list` | `group?`, `query?`, `includeOverlays?` | `{ count, tokens, overlays? }`; `unknown-group` lists the groups |
| `ui_app_create` | `name`, `document?` | `{ appId, revision }`; `invalid-document`, `invalid-name`, `duplicate-name` |
| `ui_app_list` | none | `{ count, apps: [{ appId, name, revision, updatedAt }] }` |
| `ui_app_get` | `appId`, `path?`, `depth?`, `resolved?` | `{ appId, revision, path, value, resolved, note? }`; `missing-path`, `invalid-path` |
| `ui_validate` | `appId` | `{ appId, revision, valid, errors, warnings, preview }` |
| `ui_outline` | `appId`, `path?`, `depth?`, `locale?` | `{ appId, revision, text, lineCount, cutLines, localeApplied }`; the outline of the root ends with the logic |
| `ui_tree` | `appId`, `path?`, `depth?`, `paths?`, `rendered?` | `{ appId, revision, text, lineCount, cutLines, nodeCount }`; the structure as a nested list, one line per node with key, component and state path, bullets alternating `-` and `*` by level, slot nodes marked `[slot]`. `rendered: true` lists what the headless page draws instead: rendered rows and cards with their runtime paths (`…board.cols.k_open.body.main.slots.0`), `(hidden)` nodes with their subtree counted |
| `ui_state_get` | `appId`, `path?`, `full?` | `{ appId, revision, source, state, preview }`, or with `path` `{ appId, revision, source, path, value, preview }` (`source` is `live` when an open view answered, else `stored`) (`unknown-path` names the closest part that exists); `state` is the synced state (`data` and the `app` articulation), asked of an open view or read from the stored copy. `data:` URIs and strings over 300 characters are shortened unless `full: true` |
| `ui_app_write` | `appId`, `operations` (1 to 50 of `set`, `remove`, `merge`, `move`), `expectedRevision?` | `{ appId, revision, warnings }`; `invalid-document`, `invalid-operation`, `conflict` |
| `ui_state_set` | `appId`, `path`, `value` or `remove: true`, `logic?`, `expectedRevision?` | `{ appId, revision, path }`; the value syncs to every open view, missing parents are created, `remove: true` removes an entry under `$.data` (a record), and the document revision does not change; `conflict`, `invalid-value` or the refusal reason; `logic: false` writes past the guards and fires no rule |
| `ui_state_reset` | `appId`, `expectedRevision?` | `{ appId, revision }`; `$.data` is the document's data again and `$.app` loses every articulation, no guard or rule runs, then the logic starts again with an empty trace; `persisted-app` |
| `ui_preview` | `appId` | `{ appId, revision, url, rendered, errors, note? }`; opens the headless page, or reloads it when it is already open, and waits for the revision |
| `ui_command` | `appId`, `target`, `command`, `value?` | `{ appId, revision, command, previewAttached, message }`; delivered to every open view, the headless page included. `navigate` takes a screen name as `target` and the params as `value` |
| `ui_file_read` | `appId`, `fileId` | `{ file, text, truncated, note? }` |
| `ui_app_delete` | `appId`, `expectedRevision` | `{ appId, revision }`; `conflict`, `not-found` |
| `ui_screenshot` | `appId`, `path?`, `width?`, `height?`, `mode?` | an MCP image (PNG) and `{ appId, revision, target, width, height, mode? }` |
| `ui_interact` | `appId`, `actions: [{ action: click|fill|press|hover|select|choose|focus|key|drag, path?, value? }]` | `{ appId, revision, results, errors, emits, cursor }`; an error (`action-failed`) when an action failed. `choose` picks a radio option by value or label, `focus` focuses the node or its nearest focusable ancestor, `key` presses a key on whatever has focus (no path), `drag` drags the node onto the node whose path is `value`. An action whose element was re-rendered meanwhile is tried again |
| `ui_events_read` | `appId`, `since?` (or `cursor?`) | `{ appId, events: [{ cursor, name, payload, at, view }], cursor }`; logic adds `logic.failed` and `logic.call` (`{ id, name, payload }`, view `logic`) |
| `ui_call_answer` | `appId`, `id`, `status` (`accepted` or `rejected`), `value?`, `reason?` | `{ appId, id, answered: true }`; the machine that made the `logic.call` gets the answer as its result; `not-waiting` when no call with that id waits |
| `ui_logic_trace` | `appId`, `limit?`, `clear?` | `{ appId, runs: [{ at, cause, changes, events: [{ depth, kind, name, outcome, path?, from?, to?, row?, writes?, reason? }] }] }`: the last runs of the logic (at most 25 kept), one event per unit whose trigger matched; `no-logic` when the logic does not run on the server |

Read-only tools carry `readOnlyHint`; only `ui_app_delete` carries `destructiveHint`. A failed call has `isError: true` and the body `{ error, message, ...details }`. Codes: `invalid-argument` (with `argument`), `not-found`, `unknown-tool`, `internal-error`, `browser-unavailable`, `not-rendered`, `action-failed`, and the codes in the table. Arguments are plain JSON; extra arguments and an `appId` that is not a UUID are refused.

Differences from `ui-builder`: no `workspace-missing` or `user-missing`, no `ownerId` in `ui_app_list`, no approval marker on `ui_app_delete` (the client can ask the user; the tool is annotated destructive), and `ui_preview`, `ui_command` and `ui_state_get` work against real views instead of an API socket.

`path` in `ui_screenshot` and `ui_interact` is the state path of a node, such as `$.app.children.form.children.email` (the leading `$.` is optional). It is mapped to the element the component rendered for that node, through open shadow roots. A hidden or closed node has no element.

## Browser endpoint

| Route | What |
|---|---|
| `GET /` | the apps, with a link to each |
| `GET /apps/:appId` | the live view of an app: an app document, or an owner app (a part) assembled with the default persona's instance |
| `GET /apps/:appId/sync?view=<uuid>` | the WebSocket of a view: the state-sync protocol and `{ type: 'view', message }` frames (document, commands, locale, theme, deletion); same origin only |
| `POST /apps/:appId/report` | what a view tells the server: ready, rendered revision and runtime errors |
| `POST /apps/:appId/files` | an upload from a `fileField`: `multipart/form-data` with one field `file`; `201 { id, name, size, type }`, `409 quota`, `413 too_large`, `415 unsupported_type` |
| `GET /apps/:appId/files/:fileId` | the bytes, as an attachment, `nosniff`, `Content-Security-Policy: sandbox; default-src 'none'` |
| `GET /assets/host.js`, `/assets/page.css` | the host script and the stylesheet |
| `POST`, `GET`, `DELETE /mcp` | MCP over streamable HTTP, with sessions |

The runtime port is a second origin that serves only the app frame; every other path there answers 404:

| Route | What |
|---|---|
| `GET /runtime/<hash>.html`, `/runtime/<hash>.js`, `/runtime/runtime.css` | the content-hashed StateUI runtime page and bundle, and the page's stylesheet |

**How the view works.** The page is a shell with one external script. The script puts the runtime page into a sandboxed iframe served from the runtime port (`sandbox="allow-scripts allow-same-origin"`), speaks the versioned message protocol of `@punyts/stateui-app/protocol` with a per-load nonce, and checks every message by source, origin and nonce. The frame keeps its own origin, which is not the page's, so it cannot reach the page; the page allows frames only from the runtime origin and the runtime page allows only the page to frame it, both by the host name the page was opened with. An opaque origin (`allow-scripts` alone) would isolate the frame the same way, but some embedded browsers refuse to load such a frame and show nothing. The message protocol is the same as in the preview of the minion UI, so the runtime bundle is used as built, with no Vite or bundling step. The app runs in Full mode of `@punyts/state-sync`: the page opens one WebSocket to the server, which carries the sync protocol between the page's sync client and the app's authority, and view frames with the document (on connect and after every `ui_app_write`, written into the running app as path writes where it can, or as a new load), commands and theme or locale switches. Every change a user makes to `$.data` or to the articulation of `$.app` (no `_` content, no `component`, `on`, `layout`, `placement` or `theme`) goes to the authority, and every change the authority applies (another view's, a `ui_state_set`) reaches every view. The sync client keeps the confirmed state, the changes not yet acknowledged and the document in `localStorage`, so the view opens and takes changes while the server is away and sends them in order when it is back; a change the server rejects is put back to the confirmed value and the app gets a `sync.rejected` event. `body[data-sync]` and `$.runtime.sync` show the status. `emit` events go over the socket too; ready, rendered and errors go to `POST /report`, each with the count of the view's loads, so the errors a view no longer reports are dropped. Query parameters `?mode=dark` and `?locale=fr` apply a theme overlay or a language to a view.

**Logic.** A Full app's authority runs the document's `logic` (see `@punyts/stateui-app`). A change a view sends runs the logic after it is applied and acknowledged; a guard rule (a rule whose only command is `reject`) answers before, so a refused change is rejected and the view gets `sync.rejected`. `ui_state_set` asks the guards too (a refused value is `logic-guard`) and then runs the logic. A transition's writes reach the views as one `changes` message. The authority keeps `$.app` sparse, so logic reads `$.app` as the document's value with the shape defaults under what the authority holds. `notify.<name>` and `logic.failed` reach the views as app events (the root node's `on`); `emit` and failures are also queued for `ui_events_read`. `ui_outline` of the root lists the machines with their current state, the rules, the guards and the decision tables with their rows. Timers (`after`, `debounce`) run in the server process and are lost on a restart, where they are armed again. A `call` command runs the procedure of that name given to `startServer` (`procedures`: `(payload, { appId }) => LogicAnswer`); any other call is queued as a `logic.call` event for `ui_events_read`, and the agent answers it with `ui_call_answer`. At most 100 calls wait per app, and waiting calls are dropped on a restart or when the app is removed. Persisted and Standalone apps run the same logic in the browser, without `call`.

**Statenet.** With `--statenet ws://127.0.0.1:4200/sync` the app state lives in a [`@punyts/statenet`](https://github.com/punyts/statenet), one namespace per app (`apps.<appId>`), instead of `state.json`. Each app's authority loads its namespace from the statenet when the app is first used and relays every change it accepts (a view's, a `ui_state_set`) in order, with the change ids, so the statenet applies each once; the first save into an empty namespace sends the authority's whole state. A restarted server picks the state up again from the statenet. `$.server` (server-only values, never sent to a view) is relayed encrypted as `$.sealed`, so the statenet stores ciphertext it cannot read; the key comes from `--secret-key-file` (32 raw bytes, 64 hex characters or base64) or `STATEUI_MCP_SECRET_KEY`. Without a key, an app whose stored state has `$.server` fails with a message that names both options.

**Persisted apps.** `ui_app_create` with `sync: "persisted"` makes an app with no server logic: its state is only in the statenet, which the server seeds with the document's `data` and an empty `app`. Its page connects its sync client straight to the statenet (`data-statenet-url` on the page, and `connect-src` allows the statenet's origin); the socket to this server carries only the view frames (the document, commands, theme and locale). `ui_state_get` reads the state from the statenet; `ui_state_set` is refused (`persisted-app`), and the views' `emit` events do not reach `ui_events_read`. The statenet admits a browser page only from an allowed origin: start it with `--allow-origin http://127.0.0.1:4100` (this server's origin). Without `--statenet`, creating a Persisted app is refused (`no-statenet`).

**Playwright.** The server keeps one headless Chromium, started on the first call that needs it and closed on shutdown, with one page per app. The page loads the same `/apps/:appId` URL a person opens, so it is a view like any other: it receives the same messages, `ui_command` reaches it and its changes sync like any view's. `ui_screenshot` and `ui_interact` look up the element in the runtime frame and use Playwright's own click, fill, press, hover and select on the native control inside it, so the events are the ones a user raises.

**Policy.** The host page allows scripts, styles, connections and frames from its own origin only, no inline script, no inline style, no framing by other pages. The runtime page has `default-src 'none'`, scripts only from its own origin plus `'unsafe-eval'` (the expression library builds functions for binding expressions), no network, images and fonts as `data:` only, and may be framed by this server's pages only. Uploaded files are never served inline.

## Data directory

One folder per app, named by its UUID:

```text
data/<appId>/app.json      id, name, revision, createdAt, updatedAt and the document
data/<appId>/state.json    the synced state, its sync revision and change log (the app's authority; not with --statenet)
data/<appId>/errors.json   the bounded preview error log (the newest 50); a view that renders again drops the errors of its earlier loads and of other views
data/<appId>/files.json    metadata of the uploaded files
data/<appId>/files/<id>    the bytes of one uploaded file
```

Every file is written to a temporary file in the same folder and renamed into place, and the writes of one app run one at a time, so a reader never sees half a file and a write is checked against the revision it read. `children` and keyed data maps are ordered by key: the files are written with `JSON.stringify` and read with `JSON.parse` and nothing re-sorts them (integer-like keys are refused, because JavaScript would move them). `app.json` (the document and its revision) and `state.json` (the synced state, written by the authority) are separate, so a state write never touches the document revision. Limits: 1 MiB per document, 2000 nodes, 10 MiB per file, 50 files and 100 MiB per app. Uploaded files that nothing references (not in the document or the synced state, read live in every mode: the server's authority, the statenet, or the statenet alone for a Persisted app; `$.server` is not included) are removed after 24 hours, when the next upload to the app happens.

**Owner parts (in progress, not used by the tools yet).** The owner-tree design moves apps to reusable parts (apps, themes, logic modules, models, datasets, components, patterns). `UiPart` (`src/domain/UiPart.ts`) is one stored part: an immutable UUID `id`, the `kind`, a slug `name` (`isPartName` of `@punyts/stateui-app/core`), the `revision` and the `body` of its kind. `UiPartRepository` (`src/application/ports/`) is the storage contract for every kind: `create`, `findByName`, `findById`, `list`, `write` and `delete` with `expectedRevision`, and `rename`; results are `created`, `written`, `deleted`, `renamed`, `conflict`, `not-found`, `duplicate-name` or `invalid` (a name that is not a slug, a body that is not an object). `FilePartRepository` stores them in the same data directory, beside the app folders (`PartFolders` builds every path, from a kind and a UUID only):

```text
data/<kind>/<id>.json      id, kind, name, revision, createdAt, updatedAt and the body; kinds: apps, themes, logic, models, data, components, patterns
data/names.json            { <kind>: { <name>: <id> } }
```

A rename moves no file. The part file is the truth and is written first; `names.json` is an index written after it and rebuilt from the part files at the first call when it is missing or disagrees. Writes to one part run one at a time, and creates, renames and deletes of one kind run one at a time, so two creates of one name cannot both win. `partRepository.contract.test.ts` runs the same cases against `FilePartRepository` and the in-memory fake (`src/testing/InMemoryUiPartRepository.ts`). `UsageIndex` (`src/application/`) knows who uses what: an app's themes, datasets, persona models, logic modules and the components in its nodes, a module's `needs`, a dataset's model and the components in a component's tree, plus each app's `start` screen. `IndexedUiPartRepository` builds it from the stored parts at the first call and keeps it in step with every change; `deleteRule` refuses to delete a part while anything uses it, or a screen that is its app's `start`, and names the users. `WritePart` (`src/application/use-cases/`) checks a part with the reader of its kind and refuses it with its own errors, writes it with `expectedRevision` (or creates it on a first write), then checks every app that reaches it and returns the ones it breaks as warnings (at most 20, with `moreApps`); a model write also names the dataset records that no longer fit. `ValidatePartApp` checks one app assembled with everything it reaches, each error naming its part.

`RenamePart` (`src/application/use-cases/`) renames a part and rewrites every part that names it, all together: theme lists, bindings' `dataset` and `model`, `uses.logic` keys (in their place), `needs` models, datasets' models and the composed names in nodes. It checks the new name as a slug that is not taken, keeps the part's id (so instances and persona data stay where they are) and gives the renamed part and each rewritten one the next revision; it reads again and retries when a part it rewrites moved meanwhile. `UiPartRepository.rename` takes those new bodies as `rewrites`. When it writes more than one part file, `FilePartRepository` first writes `rename.pending.json` (every part file with its new content), then the part files and `names.json`, and removes the journal last; a rename of a part that nothing names writes that part and `names.json` only. A journal that is still there was stopped halfway: `FilePartRepository.recover` (run by `startServer` before anything reads a part, and before the first call reads the names) writes the files that differ from it, removes it and rebuilds `names.json`; running it again changes nothing. Renaming a screen (`kind: "screens"`) is a write of its app with the app's revision: the key in `screens` in its place, `start` and every `navigate` to it.

What a person does in an owner app is its instance, kept apart from the definition. `UiInstanceRepository` (`src/application/ports/`) stores the default persona's instance of each app as a diff over the definition (`diffInstance` of `@punyts/stateui-app/core`), and the records of each persona binding (`uses.data.{binding}` with `scope: "persona"`, which has no part). `FileUiInstanceRepository` keeps them by app id, so a rename of the app keeps them:

```text
data/personas/default/apps/<ownerId>/<appId>.json    the diff (app, screens, route, theme, data); no file when nothing differs
data/personas/default/data/<appId>/<binding>.json    { model, records }; a capital in the name is ^ and its small letter
```

The owner id of the local server is `LOCAL_OWNER_ID` (`ownerId` of `createServices` overrides it). A missing file reads as the definition, and a file that cannot be read is ignored with a `problem` the caller reports, never thrown at the person. Nothing there writes a part, and a part write never touches an instance. `WritePersonaData` checks the records against the binding's model as a dataset part's are checked; `ResetInstance` removes the instance and the persona records.

A running instance has its own state-sync authority. `AppAuthorities` is keyed by sync namespace: `apps.<appId>` for an old app document, `instances.<persona>.<ownerId>.<appId>` for an instance (`appNamespace` takes either). An instance's state is the assembled view: `$.app` and `$.screens` sparse, `$.route`, and `$.data` by binding, holding a copy of each shared dataset and the persona's records, with the instance laid over it. Its logic is the assembled logic, the app's units plus its bound modules. `InstanceNamespaceStorage` keeps that state as the instance (the diff and the persona records), never the shared copies or `$.server`. It keeps no sync log, so a loaded instance's revision is the clock in milliseconds and a view from before a restart gets a snapshot. `AuthorityInstanceStates` assembles the app on every call and restarts the instance over a changed definition. `SetPartState` writes `$.app`, `$.screens.{screen}` and persona `$.data.{binding}` paths, and refuses content, `$.theme` and the other definition roots (`definition-path`), shared datasets (`shared-dataset`, naming `ui_data_write`) and `$.route` (use `navigate`). No tool calls them yet; the tools still use the app folders above.

The live view of an owner app has the same URL, `/apps/<appId>` with the app part's id. Its page shows the assembled app (`InstanceViews`: the shell, the screens, the themes, the bound data and modules) with the default persona's instance laid over it (the runtime's `load` takes it as `instance`), and its sync client talks to that instance's authority (`data-namespace` on the page). Besides `$.data` and `$.app`, the view syncs each screen's articulation (`$.screens`) and the route (`$.route`); a route moved in another view arrives as a `navigate` command. Every part change that succeeds (`IndexedUiPartRepository.onChange`) reaches the open views of the apps that show the part (`LiveViews.partChanged`): the page writes a change of the shell's nodes in place and loads a changed theme, locale, screen or component again in full. A changed definition also restarts the instance's authority, so the views reconnect and get its state. The revision a view of an owner app reports is counted by `InstanceViews`, one more each time the assembled document changes, from 1 at start. `BrowserPreview.open` takes a screen and params (`?screen=<name>&params=<json>` on the view URL) to open the app there instead of where its instance is.

## Security notes

- **Local only by default.** The server binds `127.0.0.1`. While it is bound to a loopback address, a request whose `Host` is not `localhost`, `127.0.0.1` or `[::1]` is refused (DNS rebinding), and a `POST` with an `Origin` header from another host is refused.
- **No authentication.** Anyone who can reach the port can read, change and delete every app and use the headless browser. `--host 0.0.0.0` exposes all of that to the network and turns the Host check off. Do it only on a network you trust, or put your own authentication in front.
- **Apps run code.** An app document can contain binding expressions that run in the sandboxed frame. The frame has no network (`connect-src 'none'`) and no forms. Its origin has its own storage, and it can read cookies that other local servers set for the same host name, but it has no way to send them anywhere except as app events to this server. The headless Chromium is a real browser on your machine: do not point it at documents you do not trust.
- **Paths.** Only UUIDs reach a file path. A file name is metadata and never part of a path.
- **Uploads.** The type is sniffed from the bytes; the type the client claims is ignored. HTML, SVG, XML and executables are refused.

## Develop

```sh
npm run typecheck   # server and browser host script
npm run build       # dist/ (server) and dist/browser/host.js (host script)
npm test            # Vitest; the Playwright test skips itself when Chromium is missing
```

Layout: `src/domain` (pure rules), `src/application` (ports and use cases), `src/infrastructure/storage` (the JSON file adapters), `src/infrastructure/mcp` (tools and server), `src/infrastructure/http` (routes, pages, policy), `src/infrastructure/preview` (the hub of live views and the Playwright adapter), `src/browser/host.ts` (the script that runs in the page), `src/config` (options and composition), `src/testing` (fixtures and in-memory fakes for tests; not built).

## License

MIT

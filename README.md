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
| `--secret-key-file <file>` | `STATEUI_MCP_SECRET_KEY_FILE`, or the key itself in `STATEUI_MCP_SECRET_KEY` | none: an app that keeps `$.server` is refused |
| `--tool-log <file>` | `STATEUI_MCP_TOOL_LOG` | none: no tool calls are logged |

**Tool-call log.** With `--tool-log <file>` the server appends one JSON line per tool call: `{ at, tool, ok, errorCode?, requestChars, responseChars, target?, errorCount?, warningCount? }`. `requestChars` is the length of the JSON arguments, `responseChars` the length of the result's text (images are not counted), `errorCode` the `error` of a failed result, `errorCount` and `warningCount` the lengths of its `errors` and `warnings`, and `target` the call's `app` (with `/` and `screen` when it names one), cut to 80 characters. Nothing else is written: no arguments, no response bodies. A failed write is reported once on stderr and never fails the call. It is for measuring how agents use the tools.

`npm start` runs `node dist/cli.js`; `stateui-mcp --help` lists the options. `stateui-mcp convert` converts the old apps of a data directory into owner parts once (see [Converting the old apps](#converting-the-old-apps)). In stdio mode every log line goes to stderr, because stdout is the protocol. `Ctrl+C`, `SIGTERM`, or the client closing stdin stops the server, closes the MCP sessions and closes the headless browser.

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

The server sends instructions that start with the eight build steps (`searchWorkflowSection`): plan (`ui_list`; a large app, more than three screens or one that writes to an owner dataset other apps use, waits for the user's OK on the plan), theme (`ui_theme_create`, `ui_theme_write`, `ui_tokens_list`), data (`ui_model_write`, `ui_data_write`), app and shell (`ui_patterns_search`, `ui_app_create`), screens (`ui_patterns_search`, `ui_screen_create`), sections (`ui_components_search`, `ui_component_get`, `ui_nodes_write`), logic (`ui_logic_write`) and check (`ui_validate`, `ui_preview`, `ui_screenshot` full page and at 375 px, `ui_interact`). The order is guidance and an edit starts at the step it needs. Then the library's theme presets (`PatternCatalog.presets()`; the line is left out while there are none) and a category index generated from the catalog (each category with its count and three typical members), then the owner tree (parts the owner keeps by name, build time and run time tools, paths such as `$.app`, `$.screens.<name>` and `$.route`, modules and params, a revision per part with its warnings), the rules that cost a failed call (icon names from `ui_icons_list`, no integer-like record keys, no set through a missing parent), and how to read events. The tool descriptions carry the same guidance, and each starts with `Build time:` or `Run time:`.

## Tools

Thirty-three tools in three groups: build time, the owner's data and run time. Build time tools change definitions (parts) and never touch an instance; run time tools act on the default persona's instance of an app part and never change a definition. `ui_pattern_write` and `ui_patterns_search` of the design ship later, with the search-first epic 2.

| Tool | Arguments | Result |
|---|---|---|
| `ui_components_search` | `need`, `category?`, `tier?`, `limit?` (5, at most 20) | `{ results: [{ name, category, tier, summary, matched, example }], weak, categories? }`, best first and never empty: `weak` when nothing fits well, and a need that matches nothing gets the category index and the nearest category's components; an unknown `category` or `tier` is `invalid-argument` with `allowed` |
| `ui_component_get` | `name` | the compact catalog entry (properties with only the keys that apply, slots, events, commands, tokens, example; a composed component's tree and exposed paths); an unknown name is `unknown-component` with `nearest` |
| `ui_icons_list` | `query?`, `category?`, `filled?`, `limit?` | `{ icons, total, more }` |
| `ui_tokens_list` | `group?`, `query?`, `includeOverlays?` | `{ count, tokens, overlays? }`; `unknown-group` lists the groups |
| `ui_patterns_search` | `need`, `kind?` (`shell` or `screen`), `limit?` (5, at most 20) | `{ results: [{ name, kind, summary, matched, slots, params, components, source }], weak }`, best first and never empty: `weak` when nothing matched or the best match holds none of its purpose phrases; a need that matches nothing gets the patterns of the kind (of both kinds when no kind is given or the kind has none); a missing or blank `need` and an unknown `kind` are `invalid-argument` (with `allowed`) |
| `ui_tree` | `app`, `persona?`, `screen?`, `content?`, `logic?`, `path?`, `depth?`, `paths?`, `rendered?` | `{ app, revision, text, lineCount, cutLines, nodeCount?, screens? }`. It shows the default persona's instance (`OutlinePartApp`): the shell with the screens drawn at its outlet (one screen takes the outlet's place under its key, several are listed under it by name), each screen node with its runtime path (`$.screens.home.children.form`); `screen` draws only that one. `content: true` gives the content outline (text, links, marks, record counts from the instance) instead of the structure; `logic: true` adds each machine with its current state in the instance, then the rules, guards and tables, a module's units with the module as prefix (`cart:totals`). Default: the structure as a nested list, one line per node with key, component and state path, bullets alternating `-` and `*` by level, slot nodes marked `[slot]`. `rendered: true` lists what the headless page draws instead: rendered rows and cards with their runtime paths (`…board.cols.k_open.body.main.slots.0`), `(hidden)` nodes with their subtree counted |
| `ui_validate` | `app` | `{ app, revision, valid, errors, warnings, uses }`: the app assembled with every part it uses, each error naming its `part` |
| `ui_state_get` | `app`, `persona?`, `path?`, `full?` | `{ app, revision, source, state, preview }`, or with `path` `{ app, revision, source, path, value, preview }`; `source` is `instance`, the state of the running instance (`unknown-path` names the closest part that exists). `state` is `{ data, app, screens, route }`. `data:` URIs and strings over 300 characters are shortened unless `full: true` |
| `ui_state_set` | `app`, `persona?`, `path`, `value` or `remove: true`, `logic?`, `expectedRevision?` | `{ app, revision, path }`; the value syncs to every open view, missing parents are created, `remove: true` removes an entry under `$.data`, `logic: false` writes past the guards with no rule firing. A definition path is refused (`definition-path`), a shared dataset too (`shared-dataset`, change it with `ui_data_write`) |
| `ui_state_reset` | `app`, `persona?`, `expectedRevision?` | `{ app, revision }`; the running instance stops, its instance and persona records are removed and its views reconnect to a fresh one; the logic starts again with an empty trace |
| `ui_preview` | `app`, `persona?`, `screen?`, `params?` | `{ app, revision, url, rendered, errors, note? }`; opens the headless page, or reloads it when it is already open, and waits for the revision. `screen` and `params` open that screen first (the instance stays there); an unknown screen is `invalid-argument` with `screens` |
| `ui_command` | `app`, `persona?`, `target`, `command`, `value?` | `{ app, revision, command, previewAttached, message }`; delivered to every open view, the headless page included. `navigate` takes a screen name as `target` and the params as `value` |
| `ui_file_read` | `app`, `persona?`, `fileId` | `{ file, text, truncated, note? }` |
| `ui_screenshot` | `app`, `persona?`, `screen?`, `params?`, `path?`, `width?`, `height?`, `mode?`, `fullPage?` | an MCP image (PNG) and `{ app, revision, target, width, height, mode?, screen? }`; `screen` and `params` as for `ui_preview` |
| `ui_interact` | `app`, `persona?`, `actions: [{ action: click|fill|press|hover|select|choose|focus|key|drag, path?, value? }]` | `{ app, revision, results, errors, emits, cursor }`; an error (`action-failed`) when an action failed. `choose` picks a radio option by value or label, `focus` focuses the node or its nearest focusable ancestor, `key` presses a key on whatever has focus (no path), `drag` drags the node onto the node whose path is `value`. An action whose element was re-rendered meanwhile is tried again |
| `ui_events_read` | `app`, `persona?`, `since?` (or `cursor?`) | `{ app, events: [{ cursor, name, payload, at, view }], cursor }`; logic adds `logic.failed` and `logic.call` (`{ id, name, payload }`, view `logic`) |
| `ui_call_answer` | `app`, `persona?`, `id`, `status` (`accepted` or `rejected`), `value?`, `reason?` | `{ app, id, answered: true }`; the machine that made the `logic.call` gets the answer as its result; `not-waiting` when no call with that id waits |
| `ui_logic_trace` | `app`, `persona?`, `limit?`, `clear?` | `{ app, runs: [{ at, cause, changes, events: [{ depth, kind, name, outcome, path?, from?, to?, row?, writes?, reason? }] }] }`: the last runs of the logic (at most 25 kept), one event per unit whose trigger matched; `no-logic` when the logic does not run on the server |

The tools of the owner's parts (`kind` is one of `apps`, `themes`, `logic`, `models`, `data`, `components`, `patterns`, `screens`, and `screens` takes `app`):

| Tool | Arguments | Result |
|---|---|---|
| `ui_list` | `kind`, `query?`, `app?` | `{ kind, count, items: [{ name, revision, updatedAt, title?, uses? }] }`, by name; screens: `{ kind, app, revision, count, items: [{ name, title?, start? }] }`. `query` keeps the items with every word in the name or title |
| `ui_get` | `kind`, `name`, `app?`, `path?`, `depth?`, `resolved?` | `{ kind, name, id, revision, path, value, resolved, note? }`; a screen has its app's id and revision; `resolved` (apps only) is the assembled app; `not-found` with `nearest`, `missing-path` |
| `ui_delete` | `kind`, `name`, `app?`, `expectedRevision` | `{ kind, name, revision }`; `in-use` with `users` (a used part, a start screen), `conflict`, `not-found`. Deleting an app also stops and deletes its instance and persona records, removes its side folder (preview errors and uploaded files) and closes its views |
| `ui_rename` | `kind`, `name`, `to`, `app?`, `expectedRevision` | `{ kind, name, revision, rewritten: [{ kind, name, revision }] }` (`RenamePart`); `duplicate-name`, `invalid-name`, `conflict`, `not-found` |
| `ui_app_create` | `name`, `shell` (a node tree with one `outlet`, or `{ pattern, params? }`, a library shell pattern), `title?`, `themes?`, `data?`, `logic?` (the three parts of `uses`) | `{ name, id, revision, start: "home", slots, warnings }` (`CreatePartApp`): the app starts with one screen, `home`. A pattern is copied once with `applyPattern` (each param left out takes its default) as ordinary nodes, and `slots` lists its places to fill as `{ name, path, description }` with node paths under `$.app` (empty for a node tree). `not-found` with `missing: [{ kind, name, nearest }]`, `invalid-app` with `errors` (each naming its `part`; a link under `$.data` to nothing adds a hint on what to bind), `invalid-argument` for an unknown pattern (with `nearest`), a screen pattern, or param values (`argument: "shell.params"`, `params` naming each) |
| `ui_app_configure` | `name`, `expectedRevision`, `title?`, `uses?`, `start?` | `{ name, revision, warnings }` (`ConfigureApp`): only those fields change; a new `uses` replaces the old one and is checked whole. `not-found`, `invalid-app`, `conflict` |
| `ui_screen_create` | `app`, `name`, `expectedRevision` (the app's), `title?`, `params?` (the screen's typed params), `root` or `pattern` (a library screen pattern) with `patternParams?` | `{ app, name, revision, slots, warnings }` (`CreateScreen`), with the app's new revision; `slots` as for `ui_app_create`, with node paths under `$.screens.<name>`. `duplicate-name`, `conflict`, `not-found`, `invalid-app`, `invalid-argument` for an unknown pattern (with `nearest`), a shell pattern, or param values (`argument: "patternParams"`) |
| `ui_nodes_write` | `app`, `screen` (a screen name or `"shell"`), `expectedRevision` (the app's), `operations` (`add`, `set`, `merge`, `remove`, `move` on paths that start with `root`, or `$.screens.<screen>...` / `$.app...`) | `{ app, screen, revision, warnings, added: [{ index, path }] }` (`WriteNodes`): the operations apply in order to the one tree, then the app is checked whole. `add` takes `key?`, `before?`, `after?`. `invalid-operation`, `invalid-app` (`SUI-SHELL-OUTLET` for a shell left without its outlet), `conflict`, `not-found` |
| `ui_locale_write` | `app`, `screen` (or `"shell"`), `language`, `expectedRevision`, `operations` (`set`, `remove` on content paths) | `{ app, screen, language, revision, warnings }` (`WriteLocale`): the overlay of that language for that tree; each content path still untranslated is a `SUI-LOCALE-MISSING` warning. An emptied overlay is removed. `invalid-argument`, `invalid-operation`, `invalid-app`, `conflict`, `not-found` |
| `ui_theme_create` | `name`, and `from` (a theme to copy) or `preset` | `{ theme, revision, warnings, contrast, reaches }` (`CreateTheme`): a copy with its own id at revision 1. `invalid-argument` "No such preset" (the library has no presets yet), `not-found`, `duplicate-name`, `invalid-name` |
| `ui_theme_write` | `theme`, `expectedRevision` (leave it out to create the theme from no tokens), `operations` (`set` and `remove` of a token, at the base or in `overlay`; `add-overlay` with `kind`; `remove-overlay`) | `{ theme, revision, created, warnings, contrast, reaches }` (`WriteTheme`, through `WritePart`): `contrast` lists `{ mode, text, surface, ratio, passesAA }` for each text pair in each mode (`ratio: "unresolved"` when a side is not an opaque colour); `reaches` the components whose own tokens refer to each written token; `warnings` the apps the write breaks. `invalid-theme`, `invalid-operation`, `conflict` (also for a create of a theme that exists), `not-found`, `invalid-name` |
| `ui_model_write` | `model`, `expectedRevision` (leave it out to create the model), `operations` (`set` of a field with `type`, `default`, `required`, `validators`, replacing its whole declaration; `remove` of a field) | `{ model, revision, created, warnings, datasetWarnings, readers }` (`WriteModel`, through `WritePart`): `datasetWarnings` lists the datasets of the model whose records no longer fit (`{ dataset, keys, invalidCount }`), `readers` the apps and logic modules whose `$.data.<binding>.<record>.<field>` paths read a removed field (`{ kind, name, paths }`), `warnings` the apps the write breaks. An unknown type or validator is `invalid-argument` with `allowed`; a default that fails its type or its own validators is `invalid-model`. `invalid-operation`, `conflict`, `not-found`, `duplicate-name`, `invalid-name` |
| `ui_data_write` | `dataset`, `model` (only to create the dataset), optional `expectedRevision`, `operations` (`add` with a record `value`; `set`, `merge`, `remove` and `move` on a `path` below the records, such as `p1` or `p1.price`) | `{ dataset, revision, created, added }` (`WriteData`): `added` holds the generated key of each `add` (`r` and an id, never integer-like). Every touched record is checked against the model; a record that does not fit refuses the whole write as `invalid-records`, each error with `record` and `field`. Without `expectedRevision` the write applies to the newest records. Open apps bound to the dataset show the change at once. `conflict`, `not-found` (dataset or model, with `nearest`), `invalid-argument` for a `model` other than the dataset's, `invalid-name` |
| `ui_data_query` | `dataset`, optional `filter` (an expression over `$record` and `$key`), `sort` (`"price"`, `"-price"` or `{ by, direction }`) and `window` (`{ first, count }`, count 20 by default, at most 100) | `{ dataset, revision, records: [{ key, record }], first, total }` (`QueryData`); `total` counts the matching records before the window. A filter that does not evaluate is `invalid-argument` |
| `ui_logic_write` | `app` or `module` (exactly one), `expectedRevision` (required for an app; leave it out to create a module), `operations` (`set` of a unit whole, `remove`; `unit` is `machines.<name>`, `rules.<name>` or `tables.<name>`), and for a module `needs` and `params` (each replaced whole) | `{ app \| module, revision, created, units, warnings }` (`WriteLogic`): `units` gives each unit the write left set with its `position` in the run order (`logicRunOrder` of the app assembled with its modules, or of the module) and the paths it `reads` and `writes`; a guard has no position. An app is checked as a whole (`invalid-app`), a module by the module rules through `WritePart` (`invalid-module`, `SUI-MODULE-NODE`, `SUI-MODULE-NEEDS`); `warnings` are the app's, or for a module the apps it breaks. `invalid-operation`, `conflict`, `not-found`, `duplicate-name`, `missing-parts` |
| `ui_composed_write` | `name`, `expectedRevision` (leave it out to create), `tree` (required to create), `exposes` (`[{ path, description }]`), and for the component search `summary` (one line, at most 120 characters), `category` (one of `COMPONENT_CATEGORIES`) and `purposes` (3 to 8 one-line phrases of at most 60 characters, `checkPurposes`) | `{ name, revision, created, searchable, note?, appWarnings, moreApps? }` (`WriteComposed`): the search fields are stored beside the tree and never reach the assembled tree; a write that leaves one out keeps it, `""` or `[]` removes it. `searchable` is true with all three (otherwise `note` says it is found by name only). The part goes through `WritePart` (`invalid-component`, such as `SUI-NODE-CYCLE` for a component that contains itself), and `appWarnings` names the apps the write breaks. A library component name is `invalid-name`. `invalid-argument` names the search field (with `allowed` for `category`), `duplicate-name`, `not-found`, `conflict` |
| `ui_pattern_write` | `name`, `expectedRevision` (leave it out to create), `kind` (`shell` or `screen`), `summary` and `purposes` (required to create), `tree` or `from` (`{ app, screen }`, screen `"shell"` for the shell; one of them required to create), `slots`, `params` | `{ name, revision, created }`. Writes an owner pattern in the library's `*.pattern.json` format, checked with `readPattern` and `checkPattern` of `@punyts/stateui-app` (owner components count as composed components): a bad slot or param path, an outlet in a screen or a shell without exactly one is `invalid-pattern` with errors at `patterns/{name}.pattern.json`, and nothing is written. A library pattern name is `invalid-name`. Parts left out of an update are kept. Listed, read, renamed and deleted by the generic tools (kind `patterns`) |

Read-only tools carry `readOnlyHint`; `ui_delete` and `ui_rename` carry `destructiveHint`, so the client asks the user. A failed call has `isError: true` and the body `{ error, message, ...details }`. Codes: `invalid-argument` (with `argument`), `not-found`, `unknown-tool`, `internal-error`, `browser-unavailable`, `not-rendered`, `action-failed`, and the codes in the table. Arguments are plain JSON; extra arguments are refused, so a call with the `appId` of the removed tools fails.

Differences from `ui-builder`: no `workspace-missing` or `user-missing`, no approval marker on `ui_delete` and `ui_rename` (the client can ask the user; the tools are annotated destructive), and the run time tools act on the default persona's instance, as the local owner's only user.

`path` in `ui_screenshot` and `ui_interact` is the state path of a node, such as `$.app.children.form.children.email` (the leading `$.` is optional). It is mapped to the element the component rendered for that node, through open shadow roots. A hidden or closed node has no element.

## Browser endpoint

| Route | What |
|---|---|
| `GET /` | the apps (app parts), with a link to each |
| `GET /apps/:appId` | the live view of an app part, assembled and with the default persona's instance |
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

**How the view works.** The page is a shell with one external script. The script puts the runtime page into a sandboxed iframe served from the runtime port (`sandbox="allow-scripts allow-same-origin"`), speaks the versioned message protocol of `@punyts/stateui-app/protocol` with a per-load nonce, and checks every message by source, origin and nonce. The frame keeps its own origin, which is not the page's, so it cannot reach the page; the page allows frames only from the runtime origin and the runtime page allows only the page to frame it, both by the host name the page was opened with. An opaque origin (`allow-scripts` alone) would isolate the frame the same way, but some embedded browsers refuse to load such a frame and show nothing. The message protocol is the same as in the preview of the minion UI, so the runtime bundle is used as built, with no Vite or bundling step. The app runs in Full mode of `@punyts/state-sync`: the page opens one WebSocket to the server, which carries the sync protocol between the page's sync client and the app's authority, and view frames with the document (on connect and after every part write, written into the running app as path writes where it can, or as a new load), commands and theme or locale switches. Every change a user makes to `$.data` or to the articulation of `$.app` (no `_` content, no `component`, `on`, `layout`, `placement` or `theme`) goes to the authority, and every change the authority applies (another view's, a `ui_state_set`) reaches every view. The sync client keeps the confirmed state, the changes not yet acknowledged and the document in `localStorage`, so the view opens and takes changes while the server is away and sends them in order when it is back; a change the server rejects is put back to the confirmed value and the app gets a `sync.rejected` event. `body[data-sync]` and `$.runtime.sync` show the status. `emit` events go over the socket too; ready, rendered and errors go to `POST /report`, each with the count of the view's loads, so the errors a view no longer reports are dropped. Query parameters `?mode=dark` and `?locale=fr` apply a theme overlay or a language to a view.

**Logic.** A Full app's authority runs the document's `logic` (see `@punyts/stateui-app`). A change a view sends runs the logic after it is applied and acknowledged; a guard rule (a rule whose only command is `reject`) answers before, so a refused change is rejected and the view gets `sync.rejected`. `ui_state_set` asks the guards too (a refused value is `logic-guard`) and then runs the logic. A transition's writes reach the views as one `changes` message. The authority keeps `$.app` sparse, so logic reads `$.app` as the document's value with the shape defaults under what the authority holds. `notify.<name>` and `logic.failed` reach the views as app events (the root node's `on`); `emit` and failures are also queued for `ui_events_read`. `ui_tree` with `logic: true` lists the machines with their current state, the rules, the guards and the decision tables with their rows. Timers (`after`, `debounce`) run in the server process and are lost on a restart, where they are armed again. A `call` command runs the procedure of that name given to `startServer` (`procedures`: `(payload, { appId }) => LogicAnswer`); any other call is queued as a `logic.call` event for `ui_events_read`, and the agent answers it with `ui_call_answer`. At most 100 calls wait per app, and waiting calls are dropped on a restart or when the app is removed.



**Playwright.** The server keeps one headless Chromium, started on the first call that needs it and closed on shutdown, with one page per app. The page loads the same `/apps/:appId` URL a person opens, so it is a view like any other: it receives the same messages, `ui_command` reaches it and its changes sync like any view's. `ui_screenshot` and `ui_interact` look up the element in the runtime frame and use Playwright's own click, fill, press, hover and select on the native control inside it, so the events are the ones a user raises.

**Policy.** The host page allows scripts, styles, connections and frames from its own origin only, no inline script, no inline style, no framing by other pages. The runtime page has `default-src 'none'`, scripts only from its own origin plus `'unsafe-eval'` (the expression library builds functions for binding expressions), no network, images and fonts as `data:` only, and may be framed by this server's pages only. Uploaded files are never served inline.

## Data directory

The directory holds the owner's parts, one file each, the default persona's instances and, per app part, a side folder with its preview errors and uploaded files. The old single-document store (one folder per app with an `app.json`) is gone: the tools no longer read it, and only `stateui-mcp convert` does.

```text
data/<appId>/                       the side folder of an app part: errors.json, files.json and files/ (below); an old app's folder keeps them after convert
data/<kind>/<id>.json               an owner part; data/names.json indexes them by name (Owner parts, below)
data/rename.pending.json            the journal of a rename stopped halfway, replayed at start
data/personas/default/...           the default persona's instances and persona records
data/.converted/<appId>/            app.json and state.json of a converted app, until convert --purge
```

The side folder of an app part is named by its part id. The old store used the same folder for its `app.json` and `state.json`, which `stateui-mcp convert` reads and moves away:

```text
data/<appId>/app.json      the old store only: id, name, revision, createdAt, updatedAt and the document
data/<appId>/state.json    the old store only: the synced state, its sync revision and change log
data/<appId>/errors.json   the bounded preview error log (the newest 50); a view that renders again drops the errors of its earlier loads and of other views
data/<appId>/files.json    metadata of the uploaded files
data/<appId>/files/<id>    the bytes of one uploaded file
```

Every file is written to a temporary file in the same folder and renamed into place, and the writes of one app run one at a time, so a reader never sees half a file and a write is checked against the revision it read. `children` and keyed data maps are ordered by key: the files are written with `JSON.stringify` and read with `JSON.parse` and nothing re-sorts them (integer-like keys are refused, because JavaScript would move them). Limits: 1 MiB per document, 2000 nodes, 10 MiB per file, 50 files and 100 MiB per app. Uploaded files that nothing references (not in the app part or in the state of its instance, read live from the instance's authority; `$.server` is not included) are removed after 24 hours, when the next upload to the app happens.

**Owner parts.** The owner-tree design moves apps to reusable parts (apps, themes, logic modules, models, datasets, components, patterns). `UiPart` (`src/domain/UiPart.ts`) is one stored part: an immutable UUID `id`, the `kind`, a slug `name` (`isPartName` of `@punyts/stateui-app/core`), the `revision` and the `body` of its kind. `UiPartRepository` (`src/application/ports/`) is the storage contract for every kind: `create`, `findByName`, `findById`, `list`, `write` and `delete` with `expectedRevision`, and `rename`; results are `created`, `written`, `deleted`, `renamed`, `conflict`, `not-found`, `duplicate-name` or `invalid` (a name that is not a slug, a body that is not an object, or a given `id` that is not a UUID or that a part of the kind has). `create` takes an optional `id` so the converter can keep an old app's id. `FilePartRepository` stores them in the same data directory, (`PartFolders` builds every path, from a kind and a UUID only):

```text
data/<kind>/<id>.json      id, kind, name, revision, createdAt, updatedAt and the body; kinds: apps, themes, logic, models, data, components, patterns
data/names.json            { <kind>: { <name>: <id> } }
```

A rename moves no file. The part file is the truth and is written first; `names.json` is an index written after it and rebuilt from the part files at the first call when it is missing or disagrees. Writes to one part run one at a time, and creates, renames and deletes of one kind run one at a time, so two creates of one name cannot both win. `partRepository.contract.test.ts` runs the same cases against `FilePartRepository` and the in-memory fake (`src/testing/InMemoryUiPartRepository.ts`). `UsageIndex` (`src/application/`) knows who uses what: an app's themes, datasets, persona models, logic modules and the components in its nodes, a module's `needs`, a dataset's model and the components in a component's tree, plus each app's `start` screen. `IndexedUiPartRepository` builds it from the stored parts at the first call and keeps it in step with every change; `deleteRule` refuses to delete a part while anything uses it, or a screen that is its app's `start`, and names the users. `WritePart` (`src/application/use-cases/`) checks a part with the reader of its kind and refuses it with its own errors, writes it with `expectedRevision` (or creates it on a first write), then checks every app that reaches it and returns the ones it breaks as warnings (at most 20, with `moreApps`); a model write also names the dataset records that no longer fit. `ValidatePartApp` checks one app assembled with everything it reaches, each error naming its part.

`RenamePart` (`src/application/use-cases/`) renames a part and rewrites every part that names it, all together: theme lists, bindings' `dataset` and `model`, `uses.logic` keys (in their place), `needs` models, datasets' models and the composed names in nodes. It checks the new name as a slug that is not taken, keeps the part's id (so instances and persona data stay where they are) and gives the renamed part and each rewritten one the next revision; it reads again and retries when a part it rewrites moved meanwhile. `UiPartRepository.rename` takes those new bodies as `rewrites`. When it writes more than one part file, `FilePartRepository` first writes `rename.pending.json` (every part file with its new content), then the part files and `names.json`, and removes the journal last; a rename of a part that nothing names writes that part and `names.json` only. A journal that is still there was stopped halfway: `FilePartRepository.recover` (run by `startServer` before anything reads a part, and before the first call reads the names) writes the files that differ from it, removes it and rebuilds `names.json`; running it again changes nothing. Renaming a screen (`kind: "screens"`) is a write of its app with the app's revision: the key in `screens` in its place, `start` and every `navigate` to it.

A dataset part is `{ model, records }`, the records an ordered map. `WriteData` changes them with record operations whose paths are relative to `records` (`p1`, `p1.price`): `add` (a new key, `r` and a new id, so it is never integer-like; the result lists the keys it gave), and the document operations `set`, `merge`, `remove` and `move`. It checks every record the write touches against the dataset's model (`checkRecord`, errors at `$.records.{key}` naming the field) and writes nothing when one is invalid; records it leaves alone are not checked. `expectedRevision` is optional: without it the operations are applied to the newest records, again when another write got in first, so writes to different records do not conflict. Every committed write raises the dataset's revision by one. `QueryData` filters, sorts and windows a dataset's records with `queryRecords` of `@punyts/stateui-app/core`, the evaluator of the logic `query` command, and returns the window with the `total` that matched.

What a person does in an owner app is its instance, kept apart from the definition. `UiInstanceRepository` (`src/application/ports/`) stores the default persona's instance of each app as a diff over the definition (`diffInstance` of `@punyts/stateui-app/core`), and the records of each persona binding (`uses.data.{binding}` with `scope: "persona"`, which has no part). `FileUiInstanceRepository` keeps them by app id, so a rename of the app keeps them:

```text
data/personas/default/apps/<ownerId>/<appId>.json    the diff (app, screens, route, theme, data); no file when nothing differs
data/personas/default/data/<appId>/<binding>.json    { model, records }; a capital in the name is ^ and its small letter
```

The owner id of the local server is `LOCAL_OWNER_ID` (`ownerId` of `createServices` overrides it). A missing file reads as the definition, and a file that cannot be read is ignored with a `problem` the caller reports, never thrown at the person. Nothing there writes a part, and a part write never touches an instance. `WritePersonaData` checks the records against the binding's model as a dataset part's are checked; `ResetInstance` removes the instance and the persona records.

A running instance has its own state-sync authority. `AppAuthorities` is keyed by sync namespace, `instances.<persona>.<ownerId>.<appId>` (`appNamespace`). An instance's state is the assembled view: `$.app` and `$.screens` sparse, `$.route`, and `$.data` by binding, holding a copy of each shared dataset and the persona's records, with the instance laid over it. Its logic is the assembled logic, the app's units plus its bound modules. `InstanceNamespaceStorage` keeps that state as the instance (the diff and the persona records), never the shared copies or `$.server`. It keeps no sync log, so a loaded instance's revision is the clock in milliseconds and a view from before a restart gets a snapshot. `AuthorityInstanceStates` assembles the app on every call and restarts the instance over a changed definition; a change of only the records of a shared dataset is not one (`definitionText`).

Instances that bind one shared dataset see each other's changes through `DatasetHub` (`src/infrastructure/sync/`), which each instance's authority is attached to when it starts:

- Before a change is applied, the records it touches are checked against the dataset's model, synchronously, with the model read once and again when it changes. A client change is refused in the authority's `onChange` handler; a write of the instance's logic or of a tool is refused by the data gate that `AppAuthorities` gives each `AppLogic` (`InstanceDataGate`), and the logic engine asks it as `LogicHost.guard`, so a `save-data` gets the reason as its `rejected` result. The reason is `SUI-MODEL-FIELD`'s message, naming the record key and the field.
- After a change is applied (`onApplied` for a client change, the gate's `applied` for a server write), each record it touched is written to the dataset part whole with `WriteData`, one write-through at a time per dataset. A change that leaves the records as the dataset has them writes nothing, so instances whose rules derive the same value settle. A committed write-through is applied to every other binding of the dataset with one `writeAll` each (`AppAuthorities.receiveInstance`, after which that instance's logic sees the change); a failed one puts the stored records back into the instance and is reported (`Shared data not written`).
- A write of the dataset part from elsewhere (a tool, a rename, a model change) raises its revision past the hub's, and what changed in the records is applied to every binding.
- Persona bindings are never attached. Fan-out writes are server writes, which fire no `onApplied`, so the hub never sees them again. `SetPartState` writes `$.app`, `$.screens.{screen}` and persona `$.data.{binding}` paths, and refuses content, `$.theme` and the other definition roots (`definition-path`), shared datasets (`shared-dataset`, naming `ui_data_write`) and `$.route` (use `navigate`).

The live view of an owner app has the same URL, `/apps/<appId>` with the app part's id. Its page shows the assembled app (`InstanceViews`: the shell, the screens, the themes, the bound data and modules) with the default persona's instance laid over it (the runtime's `load` takes it as `instance`), and its sync client talks to that instance's authority (`data-namespace` on the page). Besides `$.data` and `$.app`, the view syncs each screen's articulation (`$.screens`) and the route (`$.route`); a route moved in another view arrives as a `navigate` command. Every part change that succeeds (`IndexedUiPartRepository.onChange`) reaches the open views of the apps that show the part (`LiveViews.partChanged`): the page writes a change of the shell's nodes in place and loads a changed theme, locale, screen or component again in full. A changed definition also restarts the instance's authority, so the views reconnect and get its state. The revision a view of an owner app reports is counted by `InstanceViews`, one more each time the assembled document changes, from 1 at start. `BrowserPreview.open` takes a screen and params (`?screen=<name>&params=<json>` on the view URL) to open the app there instead of where its instance is.

### Converting the old apps

`stateui-mcp convert` turns each app folder that still has an `app.json` into owner parts, once. Stop the server first.

```sh
node dist/cli.js convert --data-dir ./data --dry-run   # print the report, change nothing
node dist/cli.js convert --data-dir ./data             # convert
node dist/cli.js convert --data-dir ./data --purge     # later: delete data/.converted/
```

For each app, `convertDataDir` (`src/config/`) runs `splitDocument` of `@punyts/stateui-app/core` on the document, with the live data of `state.json` in place of the document's (the articulation is dropped), and creates the parts: its themes, a dataset and an inferred model for each key of `data`, its components, then the app, whose part id is the old app id. Names that a stored part or an earlier app of the run has get another one, and the report lists them. The default persona's instance is cleared, then `app.json` and `state.json` move to `data/.converted/<appId>/`; `errors.json`, `files.json` and the uploaded bytes stay in `data/<appId>/`, so the app's files are still listed under the same id. An app the converter cannot split (a rule that switches a hidden tab strip, for one) keeps its files where they are and is listed with the reasons. The plan is made from the stored files alone, so a dry run prints the same report and writes nothing. A second run converts nothing new; when an earlier run created an app's parts and stopped before moving its files, the next run only moves them. The command exits 0 with a report, `Nothing to convert in <dir>.` when there is nothing, and 2 for an unknown option.

**Run it once after installing this version.** The old tools (`ui_app_create` without a shell, and the tools that read an app by `appId`) are gone and the server no longer reads `app.json`, so an app that is not converted is not reachable. The upgrade:

1. Stop the server.
2. `stateui-mcp convert --dry-run` and read the report: the parts each app becomes, the names that changed and the apps that cannot be converted, with the reasons.
3. `stateui-mcp convert`.
4. Start the server and check the apps; `.converted/` still holds the old files.
5. `stateui-mcp convert --purge`.

An app that is not converted keeps its folder; fix what the report names in that app (with the previous release) or rebuild it from parts. The `--statenet` option and Persisted apps (`sync: "persisted"`) are gone with the old store: their state lived in the statenet under `apps.<appId>`, which this version does not read, so convert such an app from its `app.json` (its `$.data` snapshot is read from `state.json`, which a statenet-backed app does not have) or rebuild it.

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

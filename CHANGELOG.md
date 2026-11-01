# Changelog

## Unreleased

- Fix: `ui_state_set` of a new key (a new record, a new object under `data`) reaches the open views. The host wrote the leaves of the new value, which the store refuses without their parent, and the next snapshot of the view then dropped the key from the stored state. A new key is now written whole.

## 0.1.0

- First version: a standalone MCP server for building StateUI apps, ported from the `ui-builder` bounded context of AI Minion for one local user (no workspaces, users, approval policy or Postgres).
- The 16 `ui-builder` tools with the same names, arguments, results and error codes: `ui_components_list`, `ui_component_get`, `ui_icons_list`, `ui_tokens_list`, `ui_app_create`, `ui_app_list`, `ui_app_get`, `ui_validate`, `ui_outline`, `ui_state_get`, `ui_app_write`, `ui_state_set`, `ui_preview`, `ui_command`, `ui_file_read` and `ui_app_delete`. `ui_app_list` has no `ownerId`.
- New tools: `ui_screenshot` (PNG image of the page or of one node, with viewport size and theme mode), `ui_interact` (click, fill, press, hover and select by node state path) and `ui_events_read` (the `emit` events the views raised, with a cursor, at most 500 per app).
- `ui_preview` opens a headless Chromium page of the app and returns `{ appId, revision, url, rendered, errors }`; `ui_state_get` reads the state live from an open view (`source: "live"`) and falls back to the stored snapshot; `ui_command` is delivered to every open view, the headless page included.
- The working-loop guidance of `ui-builder` is in the server `instructions` and in the descriptions of `ui_components_list` and `ui_app_create`.
- Storage as one folder of JSON files per app under `--data-dir` (default `./data`), written atomically, one writer at a time per app, with the key order of `children` and keyed data maps kept.
- Transports: streamable HTTP with sessions at `/mcp` (`--port`, default 4100, `--host`, default `127.0.0.1`) and stdio (`--stdio`; the HTTP server still listens and all logs go to stderr).
- Browser endpoint: `GET /` lists the apps; `GET /apps/:appId` runs an app with the content-hashed StateUI runtime bundle in a sandboxed iframe and follows writes, state sets, commands and theme or locale switches over server-sent events; uploads from a `fileField` go to `POST /apps/:appId/files` (10 MiB, the ui-builder type rules). The pages have a strict Content-Security-Policy and the `Host` and `Origin` headers are checked.

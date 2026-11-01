import type { UiAppSummary } from '../../application/ports/UiAppRepository.js';

/** Everything that comes from an app (its name) is escaped before it reaches a page */
export function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The stylesheet of both pages. A separate file, because the policy forbids inline styles */
export const PAGE_CSS = `html, body { margin: 0; height: 100%; font-family: system-ui, sans-serif; }
body.list { padding: 2rem; max-width: 52rem; margin: 0 auto; height: auto; }
body.list h1 { font-size: 1.4rem; }
body.list table { border-collapse: collapse; width: 100%; }
body.list th, body.list td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #ddd; }
body.list .muted { color: #666; }
body.view { display: flex; flex-direction: column; }
body.view iframe { border: 0; width: 100%; flex: 1; display: block; }
body.view[data-status="loading"]::after { content: "Loading..."; position: fixed; top: 0.5rem; right: 0.75rem; font-size: 0.8rem; color: #666; }
body.view[data-status="failed"]::after { content: attr(data-note); position: fixed; top: 0.5rem; left: 0.75rem; font-size: 0.9rem; color: #b00020; }
`;

/** `GET /`: the apps with a link to each live view */
export function indexPage(apps: readonly UiAppSummary[]): string {
    const rows = apps
        .map(
            (app) =>
                `<tr><td><a href="/apps/${escapeHtml(app.id)}">${escapeHtml(app.name)}</a></td><td>${app.revision}</td><td>${escapeHtml(app.updatedAt.toISOString())}</td></tr>`
        )
        .join('\n');
    return [
        '<!doctype html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>StateUI apps</title>',
        '<link rel="stylesheet" href="/assets/page.css">',
        '</head>',
        '<body class="list">',
        '<h1>StateUI apps</h1>',
        apps.length === 0
            ? '<p class="muted">No apps yet. An agent creates them through the MCP tools.</p>'
            : `<table><thead><tr><th>Name</th><th>Revision</th><th>Updated</th></tr></thead><tbody>\n${rows}\n</tbody></table>`,
        '</body>',
        '</html>',
        ''
    ].join('\n');
}

export interface AppPageOptions {
    readonly appId: string;
    readonly name: string;
    readonly runtimeUrl: string;
    /** `headless` for the page of Playwright, `browser` for a person */
    readonly viewKind: 'browser' | 'headless';
}

/** `GET /apps/:appId`: a shell with no inline script; the host script reads these attributes and builds the frame */
export function appPage(options: AppPageOptions): string {
    return [
        '<!doctype html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        `<title>${escapeHtml(options.name)}</title>`,
        '<link rel="stylesheet" href="/assets/page.css">',
        '</head>',
        `<body class="view" data-app-id="${escapeHtml(options.appId)}" data-runtime-url="${escapeHtml(options.runtimeUrl)}" data-view-kind="${options.viewKind}" data-status="loading">`,
        '<script type="module" src="/assets/host.js"></script>',
        '</body>',
        '</html>',
        ''
    ].join('\n');
}

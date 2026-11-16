import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import { stateuiView } from '../dist/vite.js';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;

/**
 * The view page of stateui-mcp: locally the dev server (`npm run view`, port 5180, the runtime frame on 5181); for a
 * CDN `npm run view:build` writes dist/view/. Set where things are with:
 * - STATEUI_VIEW_PORT, STATEUI_VIEW_RUNTIME_PORT: the dev server's ports
 * - STATEUI_VIEW_BASE: the base path or URL the built files are served from (Vite's `base`), such as https://cdn.example.com/stateui/
 * - STATEUI_VIEW_RUNTIME_URL: where the pages load the runtime frame from, such as https://runtime.example.com/runtime/runtime.html
 *   (`{host}` is the page's host name); keep it on another origin than the pages
 * - VITE_STATENET_URL: the statenet the pages connect to (default ws://<page host>:4200/sync; `?statenet=` overrides it)
 */
export default defineConfig({
    root: here,
    base: env.STATEUI_VIEW_BASE ?? '/',
    envDir: here,
    server: {
        host: '127.0.0.1',
        port: Number(env.STATEUI_VIEW_PORT ?? 5180),
        strictPort: true,
        // The page imports the host script from src/ and the @punyts libraries linked from the workspace
        fs: { allow: [searchForWorkspaceRoot(here), resolve(here, '..')] }
    },
    build: { outDir: resolve(here, '../dist/view'), emptyOutDir: true, target: 'es2022' },
    plugins: [
        stateuiView({
            ...(env.STATEUI_VIEW_RUNTIME_PORT !== undefined && { runtimePort: Number(env.STATEUI_VIEW_RUNTIME_PORT) }),
            ...(env.STATEUI_VIEW_RUNTIME_URL !== undefined && { runtimeUrl: env.STATEUI_VIEW_RUNTIME_URL })
        })
    ]
});

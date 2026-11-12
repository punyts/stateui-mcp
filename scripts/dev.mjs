// `npm run dev`: what the live views need while an MCP client runs `stateui-mcp` on stdio. It runs the statenet
// (ws://127.0.0.1:4200/sync, its data in ./statenet-data) and the Vite dev server of view/ (http://127.0.0.1:5180/, the
// runtime frame on 5181) in this one process, so stopping it, however it is stopped, stops both.
// STATENET_PORT and STATEUI_VIEW_PORT move them.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addListener, setCategories } from '@punyts/core';
import { startStatenet } from '@punyts/statenet';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const viewPort = Number(process.env.STATEUI_VIEW_PORT ?? 5180);

setCategories(['statenet', 'warning', 'error']);
addListener((_timestamp, category, message) => process.stderr.write(`[${category}] ${message}\n`));

const statenet = await startStatenet({
    dataDir: resolve(root, 'statenet-data'),
    port: Number(process.env.STATENET_PORT ?? 4200),
    allowedOrigins: [`http://127.0.0.1:${viewPort}`, `http://localhost:${viewPort}`]
});
const vite = await createServer({ configFile: resolve(root, 'view/vite.config.ts'), server: { port: viewPort } });
await vite.listen();
vite.printUrls();
process.stderr.write(`statenet: ${statenet.url}\n`);

let stopping = false;
const stop = () => {
    if (stopping) return;
    stopping = true;
    void Promise.allSettled([vite.close(), statenet.close()]).then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

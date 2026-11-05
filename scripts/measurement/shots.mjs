// Screenshots of one finished build: node scripts/measurement/shots.mjs <phase> <request> <n> [port]
// Every screen of every app part, full page at 1280 px and at 390 px, into .measurements/<phase>/<request>-<n>/shots/
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runDir, serverArgs } from './common.mjs';

const [phase, request, n, port = '4300'] = process.argv.slice(2);
if (!phase || !request || !n) throw new Error('usage: shots.mjs <phase> <request> <n> [port]');
const run = runDir(phase, request, n);
const data = join(run, 'data');

const client = new Client({ name: 'measurement-shots', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: serverArgs(port, data), stderr: 'ignore' }));
const text = (r) =>
    r.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
const out = join(run, 'shots');
mkdirSync(out, { recursive: true });
const report = [];

async function shoot(target, file, extra = {}) {
    for (const width of [1280, 390]) {
        const r = await client.callTool({ name: 'ui_screenshot', arguments: { ...target, ...extra, width, fullPage: true } });
        const image = r.content.find((c) => c.type === 'image');
        if (!image) report.push({ ...target, ...extra, width, error: text(r).slice(0, 200) });
        else writeFileSync(join(out, `${file}.${width}.png`), Buffer.from(image.data, 'base64'));
    }
}

try {
    const parts = (kind) =>
        existsSync(join(data, kind)) ? readdirSync(join(data, kind)).map((f) => JSON.parse(readFileSync(join(data, kind, f), 'utf8'))) : [];
    const firstIds = parts('data').flatMap((d) => Object.keys(d.body?.records ?? {}));
    for (const { name, body } of parts('apps')) {
        const screens = Object.entries(body.screens ?? {});
        report.push({ app: name, start: body.start, screens: screens.map(([s, def]) => ({ s, params: Object.keys(def.params ?? {}) })) });
        for (const [screen, def] of screens) {
            // A screen with required params gets the first record id found in the data parts, else is skipped with a note
            const params = {};
            for (const [p, spec] of Object.entries(def.params ?? {})) if (spec.required) params[p] = firstIds[0] ?? null;
            if (Object.values(params).includes(null)) {
                report.push({ app: name, screen, skipped: 'required params ' + JSON.stringify(Object.keys(params)) });
                continue;
            }
            await shoot({ app: name }, `${name}.${screen}`, { screen, ...(Object.keys(params).length && { params }) });
        }
    }
    // Apps of the single-document store: one folder per app with app.json
    for (const appId of readdirSync(data).filter((d) => existsSync(join(data, d, 'app.json')))) {
        const doc = JSON.parse(readFileSync(join(data, appId, 'app.json'), 'utf8'));
        report.push({ appId, name: doc.name, store: 'single-document' });
        await shoot({ appId }, (doc.name ?? appId).replace(/[^a-z0-9]+/gi, '-').toLowerCase());
    }
} finally {
    await client.close();
}
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));

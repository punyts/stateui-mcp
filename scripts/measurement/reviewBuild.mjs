// Checklist review of one finished build: node scripts/measurement/reviewBuild.mjs <phase> <request> <n> [port]
// A fresh headless claude session with read, screenshot and interact tools only judges each checklist item of
// test/measurement/requests.md against the build's data, and writes .measurements/<phase>/<request>-<n>/review.json
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, createWriteStream, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE, readRequest, runDir, serverArgs } from './common.mjs';

const MODEL = process.env.REVIEW_MODEL ?? 'claude-sonnet-5-5';
const TOOLS = ['ui_list', 'ui_get', 'ui_app_list', 'ui_app_get', 'ui_tree', 'ui_outline', 'ui_validate', 'ui_preview', 'ui_screenshot', 'ui_interact', 'ui_state_get', 'ui_state_reset', 'ui_events_read', 'ui_component_get', 'ui_data_query'];

// Tools that change a definition or set state by hand: removed, so the review cannot fix what it judges
const DENY = ['ui_app_configure', 'ui_app_create', 'ui_app_delete', 'ui_app_write', 'ui_call_answer', 'ui_command', 'ui_composed_write', 'ui_data_write', 'ui_delete', 'ui_locale_write', 'ui_logic_write', 'ui_model_write', 'ui_nodes_write', 'ui_pattern_write', 'ui_rename', 'ui_screen_create', 'ui_state_set', 'ui_theme_create', 'ui_theme_write'];

const [phase, request, n, port = '4300'] = process.argv.slice(2);
if (!phase || !request || !n) throw new Error('usage: reviewBuild.mjs <phase> <request> <n> [port]');
const run = runDir(phase, request, n);
const { prompt, checklist, rules } = readRequest(request);

// The apps the build made: app parts by name, single-document apps by id
const data = join(run, 'data');
const parts = existsSync(join(data, 'apps')) ? readdirSync(join(data, 'apps')).map((f) => JSON.parse(readFileSync(join(data, 'apps', f), 'utf8')).name) : [];
const old = readdirSync(data)
    .filter((d) => existsSync(join(data, d, 'app.json')))
    .map((d) => `${d} (${JSON.parse(readFileSync(join(data, d, 'app.json'), 'utf8')).name ?? 'unnamed'})`);

const task = `You are reviewing an app another agent built with the StateUI tools. You judge it; you do not change it.

The agent was asked:
> ${prompt}

Judge the finished app against this checklist:
${checklist}

How to judge:
${rules}
- Check every item yourself in the running app. Take ui_screenshot with fullPage: true at width 1280 and again at width 390. Use ui_interact (click, fill, select) to try every item that does something, then ui_screenshot or ui_state_get to see the result. Visit every screen (ui_screenshot takes screen and params).
- Judge only what you can see or make happen. Something in the data but not shown, or a control that does nothing, is not met.
- The build left these apps: app parts ${JSON.stringify(parts)} (pass "app"), old-store apps ${JSON.stringify(old)} (pass "appId"). Some may be scratch apps; judge the one that answers the request.
- When you are done, call ui_state_reset on the app you judged.

End with exactly one fenced json block, nothing after it:
\`\`\`json
{ "app": "<name or appId judged>", "items": [ { "n": 1, "met": true, "evidence": "<one sentence>" } ], "met": <count>, "of": <total> }
\`\`\``;

const review = join(run, 'review');
mkdirSync(review, { recursive: true });
const mcpConfig = join(review, 'mcp.json');
writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { stateui: { type: 'stdio', command: process.execPath, args: serverArgs(port, data) } } }, null, 2));
const args = [
    '-p',
    '--model',
    MODEL,
    '--mcp-config',
    mcpConfig,
    '--strict-mcp-config',
    '--tools',
    '',
    '--allowedTools',
    ...TOOLS.map((t) => `mcp__stateui__${t}`),
    '--disallowedTools',
    ...DENY.map((t) => `mcp__stateui__${t}`),
    '--setting-sources',
    'user',
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose'
];
const child = spawn(CLAUDE, args, { cwd: review, stdio: ['pipe', 'pipe', 'pipe'] });
const transcript = join(review, 'transcript.jsonl');
child.stdout.pipe(createWriteStream(transcript));
child.stderr.pipe(createWriteStream(join(review, 'stderr.log')));
child.stdin.end(task);
child.on('close', (code) => {
    const lines = readFileSync(transcript, 'utf8')
        .trim()
        .split('\n')
        .map((l) => {
            try {
                return JSON.parse(l);
            } catch {
                return {};
            }
        });
    const result = lines.find((l) => l.type === 'result');
    const block = String(result?.result ?? '').match(/```json\s*([\s\S]*?)```/);
    let verdict;
    try {
        verdict = JSON.parse(block[1]);
    } catch {
        verdict = { error: 'no verdict', exitCode: code };
    }
    const out = { phase, request, n: Number(n), reviewer: MODEL, cost: result?.total_cost_usd, ...verdict };
    writeFileSync(join(run, 'review.json'), JSON.stringify(out, null, 2));
    console.log(JSON.stringify({ run: `${request}-${n}`, app: out.app, met: out.met, of: out.of, error: out.error }));
});

// One measurement build: node scripts/measurement/runBuild.mjs <phase> <store|finance|booking|drawing> <n> [port]
// A fresh headless claude session gets the request's prompt word for word, with this library's server as its
// only tools, in an empty folder (no CLAUDE.md, project settings or memory). Output: .measurements/<phase>/<request>-<n>/
// Builds can run side by side on ports 10 apart (4300, 4310, 4320); each server also takes the next port for its runtime.
// The server instructions tell the agent to show the plan of a large app and wait for the user's OK. When the first turn
// ends with no successful write, the script answers once with APPROVAL, as a user who reads the plan and agrees would;
// run.json records it as approvals.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { CLAUDE, LIB, readRequest, runDir, serverArgs } from './common.mjs';

const MODEL = process.env.BUILD_MODEL ?? 'claude-opus-5-5';
const APPROVAL = 'The plan looks good. Go ahead and build it.';
// The tools that write a definition: a successful call of one means the agent has started building
const WRITE_TOOLS = new Set(['ui_app_create', 'ui_app_write', 'ui_app_configure', 'ui_screen_create', 'ui_nodes_write', 'ui_locale_write', 'ui_theme_create', 'ui_theme_write', 'ui_model_write', 'ui_data_write', 'ui_logic_write', 'ui_composed_write']);
const [phase, request, n, port = '4300'] = process.argv.slice(2);
if (!phase || !request || !n) throw new Error('usage: runBuild.mjs <phase> <store|finance|booking|drawing> <n> [port]');
const { prompt } = readRequest(request);

const run = runDir(phase, request, n);
if (existsSync(run)) throw new Error(`${run} exists; a run needs a fresh folder`);
const work = join(run, 'work');
mkdirSync(work, { recursive: true });

const mcpConfig = join(run, 'mcp.json');
const server = { type: 'stdio', command: process.execPath, args: serverArgs(port, join(run, 'data'), join(run, 'calls.jsonl')) };
writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { stateui: server } }, null, 2));

const commit = execFileSync('git', ['-C', LIB, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
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
    'mcp__stateui',
    '--setting-sources',
    'user',
    '--no-session-persistence',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose'
];
const started = Date.now();
const child = spawn(CLAUDE, args, { cwd: work, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdout.pipe(createWriteStream(join(run, 'transcript.jsonl')));
child.stderr.pipe(createWriteStream(join(run, 'stderr.log')));
const send = (text) => child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
const wrote = () => {
    const log = join(run, 'calls.jsonl');
    if (!existsSync(log)) return false;
    return readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .some((line) => {
            const entry = JSON.parse(line);
            return entry.ok === true && WRITE_TOOLS.has(entry.tool);
        });
};
let approvals = 0;
createInterface({ input: child.stdout }).on('line', (line) => {
    let event;
    try {
        event = JSON.parse(line);
    } catch {
        return;
    }
    if (event.type !== 'result') return;
    if (approvals === 0 && !wrote()) {
        approvals = 1;
        send(APPROVAL);
    } else child.stdin.end();
});
send(prompt);
child.on('close', (code) => {
    const meta = { phase, request, n: Number(n), model: MODEL, commit, approvals, exitCode: code, minutes: +((Date.now() - started) / 60000).toFixed(1) };
    writeFileSync(join(run, 'run.json'), JSON.stringify(meta, null, 2));
    console.log(JSON.stringify(meta));
    process.exit(code ?? 1);
});

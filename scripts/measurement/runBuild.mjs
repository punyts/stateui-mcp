// One measurement build: node scripts/measurement/runBuild.mjs <phase> <store|finance|booking> <n> [port]
// A fresh headless claude session gets the request's prompt word for word, with this library's server as its
// only tools, in an empty folder (no CLAUDE.md, project settings or memory). Output: .measurements/<phase>/<request>-<n>/
// Builds can run side by side on ports 10 apart (4300, 4310, 4320); each server also takes the next port for its runtime.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, createWriteStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE, LIB, readRequest, runDir, serverArgs } from './common.mjs';

const MODEL = process.env.BUILD_MODEL ?? 'claude-opus-5-5';
const [phase, request, n, port = '4300'] = process.argv.slice(2);
if (!phase || !request || !n) throw new Error('usage: runBuild.mjs <phase> <store|finance|booking> <n> [port]');
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
    '--output-format',
    'stream-json',
    '--verbose'
];
const started = Date.now();
const child = spawn(CLAUDE, args, { cwd: work, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdout.pipe(createWriteStream(join(run, 'transcript.jsonl')));
child.stderr.pipe(createWriteStream(join(run, 'stderr.log')));
child.stdin.end(prompt);
child.on('close', (code) => {
    const meta = { phase, request, n: Number(n), model: MODEL, commit, exitCode: code, minutes: +((Date.now() - started) / 60000).toFixed(1) };
    writeFileSync(join(run, 'run.json'), JSON.stringify(meta, null, 2));
    console.log(JSON.stringify(meta));
    process.exit(code ?? 1);
});

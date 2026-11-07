// Shared pieces of the measurement scripts: where the library is, how to start claude, and the requests
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIB = fileURLToPath(new URL('../..', import.meta.url));

// claude.exe of the global npm install on Windows (a spawn without a shell cannot run claude.cmd); claude elsewhere
export const CLAUDE =
    process.env.CLAUDE_BIN ??
    (process.platform === 'win32' ? join(process.env.APPDATA ?? '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe') : 'claude');

export const HEADINGS = { store: 'Store', finance: 'Finance dashboard', booking: 'Booking app', drawing: 'Floor plan' };

export function runDir(phase, request, n) {
    return join(LIB, '.measurements', phase, `${request}-${n}`);
}

/** The prompt, checklist and judging rules of one request in test/measurement/requests.md */
export function readRequest(request) {
    if (!HEADINGS[request]) throw new Error(`unknown request "${request}"; use ${Object.keys(HEADINGS).join(', ')}`);
    const md = readFileSync(join(LIB, 'test/measurement/requests.md'), 'utf8').split('\r\n').join('\n');
    const section = md.split(`## ${HEADINGS[request]}\n`)[1].split('\n## ')[0];
    const prompt = section
        .split('\n')
        .find((line) => line.startsWith('> '))
        .slice(2)
        .trim();
    const checklist = section.split('**Checklist:**')[1].trim();
    const rules = md.split('## Store')[0].split('How to run one build:')[0].trim().split('\n').slice(2).join('\n').trim();
    return { prompt, checklist, rules };
}

/** Arguments that start this library's server over stdio on its own ports and data folder */
export function serverArgs(port, dataDir, toolLog) {
    return [
        join(LIB, 'dist/cli.js'),
        '--stdio',
        '--port',
        String(port),
        '--runtime-port',
        String(Number(port) + 1),
        '--data-dir',
        dataDir,
        ...(toolLog ? ['--tool-log', toolLog] : [])
    ];
}

import { resolve } from 'node:path';
import { DEFAULT_STATENET_URL, DEFAULT_VIEW_URL } from './startServer.js';

export interface CliOptions {
    readonly dataDir: string;
    /** The statenet's WebSocket URL */
    readonly statenet: string;
    /** The view page's URL (the Vite dev server, or a CDN) */
    readonly viewUrl: string;
    /** A file holding the key that encrypts `$.server` */
    readonly secretKeyFile: string | undefined;
    /** The key itself, from the environment only (hex or base64) */
    readonly secretKey: string | undefined;
    /** A file that gets one JSON line per tool call (the tool, the outcome and sizes, never arguments or bodies) */
    readonly toolLog: string | undefined;
    /** Install the component showcase app on a data directory that holds no parts */
    readonly showcase: boolean;
    readonly help: boolean;
}

export const HELP_TEXT = `stateui-mcp: an MCP server for building StateUI apps, with a live browser view of each app

Usage: stateui-mcp [options]
       stateui-mcp convert [--data-dir <dir>] [--dry-run] [--purge]   (stateui-mcp convert --help)

It speaks MCP on stdin and stdout and listens on no port. The apps' live state goes to a statenet
(npx statenet), and the view pages that show it are static files (the Vite dev server of view/
locally, a CDN in production) that read the state from that statenet.

Options:
  --data-dir <dir>     Where the parts, instances and app files are stored
                       (env STATEUI_MCP_DATA_DIR, default ./data)
  --statenet <url>     The statenet's WebSocket (env STATEUI_MCP_STATENET, default ${DEFAULT_STATENET_URL})
  --view-url <url>     The view page, which ui_preview names and the headless browser opens
                       (env STATEUI_MCP_VIEW_URL, default ${DEFAULT_VIEW_URL})
  --stdio              Accepted for older client configurations: stdio is the only transport
  --secret-key-file <file>
                       The key that encrypts $.server at rest: 32 raw bytes, 64 hex
                       characters or base64 (env STATEUI_MCP_SECRET_KEY_FILE, or the key
                       itself in STATEUI_MCP_SECRET_KEY)
  --tool-log <file>    Append one JSON line per tool call to this file: the tool, whether
                       it failed, the error code, request and response sizes and the app.
                       Never arguments or response bodies (env STATEUI_MCP_TOOL_LOG)
  --no-showcase        Do not install the component showcase app on a new data directory
                       (env STATEUI_MCP_SHOWCASE=off). It is installed only when the data
                       directory holds no parts at all, and never again after that
  -h, --help           Show this help
`;

export const CONVERT_HELP_TEXT = `stateui-mcp convert: turns the apps of the old single-document store into owner parts, once

Usage: stateui-mcp convert [options]

Each app folder of the data directory with an app.json is split into parts (the app, its theme,
its datasets with their models, its components); the app keeps its id. Its app.json and state.json
move to <dir>/.converted/<appId>/; errors.json and the uploaded files stay. An app that cannot be
converted keeps its files and is listed with the reasons. Running it again converts nothing new.
Stop the server first.

Options:
  --data-dir <dir>     The data directory (env STATEUI_MCP_DATA_DIR, default ./data)
  --dry-run            Print the report and change nothing
  --purge              Delete <dir>/.converted/ afterwards
  -h, --help           Show this help
`;

export interface ConvertCliOptions {
    readonly dataDir: string;
    readonly dryRun: boolean;
    readonly purge: boolean;
    readonly help: boolean;
}

export class UsageError extends Error {}

/** Reads the options of `stateui-mcp convert` (the arguments after `convert`) and the environment */
export function parseConvertOptions(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): ConvertCliOptions {
    let dataDir = env['STATEUI_MCP_DATA_DIR'] ?? './data';
    let dryRun = false;
    let purge = false;
    let help = false;
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index] as string;
        if (argument.startsWith('--data-dir=')) {
            dataDir = argument.slice('--data-dir='.length);
            continue;
        }
        switch (argument) {
            case '--data-dir': {
                const next = argv[++index];
                if (next === undefined) throw new UsageError('--data-dir needs a value');
                dataDir = next;
                break;
            }
            case '--dry-run':
                dryRun = true;
                break;
            case '--purge':
                purge = true;
                break;
            case '-h':
            case '--help':
                help = true;
                break;
            default:
                throw new UsageError(`Unknown option of convert: ${argument}`);
        }
    }
    return { dataDir: resolve(dataDir), dryRun, purge, help };
}

function parseUrl(text: string, protocols: readonly string[], what: string): string {
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        throw new UsageError(`Invalid ${what}: ${text}`);
    }
    if (!protocols.includes(url.protocol)) throw new UsageError(`Invalid ${what}: ${text} (${protocols.map((protocol) => protocol.replace(':', '')).join(' or ')})`);
    return url.href;
}

/** The options of the web server this server no longer has, with what replaced them */
const REMOVED_OPTIONS: Readonly<Record<string, string>> = Object.freeze({
    '--port': 'the server listens on no port: MCP is on stdio and the state goes to the statenet (--statenet)',
    '--runtime-port': 'the view server (view/, its Vite plugin) serves the runtime frame now',
    '--host': 'the server listens on no address: MCP is on stdio',
    '--runtime-dir': 'the view server (view/, its Vite plugin) serves the runtime bundle now'
});

/** The values of STATEUI_MCP_SHOWCASE that turn the showcase off */
const SHOWCASE_OFF: readonly string[] = Object.freeze(['off', 'false', 'no', '0']);

/** Reads the command line and the environment. A flag wins over its environment variable */
export function parseOptions(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): CliOptions {
    let dataDir = env['STATEUI_MCP_DATA_DIR'] ?? './data';
    let statenet = parseUrl(env['STATEUI_MCP_STATENET'] ?? DEFAULT_STATENET_URL, ['ws:', 'wss:'], 'statenet URL');
    let viewUrl = parseUrl(env['STATEUI_MCP_VIEW_URL'] ?? DEFAULT_VIEW_URL, ['http:', 'https:'], 'view URL');
    let secretKeyFile = env['STATEUI_MCP_SECRET_KEY_FILE'];
    let toolLog = env['STATEUI_MCP_TOOL_LOG'];
    let showcase = !SHOWCASE_OFF.includes((env['STATEUI_MCP_SHOWCASE'] ?? '').trim().toLowerCase());
    let help = false;

    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index] as string;
        const [flag, inline] = argument.startsWith('--') && argument.includes('=') ? [argument.slice(0, argument.indexOf('=')), argument.slice(argument.indexOf('=') + 1)] : [argument, undefined];
        const value = (): string => {
            if (inline !== undefined) return inline;
            const next = argv[++index];
            if (next === undefined) throw new UsageError(`${flag} needs a value`);
            return next;
        };
        switch (flag) {
            case '--data-dir':
                dataDir = value();
                break;
            case '--statenet':
                statenet = parseUrl(value(), ['ws:', 'wss:'], 'statenet URL');
                break;
            case '--view-url':
                viewUrl = parseUrl(value(), ['http:', 'https:'], 'view URL');
                break;
            case '--secret-key-file':
                secretKeyFile = value();
                break;
            case '--tool-log':
                toolLog = value();
                break;
            case '--stdio':
                break;
            case '--no-showcase':
                showcase = false;
                break;
            case '-h':
            case '--help':
                help = true;
                break;
            default:
                if (REMOVED_OPTIONS[flag] !== undefined) throw new UsageError(`${flag} is gone: ${REMOVED_OPTIONS[flag]}`);
                throw new UsageError(`Unknown option: ${argument}`);
        }
    }
    return {
        dataDir: resolve(dataDir),
        statenet,
        viewUrl,
        secretKeyFile: secretKeyFile === undefined || secretKeyFile === '' ? undefined : resolve(secretKeyFile),
        secretKey: env['STATEUI_MCP_SECRET_KEY'],
        toolLog: toolLog === undefined || toolLog === '' ? undefined : resolve(toolLog),
        showcase,
        help
    };
}

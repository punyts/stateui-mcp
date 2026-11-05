import { resolve } from 'node:path';

export interface CliOptions {
    readonly dataDir: string;
    readonly host: string;
    readonly port: number;
    /** `undefined`: the next port after `port` */
    readonly runtimePort: number | undefined;
    readonly stdio: boolean;
    readonly runtimeDir: string | undefined;
    /** A file holding the key that encrypts `$.server` */
    readonly secretKeyFile: string | undefined;
    /** The key itself, from the environment only (hex or base64) */
    readonly secretKey: string | undefined;
    /** A file that gets one JSON line per tool call (the tool, the outcome and sizes, never arguments or bodies) */
    readonly toolLog: string | undefined;
    readonly help: boolean;
}

export const HELP_TEXT = `stateui-mcp: an MCP server for building StateUI apps, with a live browser view of each app

Usage: stateui-mcp [options]
       stateui-mcp convert [--data-dir <dir>] [--dry-run] [--purge]   (stateui-mcp convert --help)

Options:
  --data-dir <dir>     Where the parts, instances and app files are stored
                       (env STATEUI_MCP_DATA_DIR, default ./data)
  --port <number>      Port of the HTTP server: /mcp and the browser view
                       (env STATEUI_MCP_PORT, default 4100)
  --runtime-port <n>   Port that serves the app frame, a second origin
                       (env STATEUI_MCP_RUNTIME_PORT, default: the next port, 4101)
  --host <address>     Address to bind (env STATEUI_MCP_HOST, default 127.0.0.1).
                       There is no authentication: bind a non-loopback address only on a network you trust
  --stdio              Speak MCP over stdin and stdout. The HTTP server still listens,
                       so the browser view works. Logs go to stderr only
  --runtime-dir <dir>  Folder of the built StateUI runtime bundle
                       (env STATEUI_MCP_RUNTIME_DIR, default: the one in @punyts/stateui-app)
  --secret-key-file <file>
                       The key that encrypts $.server at rest: 32 raw bytes, 64 hex
                       characters or base64 (env STATEUI_MCP_SECRET_KEY_FILE, or the key
                       itself in STATEUI_MCP_SECRET_KEY)
  --tool-log <file>    Append one JSON line per tool call to this file: the tool, whether
                       it failed, the error code, request and response sizes and the app.
                       Never arguments or response bodies (env STATEUI_MCP_TOOL_LOG)
  -h, --help           Show this help

Without --stdio the server speaks streamable HTTP at http://<host>:<port>/mcp.
Open http://<host>:<port>/ for the list of apps.
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

function parsePort(text: string): number {
    const port = Number(text);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`Invalid port: ${text}`);
    return port;
}

/** Reads the command line and the environment. A flag wins over its environment variable */
export function parseOptions(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): CliOptions {
    let dataDir = env['STATEUI_MCP_DATA_DIR'] ?? './data';
    let host = env['STATEUI_MCP_HOST'] ?? '127.0.0.1';
    let port = env['STATEUI_MCP_PORT'] !== undefined ? parsePort(env['STATEUI_MCP_PORT']) : 4100;
    let runtimePort = env['STATEUI_MCP_RUNTIME_PORT'] !== undefined ? parsePort(env['STATEUI_MCP_RUNTIME_PORT']) : undefined;
    let runtimeDir = env['STATEUI_MCP_RUNTIME_DIR'];
    let secretKeyFile = env['STATEUI_MCP_SECRET_KEY_FILE'];
    let toolLog = env['STATEUI_MCP_TOOL_LOG'];
    let stdio = false;
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
            case '--port':
                port = parsePort(value());
                break;
            case '--runtime-port':
                runtimePort = parsePort(value());
                break;
            case '--host':
                host = value();
                break;
            case '--runtime-dir':
                runtimeDir = value();
                break;
            case '--secret-key-file':
                secretKeyFile = value();
                break;
            case '--tool-log':
                toolLog = value();
                break;
            case '--stdio':
                stdio = true;
                break;
            case '-h':
            case '--help':
                help = true;
                break;
            default:
                throw new UsageError(`Unknown option: ${argument}`);
        }
    }
    return {
        dataDir: resolve(dataDir),
        host,
        port,
        runtimePort,
        stdio,
        runtimeDir: runtimeDir === undefined ? undefined : resolve(runtimeDir),
        secretKeyFile: secretKeyFile === undefined || secretKeyFile === '' ? undefined : resolve(secretKeyFile),
        secretKey: env['STATEUI_MCP_SECRET_KEY'],
        toolLog: toolLog === undefined || toolLog === '' ? undefined : resolve(toolLog),
        help
    };
}

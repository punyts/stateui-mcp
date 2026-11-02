import { resolve } from 'node:path';

export interface CliOptions {
    readonly dataDir: string;
    readonly host: string;
    readonly port: number;
    /** `undefined`: the next port after `port` */
    readonly runtimePort: number | undefined;
    readonly stdio: boolean;
    readonly runtimeDir: string | undefined;
    /** The statenet's WebSocket URL (`ws://127.0.0.1:4200/sync`); `undefined`: the state stays in the data folder */
    readonly statenet: string | undefined;
    /** A file holding the key that encrypts `$.server` */
    readonly secretKeyFile: string | undefined;
    /** The key itself, from the environment only (hex or base64) */
    readonly secretKey: string | undefined;
    readonly help: boolean;
}

export const HELP_TEXT = `stateui-mcp: an MCP server for building StateUI apps, with a live browser view of each app

Usage: stateui-mcp [options]

Options:
  --data-dir <dir>     Where the apps are stored, one folder per app
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
  --statenet <url>     Keep the app state in a statenet, such as ws://127.0.0.1:4200/sync
                       (env STATEUI_MCP_STATENET). Start the statenet with
                       --allow-origin http://<host>:<port> so Persisted apps can reach it
  --secret-key-file <file>
                       The key that encrypts $.server at rest: 32 raw bytes, 64 hex
                       characters or base64 (env STATEUI_MCP_SECRET_KEY_FILE, or the key
                       itself in STATEUI_MCP_SECRET_KEY)
  -h, --help           Show this help

Without --stdio the server speaks streamable HTTP at http://<host>:<port>/mcp.
Open http://<host>:<port>/ for the list of apps.
`;

export class UsageError extends Error {}

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
    let statenet = env['STATEUI_MCP_STATENET'];
    let secretKeyFile = env['STATEUI_MCP_SECRET_KEY_FILE'];
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
            case '--statenet':
                statenet = value();
                break;
            case '--secret-key-file':
                secretKeyFile = value();
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
    if (statenet !== undefined && statenet !== '' && !/^wss?:\/\//.test(statenet)) throw new UsageError(`The statenet URL must start with ws:// or wss://: ${statenet}`);
    return {
        dataDir: resolve(dataDir),
        host,
        port,
        runtimePort,
        stdio,
        runtimeDir: runtimeDir === undefined ? undefined : resolve(runtimeDir),
        statenet: statenet === '' ? undefined : statenet,
        secretKeyFile: secretKeyFile === undefined || secretKeyFile === '' ? undefined : resolve(secretKeyFile),
        secretKey: env['STATEUI_MCP_SECRET_KEY'],
        help
    };
}

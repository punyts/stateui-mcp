import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConvertOptions, parseOptions, UsageError } from './options.js';

describe('parseOptions', () => {
    it('should default to ./data, the local statenet and the local view server', () => {
        const options = parseOptions([], {});

        expect(options).toEqual({
            dataDir: resolve('./data'),
            statenet: 'ws://127.0.0.1:4200/sync',
            viewUrl: 'http://127.0.0.1:5180/',
            secretKeyFile: undefined,
            secretKey: undefined,
            toolLog: undefined,
            showcase: true,
            help: false
        });
    });

    it('should read the secret key from flags or the environment', () => {
        expect(parseOptions(['--secret-key-file', 'key.bin'], {}).secretKeyFile).toBe(resolve('key.bin'));
        expect(parseOptions([], { STATEUI_MCP_SECRET_KEY_FILE: 'env.bin', STATEUI_MCP_SECRET_KEY: 'abc' })).toMatchObject({ secretKeyFile: resolve('env.bin'), secretKey: 'abc' });
    });

    it('should read the tool log from the flag or the environment, the flag winning, as an absolute path', () => {
        expect(parseOptions(['--tool-log', 'calls.jsonl'], {}).toolLog).toBe(resolve('calls.jsonl'));
        expect(parseOptions([], { STATEUI_MCP_TOOL_LOG: 'env.jsonl' }).toolLog).toBe(resolve('env.jsonl'));
        expect(parseOptions(['--tool-log=flag.jsonl'], { STATEUI_MCP_TOOL_LOG: 'env.jsonl' }).toolLog).toBe(resolve('flag.jsonl'));
        expect(parseOptions([], { STATEUI_MCP_TOOL_LOG: '' }).toolLog).toBeUndefined();
    });

    it('should read the environment and let a flag win over it', () => {
        const options = parseOptions(['--statenet', 'ws://127.0.0.1:4300/sync', '--data-dir=other'], {
            STATEUI_MCP_STATENET: 'ws://127.0.0.1:4400/sync',
            STATEUI_MCP_DATA_DIR: 'env-dir',
            STATEUI_MCP_VIEW_URL: 'https://cdn.example.com/stateui/'
        });

        expect(options.statenet).toBe('ws://127.0.0.1:4300/sync');
        expect(options.dataDir).toBe(resolve('other'));
        expect(options.viewUrl).toBe('https://cdn.example.com/stateui/');
        expect(parseOptions(['--view-url=http://localhost:6000'], {}).viewUrl).toBe('http://localhost:6000/');
    });

    it('should refuse a statenet that is not a WebSocket and a view that is not http', () => {
        expect(() => parseOptions(['--statenet', 'http://127.0.0.1:4200/sync'], {})).toThrow('Invalid statenet URL');
        expect(() => parseOptions(['--view-url', 'ws://127.0.0.1:5180'], {})).toThrow('Invalid view URL');
        expect(() => parseOptions([], { STATEUI_MCP_STATENET: 'nonsense' })).toThrow('Invalid statenet URL');
    });

    it('should say what replaced the options of the web server it no longer has', () => {
        for (const flag of ['--port', '--runtime-port', '--host', '--runtime-dir']) expect(() => parseOptions([flag, '1'], {})).toThrow('is gone');
    });

    it('should turn the component showcase off with the flag or the environment', () => {
        expect(parseOptions(['--no-showcase'], {}).showcase).toBe(false);
        expect(parseOptions([], { STATEUI_MCP_SHOWCASE: 'off' }).showcase).toBe(false);
        expect(parseOptions([], { STATEUI_MCP_SHOWCASE: 'FALSE' }).showcase).toBe(false);
        expect(parseOptions([], { STATEUI_MCP_SHOWCASE: 'on' }).showcase).toBe(true);
        expect(parseOptions([], { STATEUI_MCP_SHOWCASE: '' }).showcase).toBe(true);
    });

    it('should take --stdio, the only transport, and turn on help', () => {
        expect(parseOptions(['--stdio'], {}).help).toBe(false);
        expect(parseOptions(['-h'], {}).help).toBe(true);
        expect(parseOptions(['--help'], {}).help).toBe(true);
    });

    it('should refuse an unknown option and a missing value', () => {
        expect(() => parseOptions(['--nope'], {})).toThrow(UsageError);
        expect(() => parseOptions(['--statenet'], {})).toThrow('needs a value');
    });
});

describe('parseConvertOptions', () => {
    it('should default to the data directory of the environment, or ./data, with no dry run and no purge', () => {
        // Act
        const plain = parseConvertOptions([], {});
        const fromEnv = parseConvertOptions([], { STATEUI_MCP_DATA_DIR: 'env-data' });

        // Assert
        expect(plain).toEqual({ dataDir: resolve('./data'), dryRun: false, purge: false, help: false });
        expect(fromEnv.dataDir).toBe(resolve('env-data'));
    });

    it('should read --data-dir in both forms, --dry-run, --purge and --help', () => {
        // Act
        const spaced = parseConvertOptions(['--data-dir', 'a', '--dry-run'], { STATEUI_MCP_DATA_DIR: 'env-data' });
        const joined = parseConvertOptions(['--data-dir=b', '--purge', '-h'], {});

        // Assert
        expect(spaced).toEqual({ dataDir: resolve('a'), dryRun: true, purge: false, help: false });
        expect(joined).toEqual({ dataDir: resolve('b'), dryRun: false, purge: true, help: true });
    });

    it('should refuse an unknown option and a --data-dir without a value', () => {
        expect(() => parseConvertOptions(['--port', '1'], {})).toThrow(UsageError);
        expect(() => parseConvertOptions(['--data-dir'], {})).toThrow('--data-dir needs a value');
    });
});

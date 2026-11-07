import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConvertOptions, parseOptions, UsageError } from './options.js';

describe('parseOptions', () => {
    it('should default to ./data, port 4100 and the loopback address', () => {
        const options = parseOptions([], {});

        expect(options).toEqual({
            dataDir: resolve('./data'),
            host: '127.0.0.1',
            port: 4100,
            runtimePort: undefined,
            stdio: false,
            runtimeDir: undefined,
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
        const options = parseOptions(['--port', '5000', '--data-dir=other'], { STATEUI_MCP_PORT: '4200', STATEUI_MCP_DATA_DIR: 'env-dir', STATEUI_MCP_HOST: '0.0.0.0' });

        expect(options.port).toBe(5000);
        expect(options.dataDir).toBe(resolve('other'));
        expect(options.host).toBe('0.0.0.0');
    });

    it('should read the runtime port from the flag or the environment', () => {
        expect(parseOptions(['--runtime-port', '5001'], { STATEUI_MCP_RUNTIME_PORT: '4300' }).runtimePort).toBe(5001);
        expect(parseOptions([], { STATEUI_MCP_RUNTIME_PORT: '4300' }).runtimePort).toBe(4300);
        expect(() => parseOptions(['--runtime-port', 'x'], {})).toThrow('Invalid port');
    });

    it('should turn the component showcase off with the flag or the environment', () => {
        expect(parseOptions(['--no-showcase'], {}).showcase).toBe(false);
        expect(parseOptions([], { STATEUI_MCP_SHOWCASE: 'off' }).showcase).toBe(false);
        expect(parseOptions([], { STATEUI_MCP_SHOWCASE: 'FALSE' }).showcase).toBe(false);
        expect(parseOptions([], { STATEUI_MCP_SHOWCASE: 'on' }).showcase).toBe(true);
        expect(parseOptions([], { STATEUI_MCP_SHOWCASE: '' }).showcase).toBe(true);
    });

    it('should turn on stdio and help', () => {
        expect(parseOptions(['--stdio'], {}).stdio).toBe(true);
        expect(parseOptions(['-h'], {}).help).toBe(true);
        expect(parseOptions(['--help'], {}).help).toBe(true);
    });

    it('should refuse an unknown option, a missing value and a bad port', () => {
        expect(() => parseOptions(['--nope'], {})).toThrow(UsageError);
        expect(() => parseOptions(['--port'], {})).toThrow('needs a value');
        expect(() => parseOptions(['--port', 'abc'], {})).toThrow('Invalid port');
        expect(() => parseOptions([], { STATEUI_MCP_PORT: '99999' })).toThrow('Invalid port');
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

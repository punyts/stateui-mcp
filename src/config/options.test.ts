import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOptions, UsageError } from './options.js';

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
            statenet: undefined,
            secretKeyFile: undefined,
            secretKey: undefined,
            help: false
        });
    });

    it('should read the statenet and the secret key from flags or the environment', () => {
        expect(parseOptions(['--statenet', 'ws://127.0.0.1:4200/sync'], { STATEUI_MCP_STATENET: 'ws://other/sync' }).statenet).toBe('ws://127.0.0.1:4200/sync');
        expect(parseOptions([], { STATEUI_MCP_STATENET: 'ws://other/sync' }).statenet).toBe('ws://other/sync');
        expect(parseOptions(['--secret-key-file', 'key.bin'], {}).secretKeyFile).toBe(resolve('key.bin'));
        expect(parseOptions([], { STATEUI_MCP_SECRET_KEY_FILE: 'env.bin', STATEUI_MCP_SECRET_KEY: 'abc' })).toMatchObject({ secretKeyFile: resolve('env.bin'), secretKey: 'abc' });
    });

    it('should refuse a statenet URL that is not a WebSocket URL', () => {
        expect(() => parseOptions(['--statenet', 'http://127.0.0.1:4200'], {})).toThrow('ws:// or wss://');
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

#!/usr/bin/env node
import { createStderrReporter } from './config/reporter.js';
import { convertDataDir, formatConvertReport } from './config/convertDataDir.js';
import { CONVERT_HELP_TEXT, HELP_TEXT, parseConvertOptions, parseOptions, UsageError } from './config/options.js';
import { startServer } from './config/startServer.js';
import { loadSecretKey } from './infrastructure/sync/secretKey.js';

/** `stateui-mcp convert`: converts the data directory's old apps and prints the report */
async function convert(argv: readonly string[]): Promise<void> {
    let options;
    try {
        options = parseConvertOptions(argv, process.env);
    } catch (error) {
        if (error instanceof UsageError) {
            process.stderr.write(`${error.message}\n\n${CONVERT_HELP_TEXT}`);
            process.exitCode = 2;
            return;
        }
        throw error;
    }
    if (options.help) {
        process.stdout.write(CONVERT_HELP_TEXT);
        return;
    }
    const report = await convertDataDir({ dataDir: options.dataDir, dryRun: options.dryRun, purge: options.purge });
    process.stdout.write(formatConvertReport(report));
}

async function main(): Promise<void> {
    if (process.argv[2] === 'convert') {
        await convert(process.argv.slice(3));
        return;
    }
    let options;
    try {
        options = parseOptions(process.argv.slice(2), process.env);
    } catch (error) {
        if (error instanceof UsageError) {
            process.stderr.write(`${error.message}\n\n${HELP_TEXT}`);
            process.exitCode = 2;
            return;
        }
        throw error;
    }
    if (options.help) {
        process.stdout.write(HELP_TEXT);
        return;
    }

    const serverKey = await loadSecretKey(options.secretKeyFile, options.secretKey);
    const reporter = createStderrReporter();
    const server = await startServer({
        dataDir: options.dataDir,
        host: options.host,
        port: options.port,
        ...(options.runtimePort !== undefined && { runtimePort: options.runtimePort }),
        stdio: options.stdio,
        report: reporter.report,
        ...(options.runtimeDir !== undefined && { runtimeDir: options.runtimeDir }),
        ...(serverKey !== undefined && { serverKey }),
        ...(options.toolLog !== undefined && { toolLog: options.toolLog }),
        showcase: options.showcase
    });
    // Always stderr: in stdio mode stdout is the protocol
    process.stderr.write(`stateui-mcp: apps at ${server.origin}/  MCP at ${server.origin}/mcp${options.stdio ? '  and on stdio' : ''}\n`);

    let stopping = false;
    const stop = (): void => {
        if (stopping) return;
        stopping = true;
        void server.stop().finally(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    // The MCP client closing stdin ends a stdio session
    if (options.stdio) process.stdin.on('close', stop);
}

main().catch((error: unknown) => {
    process.stderr.write(`stateui-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});

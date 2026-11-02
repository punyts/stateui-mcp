#!/usr/bin/env node
import { createStderrReporter } from './config/reporter.js';
import { HELP_TEXT, parseOptions, UsageError } from './config/options.js';
import { startServer } from './config/startServer.js';

async function main(): Promise<void> {
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

    const reporter = createStderrReporter();
    const server = await startServer({
        dataDir: options.dataDir,
        host: options.host,
        port: options.port,
        ...(options.runtimePort !== undefined && { runtimePort: options.runtimePort }),
        stdio: options.stdio,
        report: reporter.report,
        ...(options.runtimeDir !== undefined && { runtimeDir: options.runtimeDir })
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

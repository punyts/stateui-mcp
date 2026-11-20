#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createStderrReporter } from './config/reporter.js';
import { convertDataDir, formatConvertReport } from './config/convertDataDir.js';
import { CONVERT_HELP_TEXT, HELP_TEXT, isNodeUrl, parseConvertOptions, parseOptions, UsageError } from './config/options.js';
import type { CliOptions } from './config/options.js';
import { startNodeServer } from './config/startNodeServer.js';
import { startServer } from './config/startServer.js';
import { NodeClient } from './infrastructure/statenet/NodeClient.js';
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

/** Stops on Ctrl+C, SIGTERM or the MCP client closing stdin */
function stopOn(stop: () => Promise<void>): void {
    let stopping = false;
    const once = (): void => {
        if (stopping) return;
        stopping = true;
        void stop().finally(() => process.exit(0));
    };
    process.on('SIGINT', once);
    process.on('SIGTERM', once);
    // The MCP client closing stdin ends the session
    process.stdin.on('close', once);
}

/** `stateui-mcp sign-in`: signs in to a node in the browser and keeps the tokens, before an MCP client starts the server */
async function signIn(options: CliOptions): Promise<void> {
    if (!isNodeUrl(options.statenet)) throw new UsageError('sign-in needs --statenet naming a node (https://...)');
    const reporter = createStderrReporter();
    const client = new NodeClient({ url: options.statenet, dataDir: options.dataDir, report: reporter.report, ...(options.statenetCa !== undefined && { ca: await readFile(options.statenetCa, 'utf8') }) });
    await client.signIn();
    process.stderr.write(`stateui-mcp: signed in to ${client.origin}; the tokens are in ${options.dataDir}\n`);
}

async function main(): Promise<void> {
    if (process.argv[2] === 'convert') {
        await convert(process.argv.slice(3));
        return;
    }
    const command = process.argv[2] === 'sign-in' ? 'sign-in' : 'serve';
    let options;
    try {
        options = parseOptions(process.argv.slice(command === 'sign-in' ? 3 : 2), process.env);
        if (command === 'sign-in' && !options.help) await signIn(options);
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
    if (command === 'sign-in') return;
    if (isNodeUrl(options.statenet)) {
        const reporter = createStderrReporter();
        const node = await startNodeServer({ url: options.statenet, dataDir: options.dataDir, report: reporter.report, ...(options.statenetCa !== undefined && { ca: await readFile(options.statenetCa, 'utf8') }) });
        process.stderr.write(`stateui-mcp: MCP on stdio, the tools run at ${node.client.origin}\n`);
        stopOn(() => node.stop());
        return;
    }

    const serverKey = await loadSecretKey(options.secretKeyFile, options.secretKey);
    const reporter = createStderrReporter();
    const server = await startServer({
        dataDir: options.dataDir,
        statenetUrl: options.statenet,
        viewUrl: options.viewUrl,
        report: reporter.report,
        ...(serverKey !== undefined && { serverKey }),
        ...(options.toolLog !== undefined && { toolLog: options.toolLog }),
        showcase: options.showcase
    });
    // Always stderr: in stdio mode stdout is the protocol
    process.stderr.write(`stateui-mcp: MCP on stdio, state to ${server.statenetUrl}, views at ${server.viewUrl}\n`);
    stopOn(() => server.stop());
}

main().catch((error: unknown) => {
    process.stderr.write(`stateui-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});

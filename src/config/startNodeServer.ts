import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { UseCaseReport } from '../application/ports/UseCaseReport.js';
import { createNodeMcpServer } from '../infrastructure/mcp/StateUiMcpServer.js';
import { NodeClient, SignedOut } from '../infrastructure/statenet/NodeClient.js';
import type { NodeTools } from '../infrastructure/statenet/NodeClient.js';

export interface NodeServerOptions {
    /** The node's origin, `https://…` (`http://` only on loopback) */
    readonly url: string;
    /** Keeps the tokens */
    readonly dataDir: string;
    /** A certificate authority to trust for the node, PEM */
    readonly ca?: string;
    readonly report: UseCaseReport;
    /** stdio by default; `'none'` or one given, for tests */
    readonly transport?: 'stdio' | 'none' | Transport;
    /** Opens the sign-in page; default the system's browser */
    readonly openBrowser?: (url: string) => void;
    readonly signInMs?: number;
}

export interface RunningNodeServer {
    readonly client: NodeClient;
    stop(): Promise<void>;
}

/**
 * Starts stateui-mcp as a client of a node (docs/design/statenet-network.md, S10b): it signs in as the person (in the
 * browser the first time, then with the kept tokens), takes the node's tools and serves them on stdio, each call run at
 * the node. The tools and instructions are the node's when the server starts
 */
export async function startNodeServer(options: NodeServerOptions): Promise<RunningNodeServer> {
    const client = new NodeClient({ url: options.url, dataDir: options.dataDir, report: options.report, ...(options.ca !== undefined && { ca: options.ca }), ...(options.openBrowser !== undefined && { openBrowser: options.openBrowser }), ...(options.signInMs !== undefined && { signInMs: options.signInMs }) });
    await client.ready();
    let node: NodeTools;
    try {
        node = await client.tools();
    } catch (error) {
        // kept tokens the node no longer takes: sign in again
        if (!(error instanceof SignedOut)) throw error;
        await client.signIn();
        node = await client.tools();
    }
    const choice = options.transport ?? 'stdio';
    const mcp = choice === 'none' ? undefined : createNodeMcpServer(client, node, options.report);
    if (mcp !== undefined) await mcp.connect(typeof choice === 'string' ? new StdioServerTransport() : choice);
    options.report.info('Server started', { node: client.origin, tools: node.tools.length });
    let stopped = false;
    return {
        client,
        stop: async () => {
            if (stopped) return;
            stopped = true;
            if (mcp !== undefined) await mcp.close().catch(() => undefined);
        }
    };
}

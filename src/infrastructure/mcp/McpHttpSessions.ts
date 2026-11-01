import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { UseCaseReport } from '../../application/ports/UseCaseReport.js';
import type { McpEndpoint } from '../http/HttpServer.js';

function jsonRpcError(response: ServerResponse, status: number, code: number, message: string): void {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/**
 * `/mcp` over the streamable HTTP transport, with sessions. An `initialize` request opens a session (a new MCP server
 * and transport, id in the `Mcp-Session-Id` header); every later request names its session, and `DELETE` closes it.
 * A request for a session that is gone is a 404, which tells a client to initialize again
 */
export class McpHttpSessions implements McpEndpoint {
    private readonly transports = new Map<string, StreamableHTTPServerTransport>();

    constructor(
        private readonly createServer: () => Server,
        private readonly report: UseCaseReport
    ) {}

    get sessionCount(): number {
        return this.transports.size;
    }

    async handle(request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void> {
        const header = request.headers['mcp-session-id'];
        const sessionId = Array.isArray(header) ? header[0] : header;

        if (sessionId !== undefined) {
            const transport = this.transports.get(sessionId);
            if (transport === undefined) {
                jsonRpcError(response, 404, -32001, 'Session not found; initialize again');
                return;
            }
            await transport.handleRequest(request, response, body);
            return;
        }
        if (request.method === 'POST' && isInitializeRequest(body)) {
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (id) => {
                    this.transports.set(id, transport);
                    this.report.info('MCP session opened', { sessions: this.transports.size });
                }
            });
            transport.onclose = () => {
                const id = transport.sessionId;
                if (id !== undefined && this.transports.delete(id)) this.report.info('MCP session closed', { sessions: this.transports.size });
            };
            await this.createServer().connect(transport);
            await transport.handleRequest(request, response, body);
            return;
        }
        jsonRpcError(response, 400, -32000, 'Bad request: send an initialize request first, then the Mcp-Session-Id it returns');
    }

    async close(): Promise<void> {
        const open = [...this.transports.values()];
        this.transports.clear();
        await Promise.all(open.map((transport) => transport.close().catch(() => undefined)));
    }
}

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startNodeServer } from '../../config/startNodeServer.js';
import { NODE_TOKENS_FILE } from './NodeClient.js';

/**
 * A stand-in for a node's agent endpoints (Magnetic's `/agent/*`): the person allows every ask at once, and the test
 * can expire an access token or end every sign-in
 */
function standInNode(): { server: Server; origin: () => string; expireAccess: () => void; endAll: () => void; calls: string[] } {
    const asks = new Map<string, { challenge: string; redirect: string }>();
    const access = new Set<string>();
    const refresh = new Set<string>();
    const calls: string[] = [];
    let issued = 0;
    const issue = (): { access_token: string; refresh_token: string; token_type: string; expires_in: number } => {
        issued += 1;
        access.add(`a${issued}`);
        refresh.add(`r${issued}`);
        return { access_token: `a${issued}`, refresh_token: `r${issued}`, token_type: 'Bearer', expires_in: 3600 };
    };
    const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const json = (status: number, body: unknown): void => {
            response.writeHead(status, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(body));
        };
        let body = '';
        request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
        request.on('end', () => {
            if (url.pathname === '/agent/authorize') {
                const code = `c${asks.size + 1}`;
                asks.set(code, { challenge: url.searchParams.get('code_challenge') as string, redirect: url.searchParams.get('redirect_uri') as string });
                response.writeHead(303, { Location: `${url.searchParams.get('redirect_uri') as string}?code=${code}&state=${url.searchParams.get('state') as string}` });
                response.end();
                return;
            }
            if (url.pathname === '/agent/token') {
                const form = new URLSearchParams(body);
                if (form.get('grant_type') === 'authorization_code') {
                    const ask = asks.get(form.get('code') as string);
                    asks.delete(form.get('code') as string);
                    const verified = ask !== undefined && createHash('sha256').update(form.get('code_verifier') as string).digest('base64url') === ask.challenge && ask.redirect === form.get('redirect_uri');
                    json(verified ? 200 : 400, verified ? issue() : { error: 'invalid_grant' });
                    return;
                }
                const token = form.get('refresh_token') as string;
                if (!refresh.delete(token)) return json(400, { error: 'invalid_grant' });
                json(200, issue());
                return;
            }
            const bearer = (request.headers.authorization ?? '').replace('Bearer ', '');
            if (!access.has(bearer)) return json(401, { error: 'invalid_token' });
            if (url.pathname === '/agent/tools') return json(200, { instructions: 'The node\'s instructions', tools: [{ name: 'ui_list', description: 'Lists parts', inputSchema: { type: 'object', properties: { kind: { type: 'string' } } } }] });
            const call = JSON.parse(body) as { name: string; arguments: Record<string, unknown> };
            calls.push(call.name);
            json(200, { isError: false, body: { tool: call.name, kind: call.arguments['kind'] } });
        });
    });
    return {
        server,
        origin: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        expireAccess: () => access.clear(),
        endAll: () => {
            access.clear();
            refresh.clear();
        },
        calls
    };
}

describe('stateui-mcp signed in to a node', () => {
    let node: ReturnType<typeof standInNode>;
    let dataDir: string;
    const report = { info: () => undefined };

    beforeEach(async () => {
        node = standInNode();
        await new Promise<void>((resolve) => node.server.listen(0, '127.0.0.1', () => resolve()));
        dataDir = await mkdtemp(join(tmpdir(), 'stateui-node-'));
    });

    afterEach(async () => {
        await new Promise((resolve) => node.server.close(resolve));
        await rm(dataDir, { recursive: true, force: true });
    });

    /** The person's browser: it opens the ask, which the stand-in allows at once, and follows it back to the agent */
    const browser = (opened: string[]) => (url: string) => {
        opened.push(url);
        void fetch(url);
    };

    /** The server on an MCP client of the test's own */
    async function connect(opened: string[]): Promise<{ client: Client; stop: () => Promise<void> }> {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const running = await startNodeServer({ url: node.origin(), dataDir, report, transport: serverTransport, openBrowser: browser(opened), signInMs: 5000 });
        const client = new Client({ name: 'test', version: '1.0.0' });
        await client.connect(clientTransport);
        return { client, stop: () => running.stop() };
    }

    it('should sign in once in the browser, serve the node\'s tools and run them there', async () => {
        // Arrange
        const opened: string[] = [];

        // Act
        const first = await connect(opened);
        const tools = await first.client.listTools();
        const answer = await first.client.callTool({ name: 'ui_list', arguments: { kind: 'apps' } });
        await first.stop();
        const second = await connect(opened);
        await second.client.callTool({ name: 'ui_list', arguments: { kind: 'themes' } });
        await second.stop();

        // Assert
        expect(opened).toHaveLength(1);
        expect(opened[0]).toMatch(/\/agent\/authorize\?response_type=code&client_id=stateui-mcp&redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fcallback&code_challenge=[A-Za-z0-9_-]{43}&code_challenge_method=S256&state=/);
        expect(first.client.getInstructions()).toBe('The node\'s instructions');
        expect(tools.tools.map((tool) => tool.name)).toEqual(['ui_list']);
        expect(answer.content).toEqual([{ type: 'text', text: '{"tool":"ui_list","kind":"apps"}' }]);
        expect(node.calls).toEqual(['ui_list', 'ui_list']);
        const kept = JSON.parse(await readFile(join(dataDir, NODE_TOKENS_FILE), 'utf8')) as Record<string, { refreshToken: string }>;
        expect(Object.keys(kept)).toEqual([node.origin()]);
        if (process.platform !== 'win32') expect((await stat(join(dataDir, NODE_TOKENS_FILE))).mode & 0o077).toBe(0);
    });

    it('should renew a refused access token with the refresh token', async () => {
        // Arrange
        const opened: string[] = [];
        const running = await connect(opened);

        // Act
        node.expireAccess();
        const answer = await running.client.callTool({ name: 'ui_list', arguments: { kind: 'apps' } });
        await running.stop();

        // Assert
        expect(answer.isError).toBeFalsy();
        expect(opened).toHaveLength(1);
    });

    it('should change nothing once the node ends its sign-in, and ask the person to sign in again', async () => {
        // Arrange
        const opened: string[] = [];
        const running = await connect(opened);

        // Act
        node.endAll();
        const answer = await running.client.callTool({ name: 'ui_list', arguments: { kind: 'apps' } });
        await vi.waitFor(() => expect(opened).toHaveLength(2));
        const after = await vi.waitFor(async () => {
            const again = await running.client.callTool({ name: 'ui_list', arguments: { kind: 'apps' } });
            expect(again.isError).toBeFalsy();
            return again;
        });
        await running.stop();

        // Assert
        expect(answer.isError).toBe(true);
        expect(JSON.stringify(answer.content)).toContain('signed-out');
        expect(node.calls).toEqual(['ui_list']);
        expect(after.isError).toBeFalsy();
    });
});

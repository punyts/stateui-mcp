import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import type { UseCaseReport } from '../../application/ports/UseCaseReport.js';
import type { InputSchema, ToolAnnotations, ToolOutcome } from '../mcp/toolKit.js';

/** How long the person has to sign in and allow the agent in the browser; the node keeps an ask as long */
export const NODE_SIGN_IN_MS = 10 * 60 * 1000;
/** The file in the data directory that keeps each node's tokens */
export const NODE_TOKENS_FILE = 'node-sign-in.json';
/** The most a node's answer may hold */
const MAX_ANSWER_BYTES = 32 * 1024 * 1024;

/** A tool as the node lists it */
export interface NodeTool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: InputSchema;
    readonly annotations?: ToolAnnotations;
}

/** What the node gives an agent to work with: its tools and the instructions that go with them */
export interface NodeTools {
    readonly instructions: string;
    readonly tools: readonly NodeTool[];
}

export interface NodeClientOptions {
    /** The node's origin, such as `https://192.168.1.20:4300` */
    readonly url: string;
    /** The data directory, which keeps the tokens (`node-sign-in.json`) */
    readonly dataDir: string;
    /** A certificate authority to trust for the node, PEM, such as a local Magnetic's `authority.crt` */
    readonly ca?: string;
    readonly report: UseCaseReport;
    /** Opens a page in the person's browser; default the system's browser */
    readonly openBrowser?: (url: string) => void;
    /** Default `NODE_SIGN_IN_MS` */
    readonly signInMs?: number;
}

/** The node refused the agent's tokens: the person signs in again */
export class SignedOut extends Error {}

interface KeptTokens {
    readonly accessToken: string;
    readonly refreshToken: string;
    /** Milliseconds since the epoch */
    readonly accessExpiresAt: number;
}

interface Answer {
    readonly status: number;
    readonly body: unknown;
}

/** Opens a page in the system's browser, without a shell, so nothing in the address is run */
export function openSystemBrowser(url: string): void {
    const [command, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
}

/**
 * stateui-mcp as a client of a node (docs/design/statenet-network.md, S10b): it signs in as the person running it,
 * through the node's own sign-in in their browser (the authorization code flow with PKCE, the code sent back to a
 * port on 127.0.0.1 it listens on for that one answer), keeps the tokens in its data directory, renews them, and runs
 * the StateUI tools at the node, in the person's workspace
 */
export class NodeClient {
    readonly origin: string;
    private tokens: KeptTokens | undefined;
    private signingIn: Promise<void> | undefined;

    constructor(private readonly options: NodeClientOptions) {
        this.origin = new URL(options.url).origin;
    }

    /** Uses the kept tokens, or signs in in the browser when there are none */
    async ready(): Promise<void> {
        this.tokens ??= (await this.readKept())[this.origin];
        if (this.tokens === undefined) await this.signIn();
    }

    /** Signs in in the person's browser; one at a time */
    signIn(): Promise<void> {
        this.signingIn ??= this.browserSignIn().finally(() => {
            this.signingIn = undefined;
        });
        return this.signingIn;
    }

    /** The node's tools for this person */
    async tools(): Promise<NodeTools> {
        const answer = await this.authorized('GET', '/agent/tools');
        if (answer.status !== 200) throw new Error(`The node answered ${answer.status} for its tools: ${messageOf(answer.body)}`);
        return answer.body as NodeTools;
    }

    /** Runs a tool at the node. Signed out, it starts a new sign-in and answers why the call did nothing */
    async call(name: string, args: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
        let answer: Answer;
        try {
            answer = await this.authorized('POST', '/agent/call', { name, arguments: args });
        } catch (error) {
            if (!(error instanceof SignedOut)) throw error;
            void this.signIn().catch((reason: unknown) => this.options.report.info('Signing in to the node did not finish', { node: this.origin, error: reason instanceof Error ? reason.message : String(reason) }));
            return { isError: true, body: { error: 'signed-out', message: `The node ${this.origin} no longer takes this agent's sign-in, so nothing was changed. Sign in again in the browser page that opened, then call the tool again` } };
        }
        if (typeof answer.body === 'object' && answer.body !== null && 'isError' in answer.body) return answer.body as ToolOutcome;
        return { isError: true, body: { error: 'node-error', message: `The node answered ${answer.status}: ${messageOf(answer.body)}` } };
    }

    /** A request with the access token, renewed once when it has expired or is refused */
    private async authorized(method: string, path: string, body?: unknown): Promise<Answer> {
        await this.ready();
        if ((this.tokens as KeptTokens).accessExpiresAt <= Date.now() + 30_000) await this.renew();
        let answer = await this.send(method, path, body, (this.tokens as KeptTokens).accessToken);
        if (answer.status === 401) {
            await this.renew();
            answer = await this.send(method, path, body, (this.tokens as KeptTokens).accessToken);
            if (answer.status === 401) throw await this.forget();
        }
        return answer;
    }

    private async renew(): Promise<void> {
        const kept = this.tokens;
        if (kept === undefined) throw new SignedOut('Not signed in');
        const answer = await this.form('/agent/token', { grant_type: 'refresh_token', refresh_token: kept.refreshToken });
        if (answer.status !== 200) throw await this.forget();
        await this.keep(answer.body);
    }

    /** Drops the tokens the node refused; answers the error to throw */
    private async forget(): Promise<SignedOut> {
        this.tokens = undefined;
        const all = await this.readKept();
        delete all[this.origin];
        await this.writeKept(all);
        this.options.report.info('The node refused the sign-in', { node: this.origin });
        return new SignedOut('The node refused the sign-in');
    }

    private async browserSignIn(): Promise<void> {
        const verifier = randomBytes(32).toString('base64url');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        const state = randomBytes(16).toString('base64url');
        const limit = this.options.signInMs ?? NODE_SIGN_IN_MS;
        let settle: { resolve: (code: string) => void; reject: (error: Error) => void } | undefined;
        const answered = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
        const server = createServer((request, response) => {
            const url = new URL(request.url ?? '/', 'http://127.0.0.1');
            if (url.pathname !== '/callback' || url.searchParams.get('state') !== state || url.searchParams.get('code') === null) {
                response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                response.end('Not this sign-in.');
                return;
            }
            response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            response.end('stateui-mcp is signed in. You can close this page.');
            settle?.resolve(url.searchParams.get('code') as string);
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve());
        });
        const timer = setTimeout(() => settle?.reject(new Error(`Nobody signed in within ${Math.round(limit / 60_000)} minutes`)), limit);
        try {
            const port = (server.address() as { port: number }).port;
            const redirectUri = `http://127.0.0.1:${port}/callback`;
            const ask = new URL('/agent/authorize', this.origin);
            ask.search = new URLSearchParams({ response_type: 'code', client_id: 'stateui-mcp', redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state }).toString();
            // Always stderr: on stdio, stdout is the protocol
            process.stderr.write(`stateui-mcp: sign in to ${this.origin} in your browser, and allow the agent: ${ask.href}\n`);
            (this.options.openBrowser ?? openSystemBrowser)(ask.href);
            const code = await answered;
            const answer = await this.form('/agent/token', { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri });
            if (answer.status !== 200) throw new Error(`The node did not give the agent its tokens (${answer.status})`);
            await this.keep(answer.body);
            this.options.report.info('Signed in to the node', { node: this.origin });
        } finally {
            clearTimeout(timer);
            server.close();
        }
    }

    private async keep(body: unknown): Promise<void> {
        const answer = body as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
        if (typeof answer.access_token !== 'string' || typeof answer.refresh_token !== 'string' || typeof answer.expires_in !== 'number') throw new Error('The node answered tokens it should not');
        this.tokens = { accessToken: answer.access_token, refreshToken: answer.refresh_token, accessExpiresAt: Date.now() + answer.expires_in * 1000 };
        const all = await this.readKept();
        all[this.origin] = this.tokens;
        await this.writeKept(all);
    }

    private get keptFile(): string {
        return join(this.options.dataDir, NODE_TOKENS_FILE);
    }

    private async readKept(): Promise<Record<string, KeptTokens>> {
        try {
            const parsed = JSON.parse(await readFile(this.keptFile, 'utf8')) as unknown;
            return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, KeptTokens>) : {};
        } catch {
            return {};
        }
    }

    /** Written whole and moved into place, readable by this user only */
    private async writeKept(all: Record<string, KeptTokens>): Promise<void> {
        await mkdir(this.options.dataDir, { recursive: true });
        const temporary = `${this.keptFile}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(all, null, 2), { mode: 0o600 });
        await rename(temporary, this.keptFile);
    }

    private form(path: string, fields: Record<string, string>): Promise<Answer> {
        return this.request('POST', path, { 'Content-Type': 'application/x-www-form-urlencoded' }, new URLSearchParams(fields).toString());
    }

    private send(method: string, path: string, body: unknown, accessToken: string): Promise<Answer> {
        return this.request(method, path, { Authorization: `Bearer ${accessToken}`, ...(body !== undefined && { 'Content-Type': 'application/json' }) }, body === undefined ? undefined : JSON.stringify(body));
    }

    private request(method: string, path: string, headers: Record<string, string>, body: string | undefined): Promise<Answer> {
        const url = new URL(path, this.origin);
        const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
        return new Promise((resolve, reject) => {
            const outgoing = send(
                url,
                { method, headers: { Accept: 'application/json', ...headers }, ...(this.options.ca !== undefined && url.protocol === 'https:' && { ca: [this.options.ca] }) },
                (response: IncomingMessage) => {
                    const chunks: Buffer[] = [];
                    let size = 0;
                    response.on('data', (chunk: Buffer) => {
                        size += chunk.length;
                        if (size > MAX_ANSWER_BYTES) {
                            response.destroy(new Error('The node answered too much'));
                            return;
                        }
                        chunks.push(chunk);
                    });
                    response.on('error', reject);
                    response.on('end', () => {
                        const text = Buffer.concat(chunks).toString('utf8');
                        let parsed: unknown = text;
                        try {
                            parsed = JSON.parse(text) as unknown;
                        } catch {
                            // not JSON: kept as text for the message
                        }
                        resolve({ status: response.statusCode ?? 0, body: parsed });
                    });
                }
            );
            outgoing.on('error', reject);
            outgoing.end(body);
        });
    }
}

function messageOf(body: unknown): string {
    if (typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string') return (body as { message: string }).message;
    return typeof body === 'string' ? body.slice(0, 200) : 'no message';
}

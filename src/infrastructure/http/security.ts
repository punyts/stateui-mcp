import type { IncomingMessage } from 'node:http';

/**
 * The policy of the runtime page, which the app iframe loads from the runtime origin (its own port). Scripts and styles
 * only from that origin, no network but `https:` images (an `image` or `avatar` src), fonts only as `data:`, no forms, and only the host page of this server
 * (`hostOrigin`) may frame it.
 *
 * `script-src` has one source beyond `'self'`: `'unsafe-eval'`. `@punyts/expression` turns the literal parts of a
 * binding expression into values with `Function(...)`, so without it every component whose template has a ternary or a
 * comparison fails to mount. `connect-src` is `'none'`, so evaluated code has no network; the frame is sandboxed and
 * its origin is not the host page's, so it cannot reach the host page either
 */
export function runtimeCsp(hostOrigin: string): string {
    return [
        "default-src 'none'",
        "script-src 'self' 'unsafe-eval'",
        "style-src 'self'",
        'img-src data: https:',
        'font-src data:',
        "connect-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        `frame-ancestors ${hostOrigin}`
    ].join('; ');
}

/**
 * The policy of the host page: its own script and stylesheet, its own event stream and reports, the runtime frame
 * from the runtime origin (`runtimeOrigin`), and nothing else. No inline script and no inline style. No other page may frame it
 */
export function hostPageCsp(runtimeOrigin: string): string {
    return [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "connect-src 'self'",
        `frame-src ${runtimeOrigin}`,
        'img-src data:',
        "form-action 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'"
    ].join('; ');
}

/** The policy of a page that only lists links: a stylesheet from its own origin and nothing else */
export const LIST_PAGE_CSP = ["default-src 'none'", "style-src 'self'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'none'"].join('; ');

/** The policy of an uploaded file the server sends back: it can do nothing if a browser opens it */
export const FILE_CSP = "sandbox; default-src 'none'";

export const COMMON_HEADERS: Readonly<Record<string, string>> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
};

function hostName(hostHeader: string): string {
    if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1).toLowerCase();
    return (hostHeader.split(':')[0] ?? '').toLowerCase();
}

/**
 * The host name of a `Host` header (`localhost`, `127.0.0.1`, `[::1]`, a LAN name or address), or `undefined` when it
 * holds anything else. The pages build the other origin from it, in an attribute and in a policy header
 */
export function requestHostName(hostHeader: string | undefined): string | undefined {
    if (hostHeader === undefined) return undefined;
    const name = hostName(hostHeader);
    return /^[a-z0-9.-]+$/.test(name) || /^[[0-9a-f:.]+]$/.test(name) ? name : undefined;
}

/**
 * Guards against DNS rebinding: a page on another site can point its own name at 127.0.0.1 and then call this
 * server. While the server is bound to a loopback address only the loopback names are accepted in `Host`
 */
export function isAllowedHost(hostHeader: string | undefined, bindHost: string): boolean {
    const bind = bindHost.toLowerCase();
    // A server bound to a LAN address is reached by names this check cannot know
    if (!['127.0.0.1', '::1', 'localhost'].includes(bind)) return true;
    if (hostHeader === undefined) return false;
    const name = hostName(hostHeader);
    return new Set(['localhost', '127.0.0.1', '[::1]']).has(name);
}

/**
 * Guards against a web page that posts to this server from another origin. A request with an `Origin` header must come
 * from the same host the request names; a request without one (curl, an MCP client, Node) is allowed
 */
export function isSameOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (origin === undefined) return true;
    try {
        return new URL(origin).host === request.headers.host;
    } catch {
        return false;
    }
}

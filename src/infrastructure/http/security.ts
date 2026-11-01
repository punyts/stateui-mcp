import type { IncomingMessage } from 'node:http';

/**
 * The policy of the runtime page, which the app iframe loads. Scripts and styles only from the origin of the page,
 * no network, images and fonts only as `data:`, no forms, and only pages of this server may frame it.
 *
 * `script-src` has one source beyond `'self'`: `'unsafe-eval'`. `@punyts/expression` turns the literal parts of a
 * binding expression into values with `Function(...)`, so without it every component whose template has a ternary or a
 * comparison fails to mount. The frame is sandboxed without `allow-same-origin` and `connect-src` is `'none'`, so
 * evaluated code has no network, no cookies and no storage
 */
export const RUNTIME_CSP = [
    "default-src 'none'",
    "script-src 'self' 'unsafe-eval'",
    "style-src 'self'",
    'img-src data:',
    'font-src data:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'"
].join('; ');

/**
 * The policy of the host page: its own script and stylesheet, its own event stream and reports, the runtime frame
 * from the same origin, and nothing else. No inline script and no inline style. No other page may frame it
 */
export const HOST_PAGE_CSP = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "frame-src 'self'",
    'img-src data:',
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
].join('; ');

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

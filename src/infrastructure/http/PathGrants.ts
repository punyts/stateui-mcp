import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** How long a read grant of `/paths` lasts */
export const GRANT_LIFETIME_MS = 15 * 60 * 1000;

/** How often an open view is sent a new grant: before the one it holds runs out */
export const GRANT_RENEW_MS = 10 * 60 * 1000;

/** The grant key of a server that has a secret key: the same on every server that shares the secret */
export function pathGrantKey(secret: string): Buffer {
    return Buffer.from(hkdfSync('sha256', secret, '', 'paths-grant', 32));
}

/**
 * The read grants of `/paths` (docs/design/statenet-paths-route.md, "The read grant"): a grant reaches every file of one
 * app of one owner until it expires. It is `base64url(owner "." app "." expiry) "." base64url(mac)`, the mac an
 * HMAC-SHA-256 of the first part with the grant key. The runtime frame sends no cookie, so it reads with one in the query
 */
export class PathGrants {
    private readonly key: Buffer;

    /** Without a key the server makes one: its grants end when it stops */
    constructor(
        key: Uint8Array = randomBytes(32),
        private readonly now: () => number = Date.now
    ) {
        this.key = Buffer.from(key);
    }

    /** A grant to the files of `appId` of `owner` for `GRANT_LIFETIME_MS` */
    issue(owner: string, appId: string): string {
        const body = Buffer.from(`${owner}.${appId.toLowerCase()}.${this.now() + GRANT_LIFETIME_MS}`, 'utf8').toString('base64url');
        return `${body}.${this.mac(body).toString('base64url')}`;
    }

    /** Whether `grant` is one of this key's, unexpired, for `appId` of `owner` */
    allows(grant: string, owner: string, appId: string): boolean {
        const dot = grant.indexOf('.');
        if (dot <= 0 || grant.length > 512) return false;
        const body = grant.slice(0, dot);
        const given = Buffer.from(grant.slice(dot + 1), 'base64url');
        const expected = this.mac(body);
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
        const text = Buffer.from(body, 'base64url').toString('utf8');
        const last = text.lastIndexOf('.');
        const middle = text.lastIndexOf('.', last - 1);
        if (middle <= 0) return false;
        const expiry = Number(text.slice(last + 1));
        return text.slice(0, middle) === owner && text.slice(middle + 1, last) === appId.toLowerCase() && Number.isSafeInteger(expiry) && expiry > this.now();
    }

    private mac(body: string): Buffer {
        return createHmac('sha256', this.key).update(body).digest();
    }
}

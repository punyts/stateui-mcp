import { randomUUID } from 'node:crypto';
import { generateGrantKey, grantPattern, readGrant, signGrant, verifyGrant, type GrantKey } from '@punyts/state-sync/authority';
import { patternCovers } from '@punyts/state';
import type { PermissionStore } from '../../application/ports/PermissionStore.js';

/** How long a token of `/paths` lasts */
export const PATH_TOKEN_LIFE_MS = 15 * 60 * 1000;

/** How often an open view is sent a new token: before the one it holds runs out */
export const PATH_TOKEN_RENEW_MS = 10 * 60 * 1000;

/** The longest token taken from a URL */
const MAX_TOKEN_LENGTH = 4096;

/** A key that signs: its id and its private part (PKCS#8 DER, base64url) */
export interface SigningKey {
    readonly kid: string;
    readonly privateKey: string;
}

/**
 * The owners' signing keys and the revocations, as the tokens of `/paths` need them: the same on every server of a
 * host (Magnetic keeps them in its database), or one server's own (`MemoryGrantKeys`)
 */
export interface GrantKeys {
    /** The owner's current signing key, made when it has none */
    signing(owner: string): Promise<SigningKey>;
    /** The public key of a key id; undefined when there is none */
    keyOf(kid: string): Promise<GrantKey | undefined>;
    /** Which of these permission entries of the owner are revoked */
    revoked(owner: string, entries: readonly string[]): Promise<ReadonlySet<string>>;
}

/** Who reads an owner's apps through a view: a token's subject, and the permission entry they hold the app by */
export interface PathReader {
    readonly subject: string;
    /** Absent for the owner, who holds its apps without an entry */
    readonly entry?: string;
}

/**
 * Keys made by this server, one per owner the first time it signs, kept in memory: a restart ends its tokens, and an
 * open view's next renewal replaces them. Revocations are the store's, when it has one
 */
export class MemoryGrantKeys implements GrantKeys {
    private readonly signers = new Map<string, SigningKey>();
    private readonly publics = new Map<string, GrantKey>();

    constructor(private readonly permissions?: PermissionStore) {}

    async signing(owner: string): Promise<SigningKey> {
        const known = this.signers.get(owner);
        if (known !== undefined) return known;
        const pair = generateGrantKey();
        const key = { kid: randomUUID(), privateKey: pair.privateKey };
        this.signers.set(owner, key);
        this.publics.set(key.kid, { ownerId: owner, publicKey: pair.publicKey });
        return key;
    }

    async keyOf(kid: string): Promise<GrantKey | undefined> {
        return this.publics.get(kid);
    }

    async revoked(owner: string, entries: readonly string[]): Promise<ReadonlySet<string>> {
        return this.permissions === undefined ? new Set() : this.permissions.revoked(owner, entries);
    }
}

/** The pattern a token of `/paths` covers: every file of one app */
export const appFilesPattern = (appId: string): string => `$.apps.${appId.toLowerCase()}.files`;

/**
 * The tokens of `/paths` (docs/design/statenet-permissions.md, "Tokens"): a grant token as relays check them, signed
 * with the owner's key, for `read` of an app's files, naming the reader and the entry they hold the app by, for
 * `PATH_TOKEN_LIFE_MS`. The runtime frame sends no cookie, so it reads with one in the query
 */
export class PathTokens {
    constructor(
        private readonly keys: GrantKeys,
        private readonly now: () => number = Date.now
    ) {}

    /** A token to read the files of `appId` of `owner`, for its reader (the owner when none is given) */
    async issue(owner: string, appId: string, reader?: PathReader): Promise<string> {
        const key = await this.keys.signing(owner);
        const issued = this.now();
        return signGrant(
            {
                ...(reader?.entry !== undefined && { entry: reader.entry }),
                kid: key.kid,
                issuer: owner,
                subject: reader?.subject ?? owner,
                owner,
                pattern: appFilesPattern(appId),
                rights: ['read'],
                issued,
                expires: issued + PATH_TOKEN_LIFE_MS
            },
            key.privateKey
        );
    }

    /** Whether `token` is signed by its owner's key, unexpired, not revoked, and lets its holder read `path` of `owner` */
    async allows(token: string, owner: string, path: string): Promise<boolean> {
        if (token.length > MAX_TOKEN_LENGTH) return false;
        const kids = new Map<string, GrantKey>();
        const entries: string[] = [];
        for (let claims = readGrant(token), depth = 0; claims !== undefined && depth < 8; claims = claims.parent === undefined ? undefined : readGrant(claims.parent), depth++) {
            const key = await this.keys.keyOf(claims.kid);
            if (key !== undefined) kids.set(claims.kid, key);
            entries.push(claims.entry);
        }
        const revoked = entries.length === 0 ? new Set<string>() : await this.keys.revoked(owner, entries);
        const check = verifyGrant(token, { keyOf: (kid) => kids.get(kid), now: this.now(), revoked: (entry) => revoked.has(entry) });
        if (!check.ok || check.grant.owner !== owner || !check.grant.rights.includes('read')) return false;
        const pattern = grantPattern(check.grant.pattern);
        return pattern !== undefined && patternCovers(pattern, path);
    }
}

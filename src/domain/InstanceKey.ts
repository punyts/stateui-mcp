/**
 * The owner's own persona: on a local server the owner is also its one user. A server with many users keys another
 * person's instance of the owner's app by a persona of their own, such as their user id
 */
export const DEFAULT_PERSONA = 'default';

/** A persona name reaches file paths and namespaces: lower-case letters, digits and dashes, starting with a letter or digit */
export function isPersonaName(value: string): boolean {
    return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

/** Names one running instance: a persona of an owner using one of the owner's apps (by the app part's id) */
export interface InstanceKey {
    readonly persona: string;
    readonly ownerId: string;
    readonly appId: string;
}

/** The key as one lower-case text, `{persona}.{ownerId}.{appId}`, for maps and namespaces */
export function instanceKeyText(key: InstanceKey): string {
    return `${key.persona}.${key.ownerId}.${key.appId}`.toLowerCase();
}

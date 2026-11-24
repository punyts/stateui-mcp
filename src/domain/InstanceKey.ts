/**
 * A person is an owner id, and it reaches file paths and namespaces: lower-case letters, digits and dashes, starting
 * with a letter or digit
 */
export function isPersonId(value: string): boolean {
    return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

/**
 * Names one running instance: a person (an owner id) using one of an owner's apps (by the app part's id). The owner's
 * own instance is the one whose person is the owner
 */
export interface InstanceKey {
    readonly person: string;
    readonly ownerId: string;
    readonly appId: string;
}

/** The key as one lower-case text, `{person}.{ownerId}.{appId}`, for maps and namespaces */
export function instanceKeyText(key: InstanceKey): string {
    return `${key.person}.${key.ownerId}.${key.appId}`.toLowerCase();
}

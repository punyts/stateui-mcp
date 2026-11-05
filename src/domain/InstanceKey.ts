/** The only persona of the local server: its owner is also its one user */
export const DEFAULT_PERSONA = 'default';

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

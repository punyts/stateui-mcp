import { DEFAULT_PERSONA } from './InstanceKey.js';

/** Whose state a namespace holds within an app: the app's own, shared by everyone using it, or one user's */
export type StateScope = 'app' | 'user';

/**
 * Where a namespace lives in the statenet (docs/design/statenet-relays.md, "Addresses"): `<ownerId>/<appId>/<scope>`.
 * The app's state is owned by whoever owns the app; a user's state in an app is owned by the user, whoever owns the app
 */
export interface StateAddress {
    readonly ownerId: string;
    readonly appId: string;
    readonly scope: StateScope;
}

/** An owner or app id in an address: no slash, no space, not empty */
const SEGMENT = /^[^/\s]{1,200}$/;

export function formatAddress(address: StateAddress): string {
    if (!SEGMENT.test(address.ownerId) || !SEGMENT.test(address.appId)) throw new Error('An address names an owner and an app, each without a slash or a space');
    return `${address.ownerId}/${address.appId.toLowerCase()}/${address.scope}`;
}

/** The address a text names, or undefined when it is not one */
export function parseAddress(text: string): StateAddress | undefined {
    const [ownerId, appId, scope, ...rest] = text.split('/');
    if (rest.length > 0 || ownerId === undefined || appId === undefined || !SEGMENT.test(ownerId) || !SEGMENT.test(appId)) return undefined;
    if (scope !== 'app' && scope !== 'user') return undefined;
    return { ownerId, appId, scope };
}

/**
 * The address of a persona's own state in an app of a workspace: `<persona>/<appId>/user`. The workspace's default
 * persona (its builders' preview, and the person themself in their own workspace) is the workspace, so a person's state
 * in their own app is at their own id, and stays there when the app moves into an org
 */
export function userStateAddress(workspaceId: string, persona: string, appId: string): string {
    return formatAddress({ ownerId: persona === DEFAULT_PERSONA ? workspaceId : persona, appId, scope: 'user' });
}

/** The address of an app's own state: `<ownerId>/<appId>/app` */
export function appStateAddress(ownerId: string, appId: string): string {
    return formatAddress({ ownerId, appId, scope: 'app' });
}

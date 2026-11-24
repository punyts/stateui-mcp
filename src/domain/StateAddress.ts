/** The branch of an owner's tree a namespace is under: its state of apps (`$.apps`), or its data (`$.data`) */
export type StateBranch = 'apps' | 'data';

/**
 * Where a namespace lives in the statenet (docs/design/statenet-network.md, "`$` is the owner"): an owner and a path
 * under its `$`, written `<owner>/<branch>/<key>`. `<owner>/apps/<appId>` is `$.apps.<appId>` of that owner's tree, the
 * owner's state of the app; `<owner>/data/<dataset>` is `$.data.<dataset>`. The owner is its number where owners have
 * numbers (`OwnerNames`), and its id where they do not (a stateui-mcp by itself)
 */
export interface StateAddress {
    readonly owner: string;
    readonly branch: StateBranch;
    /** The app's id under `apps`, the dataset under `data` */
    readonly key: string;
}

/**
 * The names owners go by in addresses: a number each, from one sequence, where a statenet issues them. `of` is the
 * name of an owner's id (a user's, or a workspace's, which goes by its user's or its org's); `idOf` the id a name
 * stands for, undefined when it is not known here. Both answer at once, so whoever gives one has the owners it is
 * asked about at hand
 */
export interface OwnerNames {
    of(id: string): string;
    idOf(owner: string): string | undefined;
}

/** Owners named by their ids: a statenet where no numbers are issued */
export const OWNER_IDS: OwnerNames = { of: (id) => id, idOf: (owner) => owner };

/** An owner or key in an address: no slash, no space, not empty */
const SEGMENT = /^[^/\s]{1,200}$/;

export function formatAddress(address: StateAddress): string {
    if (!SEGMENT.test(address.owner) || !SEGMENT.test(address.key)) throw new Error('An address names an owner and an app or a dataset, each without a slash or a space');
    return `${address.owner}/${address.branch}/${address.branch === 'apps' ? address.key.toLowerCase() : address.key}`;
}

/** The address a text names, or undefined when it is not one */
export function parseAddress(text: string): StateAddress | undefined {
    const [owner, branch, key, ...rest] = text.split('/');
    if (rest.length > 0 || owner === undefined || key === undefined || !SEGMENT.test(owner) || !SEGMENT.test(key)) return undefined;
    if (branch !== 'apps' && branch !== 'data') return undefined;
    return { owner, branch, key };
}

/**
 * The address of a person's own state of an app: `<person>/apps/<appId>`, the app's place in the person's tree. The
 * person is an owner id: the app's owner for their own state of it (a workspace's builders' preview is the workspace's
 * owner), anyone else for theirs, so a person's state of an app stays in their tree when the app moves into an org
 */
export function userStateAddress(person: string, appId: string, owners: OwnerNames = OWNER_IDS): string {
    return formatAddress({ owner: owners.of(person), branch: 'apps', key: appId });
}

/** The person (an owner id) and app of an address, or undefined when it is not an app's state of an owner known here */
export function instanceOfAddress(address: string, owners: OwnerNames = OWNER_IDS): { readonly appId: string; readonly person: string } | undefined {
    const parsed = parseAddress(address);
    const id = parsed === undefined || parsed.branch !== 'apps' ? undefined : owners.idOf(parsed.owner);
    if (parsed === undefined || id === undefined) return undefined;
    return { appId: parsed.key.toLowerCase(), person: id };
}

/** The address of a dataset of a workspace: `<owner>/data/<dataset>`, the namespace that holds its records */
export function datasetStateAddress(workspaceId: string, dataset: string, owners: OwnerNames = OWNER_IDS): string {
    return formatAddress({ owner: owners.of(workspaceId), branch: 'data', key: dataset });
}

/** The dataset of an address in a workspace: undefined when the address is not one of the workspace's datasets */
export function datasetOfAddress(address: string, workspaceId: string, owners: OwnerNames = OWNER_IDS): string | undefined {
    const parsed = parseAddress(address);
    if (parsed === undefined || parsed.branch !== 'data' || owners.idOf(parsed.owner) !== workspaceId) return undefined;
    return parsed.key;
}

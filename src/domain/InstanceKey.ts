/**
 * A person is an owner id, and it reaches file paths and namespaces: lower-case letters, digits and dashes, starting
 * with a letter or digit
 */
export function isPersonId(value: string): boolean {
    return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

/** What a test person's id starts with: `test-` and the owner's id */
const TEST_PREFIX = 'test-';

/**
 * The person of an owner's test runs (docs/design/stateui-test-runs.md): the builder's runs of the owner's apps (the
 * tools, the view host, an editor) use the instance of this person, whose shared bindings are copies a reset throws
 * away. No owner id starts with `test-` (they are UUIDs)
 */
export function testPersonOf(ownerId: string): string {
    return `${TEST_PREFIX}${ownerId.toLowerCase()}`;
}

/** The owner whose test person this is, or undefined when the person is not a test person */
export function ownerOfTestPerson(person: string): string | undefined {
    return person.startsWith(TEST_PREFIX) ? person.slice(TEST_PREFIX.length) : undefined;
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

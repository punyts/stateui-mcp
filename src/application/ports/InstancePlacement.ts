import type { Access, Authority, AuthorityConnection, AuthoritySession, Upstream } from '@punyts/state-sync/authority';

/**
 * Where the instances of an app server are ordered when several servers share one database (docs/design/statenet-relays.md,
 * "Topology, in steps", 3; `@punyts/statenet`'s `startOwnerMesh`). Each instance is the namespace of its address
 * (`userStateAddress`), owned by one server at a time under an epoch. The server that owns it runs its authority and
 * saves under its epoch; a view at another server gets a session tunnelled to the owner. Without a placement every
 * instance runs in this process, as on one server
 */
export interface InstancePlacement {
    /**
     * Makes this server the namespace's owner, claiming it from the server that owns it now: for the tools, which act on
     * the instance's authority directly. False when the claim failed (the owner did not hand it over)
     */
    claim(address: string): Promise<boolean>;
    /** The epoch this server owns the namespace under; undefined when it does not own it */
    epochOf(address: string): number | undefined;
    /**
     * A view's session: with the authority `here` gives when this server owns the namespace (or takes it because nobody
     * holds it), tunnelled to the server that owns it otherwise
     */
    connect(address: string, connection: AuthorityConnection, access: Access | undefined, here: () => Promise<Authority>): Promise<AuthoritySession>;
    /** What the relay of `uses.external` subscribes through: it follows each namespace to the server that owns it */
    readonly upstream: Upstream;
}

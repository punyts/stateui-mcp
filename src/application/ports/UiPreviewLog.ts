import type { UiBuildError } from '../../domain/UiBuildError.js';

/** What `UiPreviewLog` knows about the previews of one app */
export interface UiPreviewStatus {
    /** True while at least one view (a browser tab or the headless page) is open */
    readonly attached: boolean;
    readonly lastSeenAt: Date | undefined;
    /** The revision the views last rendered */
    readonly revision: number | undefined;
    /** The bounded runtime error log, oldest first */
    readonly errors: readonly UiBuildError[];
}

/**
 * Presence and runtime error log of the views of an app. The log is bounded: the oldest entries drop first.
 * Both writes return false and store nothing when the app does not exist
 */
export interface UiPreviewLog {
    /** `revision` is the revision the view rendered; absent keeps the one recorded before */
    recordHeartbeat(appId: string, revision: number | undefined, seenAt: Date): Promise<boolean>;
    appendError(appId: string, error: UiBuildError, occurredAt: Date): Promise<boolean>;
    status(appId: string, now: Date): Promise<UiPreviewStatus>;
}

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

/** The view and the load an error came from: a view counts its loads, so a later load can drop what an earlier one left */
export interface UiViewLoad {
    readonly viewId: string;
    /** Goes up each time the view mounts the app again or renders a new revision in place */
    readonly load: number;
}

/**
 * Presence and runtime error log of the views of an app. The log is bounded: the oldest entries drop first.
 * Both writes return false and store nothing when the app does not exist
 */
export interface UiPreviewLog {
    /** `revision` is the revision the view rendered; absent keeps the one recorded before */
    recordHeartbeat(appId: string, revision: number | undefined, seenAt: Date): Promise<boolean>;
    /** `source` is the view load the error came from; an error without one is dropped by the next load of any view */
    appendError(appId: string, error: UiBuildError, source: UiViewLoad | undefined, occurredAt: Date): Promise<boolean>;
    /**
     * A view rendered the app at `source.load`: the errors of its earlier loads and of other views are dropped, as each
     * view reports again what the document still causes
     */
    recordLoad(appId: string, source: UiViewLoad): Promise<boolean>;
    status(appId: string, now: Date): Promise<UiPreviewStatus>;
}

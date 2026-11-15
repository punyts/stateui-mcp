import type { UiViewLoad } from './UiPreviewLog.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';

/**
 * The bounded runtime error log of each app: the newest `MAX_PREVIEW_ERRORS` are kept, oldest first. Each error keeps
 * the view load it came from, so a later load of a view can drop the errors that no longer happen. Nothing is kept for
 * an app that is not stored
 */
export interface UiErrorLog {
    /** False when there is no such app, so nothing is kept for it */
    append(appId: string, error: UiBuildError, source?: UiViewLoad): Promise<boolean>;
    /** Keeps only the errors of `source.viewId` from `source.load` on; false when there is no such app */
    keepFrom(appId: string, source: UiViewLoad): Promise<boolean>;
    list(appId: string): Promise<readonly UiBuildError[]>;
    clear(appId: string): Promise<void>;
}

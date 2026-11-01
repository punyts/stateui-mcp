import type { UiBuildError } from '../../domain/UiBuildError.js';
import type { UiPreviewStatus } from '../ports/UiPreviewLog.js';

/** What `ui_validate` and `ui_state_get` say about the previews of an app. Dates are ISO strings */
export interface UiPreviewDto {
    attached: boolean;
    lastSeenAt: string | undefined;
    /** The revision the preview last rendered */
    revision: number | undefined;
    /** The bounded runtime error log, oldest first */
    errors: UiBuildError[];
}

export function toPreviewDto(status: UiPreviewStatus): UiPreviewDto {
    return {
        attached: status.attached,
        lastSeenAt: status.lastSeenAt?.toISOString(),
        revision: status.revision,
        errors: [...status.errors]
    };
}

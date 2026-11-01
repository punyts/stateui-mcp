import type { JsonObject } from '../../domain/JsonValue.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';

/** What the previews of an app report, as the API returns it: missing values are `null`, dates are ISO strings */
export interface UiAppPreviewResponse {
    attached: boolean;
    lastSeenAt: string | null;
    /** The revision the preview last rendered */
    revision: number | null;
    /** The bounded runtime error log, oldest first */
    errors: UiBuildError[];
}

/**
 * The app as the API returns it. Dates are ISO strings; the document and the snapshot keep their stored key order.
 * `icons` holds the path data of every icon the document uses that the library does not ship in its core set
 */
export interface UiAppResponse {
    id: string;
    name: string;
    revision: number;
    document: JsonObject;
    stateSnapshot: JsonObject;
    preview: UiAppPreviewResponse;
    icons: Record<string, string>;
    createdAt: string;
    updatedAt: string;
}

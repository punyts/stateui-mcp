/** One row of the app list. No document, no snapshot; the date is an ISO string */
export interface UiAppSummaryDto {
    appId: string;
    name: string;
    revision: number;
    updatedAt: string;
}

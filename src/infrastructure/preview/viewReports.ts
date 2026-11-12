import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import { isJsonObject } from '../../domain/JsonValue.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import { isAppId } from '../storage/PartFolders.js';
import type { PreviewHub } from './PreviewHub.js';

/** The most runtime errors one report may carry; earlier ones are dropped */
const MAX_REPORTED_ERRORS = 50;

/** The runtime errors of a report, each cut to its limits; anything that is not an error is left out */
export function toBuildErrors(value: unknown): UiBuildError[] {
    if (!Array.isArray(value)) return [];
    const errors: UiBuildError[] = [];
    for (const item of value.slice(-MAX_REPORTED_ERRORS)) {
        if (!isJsonObject(item) || typeof item['code'] !== 'string' || typeof item['message'] !== 'string') continue;
        const severity = item['severity'];
        errors.push({
            code: item['code'].slice(0, 64),
            message: item['message'].slice(0, 2000),
            ...((severity === 'error' || severity === 'warning') && { severity }),
            ...(typeof item['statePath'] === 'string' && { statePath: item['statePath'].slice(0, 500) }),
            ...(typeof item['component'] === 'string' && { component: item['component'].slice(0, 100) })
        });
    }
    return errors;
}

/** How a view report was taken: `invalid` (with why) or `not-found` (no such app) are refused */
export type ViewReportOutcome = { readonly kind: 'ok' } | { readonly kind: 'invalid'; readonly message: string } | { readonly kind: 'not-found' };

/**
 * What a view tells the server, by whatever way it came (`POST /apps/:appId/report`, or the statenet relay): `ready`
 * and `rendered` with the revision it shows, and `errors`, the runtime errors it raised. Each carries the count of the
 * view's loads, so a ready or rendered report drops the errors earlier loads left
 */
export async function takeViewReport(target: { readonly hub: PreviewHub; readonly useCases: UiBuilderUseCases }, appId: string, body: unknown): Promise<ViewReportOutcome> {
    const { hub, useCases } = target;
    if (!isJsonObject(body) || typeof body['viewId'] !== 'string' || !isAppId(body['viewId'])) return { kind: 'invalid', message: 'A report is a JSON object with a viewId' };
    const viewId = body['viewId'];
    const revision = typeof body['revision'] === 'number' ? body['revision'] : undefined;
    const source = Number.isSafeInteger(body['load']) ? { viewId, load: body['load'] as number } : undefined;
    switch (body['type']) {
        case 'ready':
        case 'rendered':
            hub.touch(appId, viewId, { ...(body['type'] === 'ready' && { ready: true }), ...(revision !== undefined && { revision }) });
            if (source !== undefined) await useCases.recordPreviewLoad.execute(appId, source);
            return { kind: 'ok' };
        case 'errors': {
            const errors = toBuildErrors(body['errors']);
            if (errors.length === 0) return { kind: 'invalid', message: 'An errors report needs at least one error' };
            hub.recordErrors(appId, errors);
            const recorded = await useCases.recordPreviewErrors.execute(appId, errors, revision, source);
            if (recorded.kind === 'not-found') return { kind: 'not-found' };
            hub.touch(appId, viewId);
            return { kind: 'ok' };
        }
        default:
            return { kind: 'invalid', message: 'Unknown report type' };
    }
}

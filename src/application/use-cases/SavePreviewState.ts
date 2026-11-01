import { isJsonObject } from '../../domain/JsonValue.js';
import type { JsonValue } from '../../domain/JsonValue.js';
import { documentBytes, MAX_PREVIEW_SNAPSHOT_BYTES } from '../../domain/limits.js';
import { isRevision } from '../../domain/revision.js';
import type { UiAppRepository } from '../ports/UiAppRepository.js';
import type { UiPreviewLog } from '../ports/UiPreviewLog.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export interface SavePreviewStateInput {
    /** The state snapshot the preview built: `$.data` and the articulation the user changed */
    readonly snapshot: JsonValue;
    /** The revision of the app the preview rendered when it built the snapshot */
    readonly expectedRevision: number;
}

export type SavePreviewStateResult =
    | { readonly kind: 'saved'; readonly appId: string; readonly revision: number }
    /** A tool write or a document edit came after the revision the preview rendered; the snapshot was dropped */
    | { readonly kind: 'conflict'; readonly appId: string; readonly currentRevision: number }
    | { readonly kind: 'invalid'; readonly appId: string; readonly reason: string }
    | { readonly kind: 'not-found'; readonly appId: string };

/**
 * Stores the state snapshot a preview reports, and counts the report as a sign of life. The write is
 * compare-and-set on the revision the preview rendered, so a snapshot older than the latest tool write loses and
 * the preview learns the current revision to re-sync. A saved snapshot leaves the revision as it is (see
 * `UiAppRepository.savePreviewSnapshot`)
 */
export class SavePreviewState {
    constructor(
        private readonly repository: UiAppRepository,
        private readonly previewLog: UiPreviewLog,
        private readonly now: () => Date,
        private readonly report: UseCaseReport
    ) {}

    async execute(appId: string, input: SavePreviewStateInput): Promise<SavePreviewStateResult> {
        if (!isRevision(input.expectedRevision)) {
            return this.finish({ kind: 'invalid', appId, reason: 'expectedRevision must be a positive whole number' });
        }
        if (!isJsonObject(input.snapshot)) {
            return this.finish({ kind: 'invalid', appId, reason: 'The snapshot must be an object' });
        }
        const bytes = documentBytes(input.snapshot);
        if (bytes > MAX_PREVIEW_SNAPSHOT_BYTES) {
            return this.finish({
                kind: 'invalid',
                appId,
                reason: `The snapshot is ${bytes} bytes; the limit is ${MAX_PREVIEW_SNAPSHOT_BYTES}`
            });
        }

        const written = await this.repository.savePreviewSnapshot(appId, input.snapshot, input.expectedRevision);
        if (written.kind === 'not-found') return this.finish({ kind: 'not-found', appId });
        // The preview is open whether or not its snapshot was current
        await this.previewLog.recordHeartbeat(appId, input.expectedRevision, this.now());
        if (written.kind === 'conflict') {
            return this.finish({ kind: 'conflict', appId, currentRevision: written.currentRevision });
        }
        return this.finish({ kind: 'saved', appId, revision: written.revision });
    }

    private finish(result: SavePreviewStateResult): SavePreviewStateResult {
        this.report.info('Preview state snapshot', { appId: result.appId, outcome: result.kind });
        return result;
    }
}

import type { UiFileRepository } from '../../application/ports/UiFileRepository.js';
import type { UiPreviewLog, UiPreviewStatus } from '../../application/ports/UiPreviewLog.js';
import type { UiBuildError } from '../../domain/UiBuildError.js';
import type { FileUiErrorLog } from '../storage/FileUiErrorLog.js';
import type { PreviewHub } from './PreviewHub.js';

/**
 * The preview log over the live views. Presence is real: an app is attached while a view holds its event stream
 * open (the browser tab of a person or the headless page), so there is no heartbeat window to expire. The error
 * log is the one on disk, so it outlives the views and the process
 */
export class LivePreviewLog implements UiPreviewLog {
    constructor(
        private readonly hub: PreviewHub,
        private readonly errors: FileUiErrorLog,
        private readonly files: Pick<UiFileRepository, 'appExists'>
    ) {}

    async recordHeartbeat(appId: string, _revision: number | undefined, _seenAt: Date): Promise<boolean> {
        return this.files.appExists(appId);
    }

    async appendError(appId: string, error: UiBuildError, _occurredAt: Date): Promise<boolean> {
        return this.errors.append(appId, error);
    }

    async status(appId: string, _now: Date): Promise<UiPreviewStatus> {
        const presence = this.hub.presence(appId);
        return {
            attached: presence.attached,
            lastSeenAt: presence.lastSeenAt,
            revision: presence.revision,
            errors: await this.errors.list(appId)
        };
    }
}

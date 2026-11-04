import type { UiStateSnapshot } from '../../domain/UiApp.js';
import type { UiPreviewDto } from '../dtos/UiPreviewDto.js';
import { toPreviewDto } from '../dtos/UiPreviewDto.js';
import type { LiveStateReader } from '../ports/LiveStateReader.js';
import type { UiAppRepository } from '../ports/UiAppRepository.js';
import type { UiPreviewLog } from '../ports/UiPreviewLog.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

export type GetStateResult =
    | {
          readonly kind: 'state';
          readonly appId: string;
          readonly revision: number;
          /** The synced state: `$.data` and the articulation a user or a tool changed */
          readonly state: UiStateSnapshot;
          /** `live`: read from a view that is open now; `stored`: the server's copy, when no view answered */
          readonly source: 'live' | 'stored';
          readonly preview: UiPreviewDto;
      }
    | { readonly kind: 'not-found'; readonly appId: string };

/** The synced state of an app, live from an open view when there is one, with what its previews report, including the bounded runtime error log */
export class GetState {
    constructor(
        private readonly repository: UiAppRepository,
        private readonly previewLog: UiPreviewLog,
        private readonly liveState: LiveStateReader,
        private readonly now: () => Date,
        private readonly report: UseCaseReport
    ) {}

    async execute(appId: string): Promise<GetStateResult> {
        const app = await this.repository.findById(appId);
        if (app === undefined) {
            this.report.info('App state read', { appId, outcome: 'not-found' });
            return { kind: 'not-found', appId };
        }
        const preview = toPreviewDto(await this.previewLog.status(appId, this.now()));
        const live = preview.attached ? await this.liveState.read(appId) : undefined;
        const source = live === undefined ? 'stored' : 'live';
        this.report.info('App state read', { appId, outcome: 'state', source, previewAttached: preview.attached });
        return { kind: 'state', appId, revision: app.revision, state: live ?? app.stateSnapshot, source, preview };
    }
}

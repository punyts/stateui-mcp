import type { UiAppSummaryDto } from '../dtos/UiAppSummaryDto.js';
import type { UiAppRepository } from '../ports/UiAppRepository.js';
import type { UseCaseReport } from '../ports/UseCaseReport.js';

/** Lists the apps, without their documents */
export class ListApps {
    constructor(
        private readonly repository: UiAppRepository,
        private readonly report: UseCaseReport
    ) {}

    async execute(): Promise<readonly UiAppSummaryDto[]> {
        const apps = await this.repository.list();
        this.report.info('Apps listed', { count: apps.length });
        return apps.map((app) => ({
            appId: app.id,
            name: app.name,
            revision: app.revision,
            updatedAt: app.updatedAt.toISOString()
        }));
    }
}

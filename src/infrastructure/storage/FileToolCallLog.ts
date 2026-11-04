import { appendFile } from 'node:fs/promises';
import type { ToolCallEntry, ToolCallLog } from '../../application/ports/ToolCallLog.js';
import type { UseCaseReport } from '../../application/ports/UseCaseReport.js';

/**
 * Appends each entry as one JSON line. Only the entry's own fields are written. A failed append is reported once and
 * swallowed, so a full disk or a bad path never fails a tool call; appends are chained so lines keep the call order
 */
export class FileToolCallLog implements ToolCallLog {
    private reported = false;
    private tail: Promise<void> = Promise.resolve();

    constructor(
        private readonly file: string,
        private readonly report: UseCaseReport
    ) {}

    record(entry: ToolCallEntry): Promise<void> {
        const line = `${JSON.stringify(pick(entry))}\n`;
        this.tail = this.tail.then(() =>
            appendFile(this.file, line, 'utf8').catch((error: unknown) => {
                if (this.reported) return;
                this.reported = true;
                this.report.info('Tool call log write failed', { file: this.file, error: error instanceof Error ? error.message : String(error) });
            })
        );
        return this.tail;
    }
}

/** Copies only the known fields, in a fixed order, so nothing else can reach the file */
function pick(entry: ToolCallEntry): ToolCallEntry {
    return {
        at: entry.at,
        tool: entry.tool,
        ok: entry.ok,
        ...(entry.errorCode !== undefined && { errorCode: entry.errorCode }),
        requestChars: entry.requestChars,
        responseChars: entry.responseChars,
        ...(entry.target !== undefined && { target: entry.target }),
        ...(entry.errorCount !== undefined && { errorCount: entry.errorCount }),
        ...(entry.warningCount !== undefined && { warningCount: entry.warningCount })
    };
}

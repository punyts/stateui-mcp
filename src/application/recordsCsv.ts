import { EXPORT_NAME_PATTERN, EXPORT_SOURCE_PATTERN, exportRecords, readExportRequest, toCsv } from '@punyts/stateui-app/core';
import type { JsonValue } from '../domain/JsonValue.js';
import { isJsonObject } from '../domain/JsonValue.js';
import type { UseCaseReport } from './ports/UseCaseReport.js';

/** The outcome of a CSV export: the file, or a refusal with an HTTP status and a code */
export type RecordsCsv =
    | { kind: 'csv'; name: string; csv: string; rows: number }
    | { kind: 'refused'; status: 400 | 404 | 413; code: 'invalid_export' | 'not_found' | 'too_large'; message: string };

const refused = (status: 400 | 404 | 413, code: 'invalid_export' | 'not_found' | 'too_large', message: string): RecordsCsv => ({ kind: 'refused', status, code, message });

/**
 * Builds the CSV a grid asked for (`fileExport` of the runtime): `body` is `{ source, name, request }`, where `request`
 * is the visible columns, filters and sort (`RecordExportRequest`), never rows. `read` gives the value at `source` in
 * the requesting persona's own instance, so the file holds only records that persona can read; it is called once the
 * body is valid. The CSV starts with a byte order mark, so spreadsheets read it as UTF-8. Logs the app, the source and
 * the row count, never a value
 */
export async function buildRecordsCsv(appId: string, body: unknown, read: (source: string) => Promise<JsonValue | undefined>, report: UseCaseReport): Promise<RecordsCsv> {
    if (!isJsonObject(body) || Object.keys(body).some((key) => key !== 'source' && key !== 'name' && key !== 'request')) return refused(400, 'invalid_export', 'Send { source, name, request }');
    const { source, name } = body;
    if (typeof source !== 'string' || !EXPORT_SOURCE_PATTERN.test(source)) return refused(400, 'invalid_export', 'The source is a path under $.data or $.external');
    if (typeof name !== 'string' || !EXPORT_NAME_PATTERN.test(name)) return refused(400, 'invalid_export', 'The name is a file name ending in .csv');
    const settings = readExportRequest(body['request']);
    if (settings === undefined) return refused(400, 'invalid_export', 'The request names the columns, filters and sort of a grid');
    const result = exportRecords(await read(source), settings);
    if (result.kind === 'not-records') return refused(404, 'not_found', 'No records at this source');
    if (result.kind === 'too-large') return refused(413, 'too_large', 'An export holds at most 100,000 rows');
    report.info('Records exported', { app: appId, source, rows: result.count });
    return { kind: 'csv', name, csv: `﻿${toCsv(result.rows)}`, rows: result.count };
}

/** The headers of a CSV export's answer: an attachment under its name, never cached */
export function csvHeaders(name: string, rows: number): Record<string, string> {
    const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename*=UTF-8''${encoded}`, 'cache-control': 'no-store', 'x-export-rows': String(rows) };
}

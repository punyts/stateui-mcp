#!/usr/bin/env node
// Summarizes tool-call logs (`--tool-log`) for the search-first measurement: one log file per build.
// Usage: node scripts/summarizeToolLog.mjs <calls.jsonl>...
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The tools whose responses count as catalog reading */
export const CATALOG_TOOLS = Object.freeze(['ui_components_list', 'ui_components_search', 'ui_patterns_search', 'ui_component_get', 'ui_icons_list', 'ui_tokens_list']);

const WRITE_SUFFIXES = Object.freeze(['_write', '_create', '_configure', '_rename', '_delete']);

/** A tool that changes something: its name ends in a write suffix, or it is `ui_state_set` */
export function isWriteTool(tool) {
    return tool === 'ui_state_set' || WRITE_SUFFIXES.some((suffix) => tool.endsWith(suffix));
}

/** The entries of one log file; blank lines are skipped, a line that is not JSON throws with its number */
export function parseLog(text) {
    const entries = [];
    text.split(/\r?\n/).forEach((line, index) => {
        if (line.trim() === '') return;
        try {
            entries.push(JSON.parse(line));
        } catch {
            throw new Error(`Line ${index + 1} is not JSON`);
        }
    });
    return entries;
}

/**
 * The three numbers of one build:
 * - catalogTokens: response characters of the catalog tools divided by four, rounded;
 * - failedWrites: write calls with `ok: false`;
 * - firstWriteErrors: the `errorCount` of write calls whose previous write to the same target did not fail
 *   (a retry after a failed write is not a first write)
 */
export function summarize(entries) {
    let catalogChars = 0;
    let failedWrites = 0;
    let firstWriteErrors = 0;
    const lastWriteFailed = new Map();
    for (const entry of entries) {
        if (CATALOG_TOOLS.includes(entry.tool)) catalogChars += entry.responseChars ?? 0;
        if (!isWriteTool(entry.tool)) continue;
        const target = entry.target ?? '';
        if (lastWriteFailed.get(target) !== true) firstWriteErrors += entry.errorCount ?? 0;
        if (entry.ok === false) failedWrites += 1;
        lastWriteFailed.set(target, entry.ok === false);
    }
    return { catalogTokens: Math.round(catalogChars / 4), failedWrites, firstWriteErrors };
}

/** The median and range of each number over several builds */
export function aggregate(summaries) {
    const keys = ['catalogTokens', 'failedWrites', 'firstWriteErrors'];
    return Object.fromEntries(
        keys.map((key) => {
            const values = summaries.map((summary) => summary[key]).sort((a, b) => a - b);
            const middle = Math.floor(values.length / 2);
            const median = values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
            return [key, { median, min: values[0], max: values[values.length - 1] }];
        })
    );
}

function main(files) {
    if (files.length === 0) {
        process.stderr.write('Usage: node scripts/summarizeToolLog.mjs <calls.jsonl>...\n');
        process.exitCode = 2;
        return;
    }
    const summaries = files.map((file) => {
        const summary = summarize(parseLog(readFileSync(file, 'utf8')));
        process.stdout.write(`${file}\tcatalog tokens ${summary.catalogTokens}\tfailed writes ${summary.failedWrites}\tfirst-write errors ${summary.firstWriteErrors}\n`);
        return summary;
    });
    if (summaries.length > 1) {
        const all = aggregate(summaries);
        const cell = ({ median, min, max }) => `${median} (${min}–${max})`;
        process.stdout.write(`median (range)\tcatalog tokens ${cell(all.catalogTokens)}\tfailed writes ${cell(all.failedWrites)}\tfirst-write errors ${cell(all.firstWriteErrors)}\n`);
    }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));

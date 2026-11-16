#!/usr/bin/env node
// Summarizes tool-call logs (`--tool-log`) for the search-first measurement: one log file per build.
// Usage: node scripts/summarizeToolLog.mjs <calls.jsonl>...
// Catalog tokens include the ui_guide answers (also printed apart as guide tokens); tokens read adds the served
// instructions, which the log records once per session.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The tools whose responses count as catalog reading */
export const CATALOG_TOOLS = Object.freeze(['ui_components_list', 'ui_components_search', 'ui_patterns_search', 'ui_component_get', 'ui_icons_list', 'ui_tokens_list']);

/** The guide tool: its answers count with the catalog tokens read, and are also given apart (K1.5 of the guide-tool epic) */
export const GUIDE_TOOL = 'ui_guide';

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
 * The numbers of one build:
 * - catalogTokens: response characters of the catalog tools and of ui_guide divided by four, rounded;
 * - guideTokens: the part of catalogTokens that ui_guide answered (response characters divided by four, rounded);
 * - instructionsTokens: the length of the served instructions divided by four, rounded, counted once per build (the
 *   first instructions line of the log; a log without one counts 0);
 * - tokensRead: instructions plus catalog plus guide tokens, the number the guide-tool gate compares;
 * - failedWrites: write calls with `ok: false`;
 * - firstWriteErrors: the `errorCount` of write calls whose previous write to the same target did not fail
 *   (a retry after a failed write is not a first write)
 */
export function summarize(entries) {
    let catalogChars = 0;
    let guideChars = 0;
    let instructionsChars;
    let failedWrites = 0;
    let firstWriteErrors = 0;
    const lastWriteFailed = new Map();
    for (const entry of entries) {
        if (typeof entry.instructionsChars === 'number') {
            instructionsChars ??= entry.instructionsChars;
            continue;
        }
        if (CATALOG_TOOLS.includes(entry.tool)) catalogChars += entry.responseChars ?? 0;
        if (entry.tool === GUIDE_TOOL) guideChars += entry.responseChars ?? 0;
        if (!isWriteTool(entry.tool)) continue;
        const target = entry.target ?? '';
        if (lastWriteFailed.get(target) !== true) firstWriteErrors += entry.errorCount ?? 0;
        if (entry.ok === false) failedWrites += 1;
        lastWriteFailed.set(target, entry.ok === false);
    }
    const catalogTokens = Math.round((catalogChars + guideChars) / 4);
    const instructionsTokens = Math.round((instructionsChars ?? 0) / 4);
    return { catalogTokens, guideTokens: Math.round(guideChars / 4), instructionsTokens, tokensRead: instructionsTokens + catalogTokens, failedWrites, firstWriteErrors };
}

/** The median and range of each number over several builds */
export function aggregate(summaries) {
    const keys = ['tokensRead', 'instructionsTokens', 'catalogTokens', 'guideTokens', 'failedWrites', 'firstWriteErrors'];
    return Object.fromEntries(
        keys.map((key) => {
            const values = summaries.map((summary) => summary[key]).sort((a, b) => a - b);
            const middle = Math.floor(values.length / 2);
            const median = values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
            return [key, { median, min: values[0], max: values[values.length - 1] }];
        })
    );
}

const LABELS = Object.freeze({
    tokensRead: 'tokens read',
    instructionsTokens: 'instructions tokens',
    catalogTokens: 'catalog tokens',
    guideTokens: 'guide tokens',
    failedWrites: 'failed writes',
    firstWriteErrors: 'first-write errors'
});

/** One printed line: each number with its label, tab separated */
function line(numbers, cell) {
    return Object.entries(LABELS)
        .map(([key, label]) => `${label} ${cell(numbers[key])}`)
        .join('\t');
}

function main(files) {
    if (files.length === 0) {
        process.stderr.write('Usage: node scripts/summarizeToolLog.mjs <calls.jsonl>...\n');
        process.exitCode = 2;
        return;
    }
    const summaries = files.map((file) => {
        const summary = summarize(parseLog(readFileSync(file, 'utf8')));
        process.stdout.write(`${file}\t${line(summary, (value) => value)}\n`);
        return summary;
    });
    if (summaries.length > 1) {
        const all = aggregate(summaries);
        process.stdout.write(`median (range)\t${line(all, ({ median, min, max }) => `${median} (${min}–${max})`)}\n`);
    }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));

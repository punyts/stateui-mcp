import { createReporter } from '@punyts/core';
import type { Reporter } from '@punyts/core';

/**
 * A reporter whose listener writes to stderr and nowhere else. In stdio mode stdout carries the MCP protocol, so a
 * single stray line there would corrupt it: every log line of this server goes through here
 */
export function createStderrReporter(categories: string[] = ['info', 'warning', 'error']): Reporter {
    const reporter = createReporter({ categories });
    reporter.addListener((_timestamp, category, message, details) => {
        const suffix = details === undefined ? '' : ` ${safeJson(details)}`;
        process.stderr.write(`[stateui-mcp] ${category} ${message}${suffix}\n`);
    });
    return reporter;
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value, (_key, item: unknown) => (item instanceof Error ? item.message : item));
    } catch {
        return '[unserializable]';
    }
}

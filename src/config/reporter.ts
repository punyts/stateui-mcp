import { addListener, createReporter, removeListener, setCategories } from '@punyts/core';
import type { ListenerFn, Reporter } from '@punyts/core';

/** The categories `PUNYTS_REPORT` names, a comma-separated list such as `stateui-mcp.*,stateui-app.*`; none when unset */
export function reportCategories(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
    return (env['PUNYTS_REPORT'] ?? '')
        .split(',')
        .map((category) => category.trim())
        .filter((category) => category !== '');
}

/**
 * A reporter whose listener writes to stderr and nowhere else. In stdio mode stdout carries the MCP protocol, so a
 * single stray line there would corrupt it: every log line of this server goes through here. It takes the categories
 * of `PUNYTS_REPORT` besides its own
 */
export function createStderrReporter(categories: string[] = ['info', 'warning', 'error', ...reportCategories()]): Reporter {
    const reporter = createReporter({ categories });
    reporter.addListener(writeLine);
    return reporter;
}

/**
 * Listens to `@punyts/core`'s default reporter, where the libraries and stateui-mcp's `stateui-mcp.*` areas report:
 * warnings, errors and the categories of `PUNYTS_REPORT` go to stderr in the line format of `createStderrReporter`.
 * Returns the function that stops listening
 */
export function listenToLibraries(env: Readonly<Record<string, string | undefined>> = process.env): () => void {
    const categories = ['warning', 'error', ...reportCategories(env)];
    setCategories(categories);
    addListener(writeLine, categories);
    return () => removeListener(writeLine, categories);
}

const writeLine: ListenerFn = (_timestamp, category, message, details) => {
    const suffix = details === undefined ? '' : ` ${safeJson(details)}`;
    process.stderr.write(`[stateui-mcp] ${category} ${message}${suffix}\n`);
};

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value, (_key, item: unknown) => (item instanceof Error ? item.message : item));
    } catch {
        return '[unserializable]';
    }
}


export interface ToolLogEntry {
    readonly at?: string;
    readonly tool: string;
    readonly ok: boolean;
    readonly errorCode?: string;
    readonly requestChars?: number;
    readonly responseChars?: number;
    readonly target?: string;
    readonly errorCount?: number;
    readonly warningCount?: number;
}

export interface BuildSummary {
    readonly catalogTokens: number;
    readonly failedWrites: number;
    readonly firstWriteErrors: number;
}

export interface Spread {
    readonly median: number;
    readonly min: number;
    readonly max: number;
}

export declare const CATALOG_TOOLS: readonly string[];
export declare function isWriteTool(tool: string): boolean;
export declare function parseLog(text: string): ToolLogEntry[];
export declare function summarize(entries: readonly ToolLogEntry[]): BuildSummary;
export declare function aggregate(summaries: readonly BuildSummary[]): Record<keyof BuildSummary, Spread>;

export interface ToolLogEntry {
    readonly at?: string;
    /** Absent on the instructions line */
    readonly tool?: string;
    readonly ok?: boolean;
    /** Only on the instructions line, which the server writes once per session */
    readonly instructionsChars?: number;
    readonly errorCode?: string;
    readonly requestChars?: number;
    readonly responseChars?: number;
    readonly target?: string;
    readonly errorCount?: number;
    readonly warningCount?: number;
}

export interface BuildSummary {
    readonly tokensRead: number;
    readonly instructionsTokens: number;
    readonly catalogTokens: number;
    readonly guideTokens: number;
    readonly failedWrites: number;
    readonly firstWriteErrors: number;
}

export interface Spread {
    readonly median: number;
    readonly min: number;
    readonly max: number;
}

export declare const CATALOG_TOOLS: readonly string[];
export declare const GUIDE_TOOL: string;
export declare function isWriteTool(tool: string): boolean;
export declare function parseLog(text: string): ToolLogEntry[];
export declare function summarize(entries: readonly ToolLogEntry[]): BuildSummary;
export declare function aggregate(summaries: readonly BuildSummary[]): Record<keyof BuildSummary, Spread>;

/** One tool call as the tool-call log records it: the tool, the outcome and sizes, never arguments or bodies */
export interface ToolCallEntry {
    /** ISO time the call finished */
    readonly at: string;
    readonly tool: string;
    readonly ok: boolean;
    /** The `error` of a failed result */
    readonly errorCode?: string;
    /** Length of the JSON arguments */
    readonly requestChars: number;
    /** Length of the result's text content; images are not counted */
    readonly responseChars: number;
    /** The app the call is about: `appId`, or `app` with `/` and `screen`, at most 80 characters */
    readonly target?: string;
    readonly errorCount?: number;
    readonly warningCount?: number;
}

/** Where tool calls are recorded for measurement. Recording never fails a call */
export interface ToolCallLog {
    record(entry: ToolCallEntry): Promise<void>;
}

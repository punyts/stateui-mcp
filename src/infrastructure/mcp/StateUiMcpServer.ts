import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
import type { ToolCallEntry, ToolCallLog } from '../../application/ports/ToolCallLog.js';
import type { UseCaseReport } from '../../application/ports/UseCaseReport.js';
import type { PreviewBrowser } from '../preview/BrowserPreview.js';
import type { LiveViews } from '../preview/LiveViews.js';
import type { PreviewHub } from '../preview/PreviewHub.js';
import type { AppCalls } from '../sync/AppCalls.js';
import type { AppAuthorities } from '../sync/AppAuthorities.js';
import { createAppTools } from './appTools.js';
import { createCatalogTools } from './catalogTools.js';
import { createDeleteTools } from './deleteTools.js';
import { createFileTools } from './fileTools.js';
import { SERVER_INSTRUCTIONS, START_HERE } from './instructions.js';
import { createLiveTools } from './liveTools.js';
import { createNodeTools } from './nodeTools.js';
import { createThemeTools } from './themeTools.js';
import { createPartAppTools } from './partAppTools.js';
import { createPartTools } from './partTools.js';
import { fail } from './toolKit.js';
import type { ToolOutcome, UiToolDefinition } from './toolKit.js';
import { createWriteTools } from './writeTools.js';

export const STATEUI_MCP_SERVER_NAME = 'stateui-mcp';
export const STATEUI_MCP_VERSION = '0.1.0';

/** What the tools run on: the use cases, the live views and the headless browser */
export interface StateUiToolDependencies {
    readonly useCases: UiBuilderUseCases;
    readonly hub: PreviewHub;
    readonly liveViews: LiveViews;
    readonly browser: PreviewBrowser;
    /** The calls of Full-mode logic that wait for the agent's answer */
    readonly calls: Pick<AppCalls, 'answer'>;
    /** The apps' server-side logic, for ui_logic_trace */
    readonly authorities?: Pick<AppAuthorities, 'trace' | 'clearTrace'>;
    /** The address a person opens for an app */
    readonly viewUrl: (appId: string) => string;
    readonly report: UseCaseReport;
    /** Records every tool call for measurement; absent: nothing is recorded */
    readonly toolCallLog?: ToolCallLog;
}

const START_HERE_TOOLS = new Set(['ui_components_list', 'ui_app_create']);

/** Every tool of the server: catalog, lifecycle and reads, the generic part tools, writes, the live tools, `ui_file_read` and `ui_app_delete` */
export function createStateUiTools(dependencies: StateUiToolDependencies): readonly UiToolDefinition[] {
    const { useCases, hub, liveViews, browser, viewUrl, calls, authorities } = dependencies;
    const tools = [
        ...createCatalogTools(useCases),
        ...createAppTools(useCases, browser),
        ...createPartTools(useCases, liveViews),
        ...createPartAppTools(useCases),
        ...createNodeTools(useCases),
        ...createThemeTools(useCases),
        ...createWriteTools(useCases, liveViews),
        ...createLiveTools({ useCases, hub, liveViews, browser, viewUrl, calls, ...(authorities !== undefined && { logic: authorities }) }),
        ...createFileTools(useCases),
        ...createDeleteTools(useCases, liveViews)
    ];
    return tools.map((tool) => (START_HERE_TOOLS.has(tool.name) ? { ...tool, description: `${tool.description} ${START_HERE}` } : tool));
}

const MAX_TARGET = 80;

/** The app a call is about: `appId`, or `app` with `/` and `screen` */
function targetOf(args: Readonly<Record<string, unknown>>): string | undefined {
    const appId = args['appId'];
    if (typeof appId === 'string') return appId.slice(0, MAX_TARGET);
    const app = args['app'];
    if (typeof app !== 'string') return undefined;
    const screen = args['screen'];
    return (typeof screen === 'string' ? `${app}/${screen}` : app).slice(0, MAX_TARGET);
}

/** What the tool-call log keeps of one call: sizes and counts, never the arguments or the body */
function logEntry(tool: string, args: Readonly<Record<string, unknown>>, outcome: ToolOutcome, content: CallContent): ToolCallEntry {
    const body = outcome.body as Record<string, unknown>;
    const errorCode = outcome.isError && typeof body['error'] === 'string' ? body['error'] : undefined;
    const target = targetOf(args);
    const errors = body['errors'];
    const warnings = body['warnings'];
    return {
        at: new Date().toISOString(),
        tool,
        ok: !outcome.isError,
        ...(errorCode !== undefined && { errorCode }),
        requestChars: JSON.stringify(args).length,
        responseChars: content.content.reduce((total, item) => total + (item.type === 'text' ? item.text.length : 0), 0),
        ...(target !== undefined && { target }),
        ...(Array.isArray(errors) && { errorCount: errors.length }),
        ...(Array.isArray(warnings) && { warningCount: warnings.length })
    };
}

interface CallContent {
    content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
    isError: boolean;
}

function toContent(outcome: ToolOutcome): { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError: boolean } {
    return {
        content: [
            { type: 'text', text: JSON.stringify(outcome.body) },
            ...(outcome.images ?? []).map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType }))
        ],
        isError: outcome.isError
    };
}

/**
 * The MCP server: protocol-pure, built with the vanilla SDK over the use cases. It has no caller context: it is
 * one local user's server, so there are no workspaces, users or approval steps. Tool schemas are JSON Schemas from one
 * field table that also checks the arguments (the low-level server does not enforce schemas)
 */
export function createStateUiMcpServer(dependencies: StateUiToolDependencies): Server {
    const tools = createStateUiTools(dependencies);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const server = new Server(
        { name: STATEUI_MCP_SERVER_NAME, version: STATEUI_MCP_VERSION },
        { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations
        }))
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name } = request.params;
        const args = request.params.arguments ?? {};
        const outcome = await runTool(name, args);
        const content = toContent(outcome);
        // Not awaited: the log never slows or fails a call (a failed append is reported by the adapter)
        void dependencies.toolCallLog?.record(logEntry(name, args, outcome, content));
        return content;
    });

    async function runTool(name: string, args: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
        const tool = byName.get(name);
        if (tool === undefined) return fail('unknown-tool', `Unknown tool: ${name}`);
        try {
            return await tool.run(args);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            dependencies.report.info('Tool failed', { tool: name, error: message });
            return fail('internal-error', message);
        }
    }

    return server;
}

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { UiBuilderUseCases } from '../../config/createUiBuilder.js';
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
}

const START_HERE_TOOLS = new Set(['ui_components_list', 'ui_app_create']);

/** Every tool of the server: catalog, lifecycle and reads, writes, the live tools, `ui_file_read` and `ui_app_delete` */
export function createStateUiTools(dependencies: StateUiToolDependencies): readonly UiToolDefinition[] {
    const { useCases, hub, liveViews, browser, viewUrl, calls, authorities } = dependencies;
    const tools = [
        ...createCatalogTools(useCases),
        ...createAppTools(useCases, browser),
        ...createWriteTools(useCases, liveViews),
        ...createLiveTools({ useCases, hub, liveViews, browser, viewUrl, calls, ...(authorities !== undefined && { logic: authorities }) }),
        ...createFileTools(useCases),
        ...createDeleteTools(useCases, liveViews)
    ];
    return tools.map((tool) => (START_HERE_TOOLS.has(tool.name) ? { ...tool, description: `${tool.description} ${START_HERE}` } : tool));
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
        const { name, arguments: args } = request.params;
        const tool = byName.get(name);
        if (tool === undefined) return toContent(fail('unknown-tool', `Unknown tool: ${name}`));
        try {
            return toContent(await tool.run(args ?? {}));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            dependencies.report.info('Tool failed', { tool: name, error: message });
            return toContent(fail('internal-error', message));
        }
    });

    return server;
}

import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import { createMCPToolName } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { TSchema } from "@oh-my-pi/pi-ai";
import { normalizeSchemaForMCP } from "@oh-my-pi/pi-ai/utils/schema";
import { renderMcpResult, isJsonRecord } from "./render";
import { slackCore } from "./core";
import { SLACK_SERVER_NAME, type SlackCore } from "./types";

/** Drop harness-only fields the Slack schema does not declare, and empty optional placeholders. */
export function outboundArguments(params: unknown, inputSchema: MCPToolDefinition["inputSchema"]): Record<string, unknown> {
	if (!isJsonRecord(params)) return {};
	const properties = isJsonRecord(inputSchema.properties) ? inputSchema.properties : {};
	const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : []);
	const args: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(params)) {
		if (!(key in properties) && key === "i") continue;
		if (value === undefined || (value === null && !required.has(key))) continue;
		args[key] = value;
	}
	return args;
}

/** One OMP tool per ChatGPT Slack app tool, named as a native `slack` MCP server would mint it. */
export function slackToolDefinition(tool: MCPToolDefinition, core: SlackCore = slackCore): ToolDefinition {
	// The MCP inputSchema is JSON Schema; OMP accepts normalized JSON Schema where a TSchema is expected.
	const parameters = normalizeSchemaForMCP(tool.inputSchema) as TSchema;
	return {
		name: createMCPToolName(SLACK_SERVER_NAME, tool.name),
		label: `${SLACK_SERVER_NAME}/${tool.name}`,
		description: tool.description ?? `Slack tool ${tool.name}`,
		parameters,
		loadMode: "discoverable",
		approval: "write",
		strict: false,
		mcpServerName: SLACK_SERVER_NAME,
		mcpToolName: tool.name,
		...(tool.annotations?.readOnlyHint === undefined ? {} : { mcpReadOnlyHint: tool.annotations.readOnlyHint }),
		async execute(_toolCallId, params, signal) {
			const result = await core.callTool(tool.name, outboundArguments(params, tool.inputSchema), signal);
			return {
				content: [{ type: "text", text: renderMcpResult(result) }],
				details: result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent },
				...(result.isError ? { isError: true } : {}),
			};
		},
	};
}

export interface SlackToolRegistry {
	/** Register any Slack app tools not yet registered; returns how many the connector exposes. */
	sync(signal?: AbortSignal): Promise<number>;
}

export function registerSlackTools(pi: ExtensionAPI, core: SlackCore = slackCore): SlackToolRegistry {
	const registered = new Set<string>();
	return {
		async sync(signal) {
			const tools = await core.listTools(signal);
			for (const tool of tools) {
				if (registered.has(tool.name)) continue;
				pi.registerTool(slackToolDefinition(tool, core));
				registered.add(tool.name);
			}
			return tools.length;
		},
	};
}

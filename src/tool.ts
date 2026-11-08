import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import { openPath } from "@oh-my-pi/pi-coding-agent/utils/open";
import slackToolDescription from "./prompts/slack-tool.md" with { type: "text" };
import { findSlackTool, slackCore } from "./core";
import {
	renderMcpResult,
	renderSlackToolList,
	renderSlackToolSchema,
	renderSlackWorkspaces,
	slackToolDisplayName,
} from "./render";
import type { SlackAuthPresenter, SlackCore } from "./types";

export type SlackToolOperation = "call" | "tools" | "schema" | "workspaces" | "login";

export interface SlackToolInput {
	op?: SlackToolOperation;
	tool?: string;
	args?: Record<string, unknown>;
}

export interface SlackToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: { structuredContent?: unknown };
	isError?: boolean;
}

function textResult(text: string): SlackToolResult {
	return { content: [{ type: "text", text }], details: {} };
}

async function requireTool(core: SlackCore, name: string | undefined, operation: string, signal?: AbortSignal): Promise<MCPToolDefinition> {
	const requested = name?.trim();
	if (!requested) throw new Error(`Slack "${operation}" operation requires a tool name.`);
	const tools = await core.listTools(signal);
	const tool = findSlackTool(tools, requested);
	if (!tool) {
		throw new Error(
			`The ChatGPT Slack app has no tool "${requested}". Available tools: ${tools.map(slackToolDisplayName).join(", ") || "none"}.`,
		);
	}
	return tool;
}

/** Dispatch one `xd://slack` operation; the gateway is contacted only when an operation needs it. */
export async function executeSlackOperation(
	core: SlackCore,
	input: SlackToolInput,
	presenter?: SlackAuthPresenter,
	signal?: AbortSignal,
): Promise<SlackToolResult> {
	switch (input.op ?? "call") {
		case "workspaces":
			return textResult(renderSlackWorkspaces(await core.listWorkspaces(signal)));
		case "login": {
			if (!presenter) throw new Error("ChatGPT sign-in cannot be presented here; have the user run `/slack login`.");
			const account = await core.login(presenter);
			const workspaces = await core.listWorkspaces(signal);
			return textResult(`Signed in to ChatGPT as ${account.email ?? account.accountId}.\n${renderSlackWorkspaces(workspaces)}`);
		}
		case "tools":
			return textResult(renderSlackToolList(await core.listTools(signal)));
		case "schema":
			return textResult(renderSlackToolSchema(await requireTool(core, input.tool, "schema", signal)));
		case "call": {
			const tool = await requireTool(core, input.tool, "call", signal);
			const result = await core.callTool(tool.name, input.args ?? {}, signal);
			return {
				content: [{ type: "text", text: renderMcpResult(result) }],
				details: result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent },
				...(result.isError ? { isError: true } : {}),
			};
		}
	}
}

/** One discoverable `xd://slack` device; no Slack tool schemas enter context until the model asks for them. */
export function registerSlackTool(pi: ExtensionAPI, core: SlackCore = slackCore): void {
	const z = pi.zod;
	pi.registerTool({
		name: "slack",
		label: "Slack",
		description: slackToolDescription.trim(),
		loadMode: "discoverable",
		approval: "write",
		parameters: z
			.object({
				op: z.enum(["call", "tools", "schema", "workspaces", "login"]).default("call"),
				tool: z.string().optional().describe("Slack tool name, e.g. slack_search_public; required for call and schema."),
				args: z.record(z.string(), z.unknown()).optional().describe("Arguments for the named tool, per its schema."),
			})
			.strict(),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const presenter: SlackAuthPresenter = {
				onAuthUrl(url, instructions) {
					ctx.ui.notify(`${instructions ? `${instructions}\n\n` : ""}${url}`, "info");
					openPath(url);
				},
				onProgress: message => ctx.ui.notify(message, "info"),
				...(signal ? { signal } : {}),
			};
			return executeSlackOperation(core, params, presenter, signal);
		},
	});
}

import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { openPath } from "@oh-my-pi/pi-coding-agent/utils/open";
import slackToolDescription from "./prompts/slack-tool.md" with { type: "text" };
import { renderMcpResult, renderSlackToolList, renderSlackToolSchema, renderSlackWorkspaces } from "./render";
import { slackCore } from "./core";
import type { SlackAuthPresenter, SlackCore } from "./types";

export type SlackToolOperation = "call" | "tools" | "schema" | "workspaces" | "connect";

export interface SlackToolInput {
	op?: SlackToolOperation;
	tool?: string;
	args?: Record<string, unknown>;
	workspace?: string;
	team?: string;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

function authPresenter(
	notify: (message: string, type?: "info" | "warning" | "error") => void,
	signal?: AbortSignal,
): SlackAuthPresenter {
	return {
		onAuthUrl(url, instructions) {
			notify(`${instructions ? `${instructions}\n\n` : ""}${url}`, "info");
			openPath(url);
		},
		onProgress(message) {
			notify(message, "info");
		},
		...(signal ? { signal } : {}),
	};
}

/** Dispatch a Slack tool operation independently of extension registration. */
export async function executeSlackOperation(
	core: SlackCore,
	storage: AuthStorage,
	input: SlackToolInput,
	presenter?: SlackAuthPresenter,
	signal?: AbortSignal,
	onWorkspaceChanged?: (storage: AuthStorage) => Promise<void>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
	const operation = input.op ?? "call";
	switch (operation) {
		case "workspaces":
			return textResult(renderSlackWorkspaces(await core.listWorkspaces(storage)));
		case "connect": {
			if (!presenter) throw new Error("Slack OAuth presentation is unavailable in this context.");
			const workspace = await core.connectWorkspace(storage, presenter, input.team ? { team: input.team } : undefined);
			await onWorkspaceChanged?.(storage);
			return textResult(renderSlackWorkspaces([workspace]));
		}
		case "tools": {
			const workspace = await core.resolveWorkspace(storage, input.workspace);
			const tools = await core.listTools(storage, workspace, signal);
			return textResult(renderSlackToolList(tools));
		}
		case "schema": {
			const toolName = input.tool?.trim();
			if (!toolName) throw new Error('Slack "schema" operation requires a tool name.');
			const workspace = await core.resolveWorkspace(storage, input.workspace);
			const tools = await core.listTools(storage, workspace, signal);
			const tool = tools.find(candidate => candidate.name === toolName);
			if (!tool) {
				throw new Error(
					`Slack MCP tool "${toolName}" was not found. Available tools: ${tools.map(candidate => candidate.name).join(", ") || "none"}.`,
				);
			}
			return textResult(renderSlackToolSchema(tool));
		}
		case "call": {
			const toolName = input.tool?.trim();
			if (!toolName) throw new Error('Slack "call" operation requires a tool name.');
			const workspace = await core.resolveWorkspace(storage, input.workspace);
			const result = await core.callTool(storage, workspace, toolName, input.args ?? {}, signal);
			return textResult(renderMcpResult(result));
		}
	}
}
export function registerSlackTool(
	pi: ExtensionAPI,
	core: SlackCore = slackCore,
	onWorkspaceChanged?: (storage: AuthStorage) => Promise<void>,
): void {
	const z = pi.zod;
	pi.registerTool({
		name: "slack",
		label: "Slack",
		description: slackToolDescription.trim(),
		loadMode: "discoverable",
		approval: "write",
		parameters: z.object({
			op: z.enum(["call", "tools", "schema", "workspaces", "connect"]).default("call"),
			tool: z.string().optional().describe("Slack MCP tool name; required for call and schema."),
			args: z.record(z.string(), z.unknown()).optional().describe("Arguments passed to the named Slack MCP tool."),
			workspace: z.string().optional().describe("Workspace team ID, name, or domain; omitted uses the default."),
			team: z.string().optional().describe("Optional team ID to constrain an OAuth login."),
		}).strict(),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeSlackOperation(
				core,
				ctx.modelRegistry.authStorage,
				params,
				authPresenter((message, type) => ctx.ui.notify(message, type), signal),
				signal,
				params.op === "connect" ? onWorkspaceChanged : undefined,
			);
		},
	});
}


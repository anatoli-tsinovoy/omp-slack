import { SlackGatewayClient, type SlackGatewayOptions } from "./client";
import { ChatGPTAuth, type ChatGPTAuthOptions } from "./credentials";
import { mcpRecords, renderMcpResult } from "./render";
import type { SlackCore, SlackWorkspace } from "./types";

export interface SlackCoreOptions {
	auth?: ChatGPTAuthOptions;
	gateway?: SlackGatewayOptions;
}

/** Gateway tool names may carry a connector prefix (`slack.slack_read_channel`); match on the Slack tool name. */
export function findSlackTool<T extends { name: string }>(tools: readonly T[], name: string): T | undefined {
	return tools.find(tool => tool.name === name || tool.name.endsWith(`.${name}`));
}

function text(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

export function createSlackCore(options: SlackCoreOptions = {}): SlackCore {
	const auth = new ChatGPTAuth(options.auth);
	const gateway = new SlackGatewayClient(auth, options.gateway);
	let workspaces: Promise<SlackWorkspace[]> | undefined;

	async function loadWorkspaces(signal?: AbortSignal): Promise<SlackWorkspace[]> {
		const tools = await gateway.listTools(signal);
		const tool = findSlackTool(tools, "slack_list_workspaces");
		if (!tool) throw new Error("The ChatGPT Slack app does not expose `slack_list_workspaces`.");
		const result = await gateway.callTool(tool.name, {}, signal);
		if (result.isError) throw new Error(renderMcpResult(result));
		const records = mcpRecords(result, ["teams", "workspaces"]) ?? [];
		return records.flatMap(record => {
			const teamId = text(record, ["id", "team_id"]);
			const teamName = text(record, ["name", "team_name"]);
			return teamId ? [{ teamId, teamName: teamName ?? teamId }] : [];
		});
	}

	const core: SlackCore = {
		account: () => auth.account(),
		async login(presenter) {
			const account = await auth.login(presenter);
			workspaces = undefined;
			await gateway.reset();
			return account;
		},
		async logout() {
			workspaces = undefined;
			await gateway.reset();
			await auth.logout();
		},
		listTools: signal => gateway.listTools(signal),
		callTool: (tool, args, signal) => gateway.callTool(tool, args, signal),
		listWorkspaces(signal) {
			if (!workspaces) {
				const pending = loadWorkspaces(signal);
				workspaces = pending;
				pending.catch(() => {
					if (workspaces === pending) workspaces = undefined;
				});
			}
			return workspaces;
		},
		closeAll: () => gateway.closeAll(),
	};
	return core;
}

export const slackCore: SlackCore = createSlackCore();

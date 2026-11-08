import { expect, test } from "bun:test";
import { parseInternalUrl, type ProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { MCPToolCallResult, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import { createSlackProtocolHandler, parseSlackUrlString, searchKeywords } from "../src/protocol";
import type { ChatGPTAccount, SlackCore, SlackWorkspace } from "../src/types";

const workspace: SlackWorkspace = { teamId: "T123", teamName: "Acme" };
/** The gateway prefixes connector tool names; URL routes must still find them. */
const GATEWAY_PREFIX = "slack.";
const SLACK_TOOLS = [
	"slack_list_user_channels",
	"slack_search_channels",
	"slack_read_channel",
	"slack_read_thread",
	"slack_read_user_profile",
	"slack_read_canvas",
	"slack_read_file",
	"slack_search_public",
	"slack_search_public_and_private",
];

interface ToolCall {
	name: string;
	args: Record<string, unknown>;
}

function jsonResult(value: unknown): MCPToolCallResult {
	return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

class FakeSlackCore implements SlackCore {
	calls: ToolCall[] = [];
	responses = new Map<string, MCPToolCallResult>();
	availableTools: MCPToolDefinition[] = SLACK_TOOLS.map(name => ({ name: GATEWAY_PREFIX + name, inputSchema: { type: "object" } }));

	async account(): Promise<ChatGPTAccount | undefined> {
		return { accountId: "acct", expires: Number.MAX_SAFE_INTEGER };
	}
	async login(): Promise<ChatGPTAccount> {
		return { accountId: "acct", expires: Number.MAX_SAFE_INTEGER };
	}
	async logout(): Promise<void> {}
	async listWorkspaces(): Promise<SlackWorkspace[]> {
		return [workspace];
	}
	async resolveWorkspace(selector?: string): Promise<SlackWorkspace> {
		if (selector && selector !== "T123" && selector !== "Acme") throw new Error(`Unknown workspace ${selector}`);
		return workspace;
	}
	async callTool(tool: string, args: Record<string, unknown>): Promise<MCPToolCallResult> {
		const name = tool.slice(GATEWAY_PREFIX.length);
		this.calls.push({ name, args });
		return this.responses.get(name) ?? { content: [{ type: "text", text: "ok" }] };
	}
	async listTools(): Promise<MCPToolDefinition[]> {
		return this.availableTools;
	}
	async closeAll(): Promise<void> {}
}

function createHandler(core: FakeSlackCore): ProtocolHandler {
	return createSlackProtocolHandler(core);
}

test("Slack URL parsing distinguishes documented route shapes", () => {
	expect(parseSlackUrlString("slack://T123")).toEqual({ kind: "workspace", selector: "T123" });
	expect(parseSlackUrlString("slack://T123/channels/general?limit=12&oldest=1.2&latest=3.4")).toEqual({
		kind: "channel",
		workspace: "T123",
		channel: "general",
		limit: 12,
		oldest: "1.2",
		latest: "3.4",
	});
	expect(parseSlackUrlString("slack://T123/threads/C999/1700.5")).toEqual({
		kind: "thread",
		workspace: "T123",
		channel: "C999",
		ts: "1700.5",
	});
	expect(parseSlackUrlString("slack://T123/users/me")).toEqual({ kind: "user", workspace: "T123", userId: "me" });
	expect(parseSlackUrlString("slack://T123/canvases/F001")).toEqual({ kind: "canvas", workspace: "T123", canvasId: "F001" });
	expect(parseSlackUrlString("slack://T123/files/F002")).toEqual({ kind: "file", workspace: "T123", fileId: "F002" });
	expect(parseSlackUrlString("slack://T123/search?q=budget&scope=all&type=files")).toEqual({
		kind: "search",
		workspace: "T123",
		query: "budget",
		scope: "all",
		type: "files",
	});
	expect(parseSlackUrlString("slack://")).toEqual({ kind: "workspaces" });
});

test("channel names resolve through Slack channel search once and history renders thread hints", async () => {
	const core = new FakeSlackCore();
	core.responses.set("slack_search_channels", jsonResult({ channels: [{ id: "C999", name: "general" }] }));
	core.responses.set(
		"slack_read_channel",
		jsonResult({
			messages: [
				{ ts: "1700.5", user: "U456", text: "Release is ready", reply_count: 2 },
				{ ts: "1700.6", user_name: "Rae", text: "Thanks", reply_count: 0 },
			],
		}),
	);
	const handler = createHandler(core);
	const url = "slack://T123/channels/%23General?limit=12&oldest=1.2&latest=3.4";

	const history = await handler.resolve(parseInternalUrl(url));
	const repeated = await handler.resolve(parseInternalUrl(url));
	expect(core.calls.filter(call => call.name === "slack_search_channels")).toHaveLength(1);
	expect(core.calls.filter(call => call.name === "slack_read_channel")).toHaveLength(2);
	expect(core.calls[0]).toEqual({
		name: "slack_search_channels",
		args: { keywords: ["general"], natural_language_query: "general", channel_types: "public_channel,private_channel" },
	});
	expect(core.calls[1]).toEqual({
		name: "slack_read_channel",
		args: { channel_id: "C999", limit: 12, oldest: "1.2", latest: "3.4" },
	});
	expect(history.content).toContain("Release is ready");
	expect(history.content).toContain("**U456** (replies: 2)");
	expect(history.content).toContain("slack://T123/threads/C999/1700.5");
	expect(repeated.content).toContain("Thanks");
});

test("thread, profile, canvas, file, and search routes send the connector's argument shapes", async () => {
	const core = new FakeSlackCore();
	const handler = createHandler(core);
	core.responses.set("slack_read_thread", jsonResult({ messages: [{ ts: "1700.5", user: "U456", text: "Thread reply" }] }));

	const thread = await handler.resolve(parseInternalUrl("slack://T123/threads/C999/1700.5"));
	await handler.resolve(parseInternalUrl("slack://T123/users/me"));
	await handler.resolve(parseInternalUrl("slack://T123/users/U999"));
	await handler.resolve(parseInternalUrl("slack://T123/canvases/F001"));
	await handler.resolve(parseInternalUrl("slack://T123/files/F002"));
	await handler.resolve(parseInternalUrl('slack://T123/search?q=%22launch%20plan%22%20budget&scope=all&type=files'));
	await handler.resolve(parseInternalUrl("slack://T123/search?q=budget"));

	expect(core.calls).toEqual([
		{ name: "slack_read_thread", args: { channel_id: "C999", message_ts: "1700.5" } },
		{ name: "slack_read_user_profile", args: {} },
		{ name: "slack_read_user_profile", args: { user_id: "U999" } },
		{ name: "slack_read_canvas", args: { canvas_id: "F001" } },
		{ name: "slack_read_file", args: { file_id: "F002" } },
		{
			name: "slack_search_public_and_private",
			args: { keywords: ['"launch plan"', "budget"], natural_language_query: '"launch plan" budget', content_types: "files" },
		},
		{ name: "slack_search_public", args: { keywords: ["budget"], natural_language_query: "budget" } },
	]);
	expect(thread.content).toContain("# Slack thread");
	expect(thread.content).toContain("Thread reply");
	expect(thread.content).toContain("slack://T123/threads/C999/1700.5");
});

test("directory traversal is bounded and channel listings are scoped to the workspace", async () => {
	const core = new FakeSlackCore();
	core.responses.set("slack_list_user_channels", jsonResult({ channels: [{ id: "C999", name: "general" }] }));
	const handler = createHandler(core);
	const readDirectory = handler.readDirectory;
	if (!readDirectory) throw new Error("Slack protocol should expose directory reads");

	const root = await handler.resolve(parseInternalUrl("slack://"));
	const rootEntries = await readDirectory(parseInternalUrl("slack://"));
	const workspaceEntries = await readDirectory(parseInternalUrl("slack://T123/"));
	const channelEntries = await readDirectory(parseInternalUrl("slack://T123/channels/"));
	const enumerated = await handler.enumerate?.(parseInternalUrl("slack://T123/channels/C999"));
	const crawl = await handler.enumerate?.(parseInternalUrl("slack://"));

	expect(root.content).toContain("Acme (T123)");
	expect(rootEntries.map(entry => entry.name)).toEqual(["Acme (T123)"]);
	expect(workspaceEntries.map(entry => entry.name)).toEqual(["channels", "users", "search"]);
	expect(channelEntries.map(entry => entry.name)).toEqual(["general (C999)"]);
	expect(core.calls[0]).toEqual({ name: "slack_list_user_channels", args: { limit: 200, team_id: "T123" } });
	expect(enumerated).toHaveLength(1);
	expect(crawl).toEqual([]);
});

test("a missing connector tool and a Slack error result both surface as errors", async () => {
	const core = new FakeSlackCore();
	core.availableTools = [];
	const readDirectory = createHandler(core).readDirectory;
	if (!readDirectory) throw new Error("Slack protocol should expose directory reads");
	await expect(readDirectory(parseInternalUrl("slack://T123/channels/"))).rejects.toThrow(
		"does not expose `slack_list_user_channels`",
	);

	const failing = new FakeSlackCore();
	failing.responses.set("slack_read_canvas", { content: [{ type: "text", text: "canvas_not_found" }], isError: true });
	await expect(createHandler(failing).resolve(parseInternalUrl("slack://T123/canvases/F404"))).rejects.toThrow("canvas_not_found");
});

test("search keywords keep quoted phrases whole", () => {
	expect(searchKeywords('"project alpha" status  update')).toEqual(['"project alpha"', "status", "update"]);
	expect(searchKeywords("   ")).toEqual([]);
});

test("malformed Slack URLs explain the expected route or query", () => {
	expect(() => parseSlackUrlString("slack://T123/threads/C999")).toThrow("threads/<channel>/<ts>");
	expect(() => parseSlackUrlString("slack://T123/search?q=")).toThrow("non-empty query");
	expect(() => parseSlackUrlString("slack://T123/channels/general?limit=nope")).toThrow("positive integer");
	expect(() => parseSlackUrlString("slack://T123/unknown")).toThrow("Unsupported Slack URL path");
});

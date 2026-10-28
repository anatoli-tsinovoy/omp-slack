import { expect, test } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { parseInternalUrl, type ProtocolHandler, type ResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { MCPToolCallResult, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import { createSlackProtocolHandler, parseSlackUrlString } from "../src/protocol";
import type { SlackAuthPresenter, SlackCore, SlackWorkspace } from "../src/types";

const storage = {} as AuthStorage;
const workspace: SlackWorkspace = {
	teamId: "T123",
	teamName: "Acme",
	userId: "U456",
	isDefault: true,
};
const channelSearchTool: MCPToolDefinition = {
	name: "slack_list_user_channels",
	inputSchema: { type: "object" },
};

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
	availableTools: MCPToolDefinition[] = [channelSearchTool];
	storageUsed: AuthStorage | undefined;
	listToolsCalls = 0;

	async listWorkspaces(): Promise<SlackWorkspace[]> {
		return [workspace];
	}

	async resolveWorkspace(storage: AuthStorage, selector?: string): Promise<SlackWorkspace> {
		this.storageUsed = storage;
		if (selector && selector !== "T123" && selector !== "Acme") throw new Error(`Unknown workspace ${selector}`);
		return workspace;
	}

	async connectWorkspace(_storage: AuthStorage, _presenter: SlackAuthPresenter): Promise<SlackWorkspace> {
		return workspace;
	}

	async saveClientCredentials(): Promise<void> { }

	async clearClientCredentials(): Promise<void> { }

	async disconnectWorkspace(): Promise<SlackWorkspace> {
		return workspace;
	}

	async setDefaultWorkspace(): Promise<SlackWorkspace> {
		return workspace;
	}

	async callTool(
		_storage: AuthStorage,
		_workspace: SlackWorkspace,
		tool: string,
		args: Record<string, unknown>,
	): Promise<MCPToolCallResult> {
		this.calls.push({ name: tool, args });
		return this.responses.get(tool) ?? { content: [{ type: "text", text: "ok" }] };
	}

	async listTools(): Promise<MCPToolDefinition[]> {
		this.listToolsCalls++;
		return this.availableTools;
	}

	async closeAll(): Promise<void> { }
}

function createHandler(core: FakeSlackCore): ProtocolHandler {
	return createSlackProtocolHandler(core, () => storage);
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
	const url = "slack://T123/channels/general?limit=12&oldest=1.2&latest=3.4";

	const history = await handler.resolve(parseInternalUrl(url));
	const repeated = await handler.resolve(parseInternalUrl(url));
	expect(core.calls.filter(call => call.name === "slack_search_channels")).toHaveLength(1);
	expect(core.calls.filter(call => call.name === "slack_read_channel")).toHaveLength(2);
	expect(core.calls[0]).toEqual({ name: "slack_search_channels", args: { query: "general" } });
	expect(core.calls[1]).toEqual({
		name: "slack_read_channel",
		args: { channel_id: "C999", limit: 12, oldest: "1.2", latest: "3.4" },
	});
	expect(history.content).toContain("Release is ready");
	expect(history.content).toContain("**U456** (replies: 2)");
	expect(history.content).toContain("slack://T123/threads/C999/1700.5");
	expect(repeated.content).toContain("Thanks");
});

test("thread, profile, canvas, file, and search routes choose their mapped MCP tools", async () => {
	const core = new FakeSlackCore();
	const handler = createHandler(core);
	core.responses.set("slack_read_thread", jsonResult({ messages: [{ ts: "1700.5", user: "U456", text: "Thread reply" }] }));

	const thread = await handler.resolve(parseInternalUrl("slack://T123/threads/C999/1700.5"));
	await handler.resolve(parseInternalUrl("slack://T123/users/me"));
	await handler.resolve(parseInternalUrl("slack://T123/users/U999"));
	await handler.resolve(parseInternalUrl("slack://T123/canvases/F001"));
	await handler.resolve(parseInternalUrl("slack://T123/files/F002"));
	await handler.resolve(parseInternalUrl("slack://T123/search?q=budget&scope=all&type=files"));

	expect(core.calls).toEqual([
		{ name: "slack_read_thread", args: { channel_id: "C999", thread_ts: "1700.5" } },
		{ name: "slack_read_user_profile", args: {} },
		{ name: "slack_read_user_profile", args: { user_id: "U999" } },
		{ name: "slack_read_canvas", args: { canvas_id: "F001" } },
		{ name: "slack_read_file", args: { file_id: "F002" } },
		{ name: "slack_search_public_and_private", args: { query: "budget", type: "files" } },
	]);
	expect(thread.content).toContain("# Slack thread");
	expect(thread.content).toContain("Thread reply");
	expect(thread.content).toContain("slack://T123/threads/C999/1700.5");
});

test("directory traversal is bounded and channel listings use the guarded listing tool", async () => {
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

	expect(root.content).toContain("Acme (T123) (default)");
	expect(rootEntries.map(entry => entry.name)).toEqual(["Acme (T123)"]);
	expect(workspaceEntries.map(entry => entry.name)).toEqual(["channels", "users", "search"]);
	expect(channelEntries.map(entry => entry.name)).toEqual(["general (C999)"]);
	expect(core.listToolsCalls).toBe(1);
	expect(core.calls[0]).toEqual({ name: "slack_list_user_channels", args: {} });
	expect(enumerated).toHaveLength(1);
	expect(crawl).toEqual([]);
});


test("unconfirmed channel-list tool absence has a clear discovery error", async () => {
	const core = new FakeSlackCore();
	core.availableTools = [];
	const handler = createHandler(core);
	const readDirectory = handler.readDirectory;
	if (!readDirectory) throw new Error("Slack protocol should expose directory reads");

	await expect(readDirectory(parseInternalUrl("slack://T123/channels/"))).rejects.toThrow(
		"does not expose `slack_list_user_channels`",
	);
});
test("malformed Slack URLs explain the expected route or query", () => {
	expect(() => parseSlackUrlString("slack://T123/threads/C999")).toThrow("threads/<channel>/<ts>");
	expect(() => parseSlackUrlString("slack://T123/search?q=")).toThrow("non-empty query");
	expect(() => parseSlackUrlString("slack://T123/channels/general?limit=nope")).toThrow("positive integer");
	expect(() => parseSlackUrlString("slack://T123/unknown")).toThrow("Unsupported Slack URL path");
});

test("the protocol prefers auth storage attached to the caller's ToolSession", async () => {
	const registryStorage = {} as AuthStorage;
	const otherSessionStorage = {} as AuthStorage;
	const session = {
		authStorage: otherSessionStorage,
		modelRegistry: { authStorage: registryStorage },
	} as NonNullable<ResolveContext["session"]>;
	const core = new FakeSlackCore();
	const handler = createHandler(core);

	await handler.resolve(parseInternalUrl("slack://T123/"), { session });
	expect(core.storageUsed).toBe(registryStorage);
});

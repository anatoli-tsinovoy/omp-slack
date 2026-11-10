import { expect, test } from "bun:test";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { MCPToolCallResult, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import { createSlackProtocolHandler } from "../src/protocol";
import type { ChatGPTAccount, SlackCore, SlackWorkspace } from "../src/types";

const WORKSPACES: SlackWorkspace[] = [
	{ teamId: "T123", teamName: "Acme" },
	{ teamId: "T456", teamName: "acme" },
	{ teamId: "T789", teamName: "Ops" },
];
const GATEWAY_PREFIX = "slack.";
const LISTED = "## My Channels (showing 2 of 3 total)\n\n### #general\n- **ID:** C04MK5YG0\n- **Type:** Public Channel\n\n### #launch-ops\n- **ID:** C0LAUNCH2\n- **Type:** Private Channel\n";
const HISTORY = [
	"Channel: #general (C04MK5YG0)",
	"",
	"=== Message from dima (U04PXJCE2G3) at 2026-09-16 22:20:36 IDT === ",
	"Message TS: 1789586436.975229",
	"Version 1.11.4 was released",
	"Thread: 4 replies (latest: 2026-09-17 00:14:14 IDT)",
].join("\n");

function textResult(text: string): MCPToolCallResult {
	return { content: [{ type: "text", text }] };
}

class FakeSlackCore implements SlackCore {
	calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	responses = new Map<string, MCPToolCallResult>([
		["slack_list_user_channels", textResult(LISTED)],
		["slack_read_channel", textResult(HISTORY)],
	]);

	async account(): Promise<ChatGPTAccount | undefined> {
		return undefined;
	}
	async login(): Promise<ChatGPTAccount> {
		return { accountId: "acct", expires: 0 };
	}
	async logout(): Promise<void> { }
	async closeAll(): Promise<void> { }
	async listWorkspaces(): Promise<SlackWorkspace[]> {
		return WORKSPACES;
	}
	async resolveWorkspace(selector?: string): Promise<SlackWorkspace> {
		const workspace = WORKSPACES.find(candidate => candidate.teamId === selector || candidate.teamName === selector);
		if (!workspace) throw new Error(`Unknown workspace ${selector}`);
		return workspace;
	}
	async listTools(): Promise<MCPToolDefinition[]> {
		return [
			"slack_list_user_channels",
			"slack_search_channels",
			"slack_read_channel",
			"slack_read_thread",
			"slack_read_user_profile",
			"slack_read_canvas",
			"slack_read_file",
			"slack_search_public",
			"slack_search_public_and_private",
		].map(name => ({ name: GATEWAY_PREFIX + name, inputSchema: { type: "object" } }));
	}
	async callTool(tool: string, args: Record<string, unknown>): Promise<MCPToolCallResult> {
		const name = tool.slice(GATEWAY_PREFIX.length);
		this.calls.push({ name, args });
		return this.responses.get(name) ?? textResult("ok");
	}
}

function slack() {
	const core = new FakeSlackCore();
	const handler = createSlackProtocolHandler(core);
	return {
		core,
		read: async (url: string, skipDirectoryListing = false) => handler.resolve(parseInternalUrl(url), { skipDirectoryListing }),
		list: async (url: string) => (handler.readDirectory ? handler.readDirectory(parseInternalUrl(url)) : []),
	};
}

test("the tree is workspaces, then channels you're in, each a history file listed without fetching it", async () => {
	const { core, read, list } = slack();
	// Team names shared case-insensitively fall back to their ids.
	expect((await list("slack://")).map(entry => [entry.name, entry.fileType])).toEqual([
		["T123", "dir"],
		["T456", "dir"],
		["Ops", "dir"],
	]);
	expect((await list("slack://Ops/")).map(entry => [entry.name, entry.fileType])).toEqual([["channels", "dir"]]);
	expect((await list("slack://T123/channels/")).map(entry => [entry.name, entry.fileType, entry.metadata?.size])).toEqual([
		["general", "file", 0],
		["launch-ops", "file", 0],
	]);
	const listing = await read("slack://T123/channels");
	expect(listing.isDirectory).toBe(true);
	expect(listing.content).toBe(
		"# Channels you're in — Acme (2 of 3; the Slack app lists no more)\n\n- general — #general · id `C04MK5YG0`\n- launch-ops — #launch-ops · id `C0LAUNCH2`",
	);
	expect(core.calls).toEqual([{ name: "slack_list_user_channels", args: { limit: 200, team_id: "T123" } }]);
	expect((await read("slack://T123/channels/", true)).content).toBe("");
});

test("channel names resolve through the cached listing, history links threads by URL, and rereads are cached", async () => {
	const { core, read } = slack();
	const history = await read("slack://T123/channels/%23General?limit=5&oldest=1.2");
	await read("slack://T123/channels/%23General?limit=5&oldest=1.2");
	await read("slack://T123/channels/general");
	expect(history.isDirectory).toBeFalsy();
	expect(history.content).toContain("Thread: 4 replies (latest: 2026-09-17 00:14:14 IDT) — read: slack://T123/threads/C04MK5YG0/1789586436.975229\n");
	expect(core.calls).toEqual([
		{ name: "slack_list_user_channels", args: { limit: 200, team_id: "T123" } },
		{ name: "slack_read_channel", args: { channel_id: "C04MK5YG0", limit: 5, oldest: "1.2" } },
		{ name: "slack_read_channel", args: { channel_id: "C04MK5YG0" } },
	]);
});

test("threads, profiles, canvases, files, and search map onto the Slack app's reads", async () => {
	const { core, read } = slack();
	await read("slack://Ops/threads/C0LAUNCH2/1700.5?limit=3");
	await read("slack://Ops/users/me");
	await read("slack://Ops/canvases/F001");
	await read("slack://Ops/files/F002");
	await read("slack://Ops/search?q=%22launch%20plan%22%20from%3A%3C%40U1%3E&scope=all&type=files&limit=4");
	expect(core.calls).toEqual([
		{ name: "slack_read_thread", args: { channel_id: "C0LAUNCH2", message_ts: "1700.5", limit: 3 } },
		{ name: "slack_read_user_profile", args: {} },
		{ name: "slack_read_canvas", args: { canvas_id: "F001" } },
		{ name: "slack_read_file", args: { file_id: "F002" } },
		{
			name: "slack_search_public_and_private",
			args: { keywords: ['"launch plan"'], natural_language_query: '"launch plan"', filters: "from:<@U1>", content_types: "files", limit: 4 },
		},
	]);
});

test("a channel you aren't in falls through to the channel search", async () => {
	const { core, read } = slack();
	core.responses.set(
		"slack_search_channels",
		textResult("## Channels (1 results)\n### Result 1 of 1\nName: #design\nPermalink: [link](https://acme.slack.com/archives/C0DESIGN1)\n"),
	);
	await read("slack://T123/channels/design");
	expect(core.calls.map(call => call.name)).toEqual(["slack_list_user_channels", "slack_list_user_channels", "slack_search_channels", "slack_read_channel"]);
	expect(core.calls.at(-1)?.args).toEqual({ channel_id: "C0DESIGN1" });
});

test("malformed URLs and walk probes fail before any gateway call", async () => {
	const { core, read, list } = slack();
	await expect(read("slack://T123/channels/.gitignore")).rejects.toThrow("Slack channel `.gitignore` not found");
	await expect(read("slack://T123/.git")).rejects.toThrow("not found. Under slack://<workspace>/ use");
	await expect(read("slack://T123/threads/C04MK5YG0/latest")).rejects.toThrow("Slack thread timestamp `latest` not found");
	await expect(read("slack://T123/channels/general?limit=0")).rejects.toThrow("`limit` must be a positive integer");
	await expect(read("slack://T123/channels/general?cursor=x")).rejects.toThrow("Unsupported slack:// parameter `cursor`");
	await expect(read("slack://T123/channels/?limit=5")).rejects.toThrow("takes no query string");
	await expect(read("slack://T123/search?q=%20")).rejects.toThrow("needs a query");
	await expect(read("slack://T123/search?q=x&scope=private")).rejects.toThrow("`scope` is `all` or `public`");
	await expect(read("slack:///channels/")).rejects.toThrow("slack:// needs a workspace");
	await expect(read("slack://Nowhere/")).rejects.toThrow("Unknown workspace Nowhere");
	await expect(list("slack://T123/users/me")).rejects.toThrow("is a file, not a folder");
	expect(core.calls).toEqual([]);
});

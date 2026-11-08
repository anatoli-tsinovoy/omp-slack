import { expect, test } from "bun:test";
import type { MCPToolCallResult, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import { createSlackReads } from "../src/reads";
import { executeSlackOperation, type SlackToolInput } from "../src/tool";
import type { ChatGPTAccount, SlackCore, SlackWorkspace } from "../src/types";

const workspace: SlackWorkspace = { teamId: "T123", teamName: "Acme" };
/** The gateway prefixes connector tool names; read ops must still find them. */
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
	async logout(): Promise<void> { }
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
	async closeAll(): Promise<void> { }
}

/** One device's worth of reads: the channel memo persists across calls like it does in a session. */
function device(core: FakeSlackCore) {
	const reads = createSlackReads(core);
	return async (input: SlackToolInput) =>
		(await executeSlackOperation(core, input, { reads })).content.map(block => block.text).join("");
}

const LISTED_GENERAL = "## My Channels (showing 2 of 2 total)\n\n### #general\n- **ID:** C04MK5YG0\n- **Type:** Public Channel\n\n### #general-chat\n- **ID:** C0GENCHAT\n- **Type:** Public Channel\n";
const HISTORY = [
	"Channel: #general (C04MK5YG0)",
	"",
	"=== Message from dima <dima@example.com> (U04PXJCE2G3) at 2026-09-16 22:20:36 IDT === ",
	"Message TS: 1789586436.975229",
	"Version 1.11.4 was released",
	"Thread: 4 replies (latest: 2026-09-17 00:14:14 IDT)",
	"",
	"=== Message from rae <rae@example.com> (U09CP6KL3NJ) at 2026-09-15 18:10:52 IDT === ",
	"Message TS: 1789485052.065979",
	"Thanks",
].join("\n");

test("channel names resolve via your channel list once, and history links each thread to its op", async () => {
	const core = new FakeSlackCore();
	core.responses.set("slack_list_user_channels", jsonResult({ result: LISTED_GENERAL }));
	core.responses.set("slack_read_channel", jsonResult({ messages: HISTORY, pagination_info: "End of results" }));
	const run = device(core);
	const input: SlackToolInput = { op: "history", workspace: "Acme", channel: "#General", limit: 12, oldest: "1.2", latest: "3.4" };

	const history = await run(input);
	await run(input);
	expect(core.calls.map(call => call.name)).toEqual(["slack_list_user_channels", "slack_read_channel", "slack_read_channel"]);
	expect(core.calls[0]?.args).toEqual({ name_prefix: "general", limit: 200, team_id: "T123" });
	expect(core.calls[1]?.args).toEqual({ channel_id: "C04MK5YG0", limit: 12, oldest: "1.2", latest: "3.4" });
	// The JSON wrapper is unwrapped into the app's own text.
	expect(history).toStartWith("Channel: #general (C04MK5YG0)");
	expect(history).toContain(
		'Thread: 4 replies (latest: 2026-09-17 00:14:14 IDT) — read: `{"op":"thread","workspace":"T123","channel":"C04MK5YG0","ts":"1789586436.975229"}`',
	);
	expect(history).not.toContain('"ts":"1789485052.065979"');
	expect(history).toEndWith("Thanks\n\nEnd of results");
});

test("a channel you haven't joined resolves through channel search; ambiguous or unknown names ask for an id", async () => {
	const core = new FakeSlackCore();
	core.responses.set("slack_list_user_channels", jsonResult({ result: "## My Channels (showing 0 of 0 total)\n" }));
	core.responses.set(
		"slack_search_channels",
		jsonResult({
			results:
				"# Search Results for: \n\n## Channels (2 results)\n### Result 1 of 2\nName: #launch\nPermalink: [link](https://acme.slack.com/archives/C0LAUNCH1)\n\n---\n\n### Result 2 of 2\nName: #launch-ops\nPermalink: [link](https://acme.slack.com/archives/C0LAUNCH2)\n",
		}),
	);
	const run = device(core);
	await run({ op: "thread", channel: "launch", ts: "1700.5" });
	expect(core.calls.at(1)).toEqual({
		name: "slack_search_channels",
		args: { keywords: ["launch"], natural_language_query: "launch", channel_types: "public_channel,private_channel" },
	});
	expect(core.calls.at(-1)).toEqual({ name: "slack_read_thread", args: { channel_id: "C0LAUNCH1", message_ts: "1700.5" } });
	await expect(run({ op: "history", channel: "nowhere" })).rejects.toThrow("matched no channels in Acme; pass its channel id");
});

test("profile, canvas, file, and search ops send the connector's argument shapes", async () => {
	const core = new FakeSlackCore();
	const run = device(core);

	await run({ op: "profile" });
	await run({ op: "profile", user: "U999" });
	await run({ op: "canvas", id: "F001" });
	await run({ op: "file", id: "F002" });
	await run({ op: "search", query: '"launch plan" budget from:<@U123> after:2026-01-01', scope: "all", type: "files" });
	await run({ op: "search", query: "in:#general" });

	expect(core.calls).toEqual([
		{ name: "slack_read_user_profile", args: {} },
		{ name: "slack_read_user_profile", args: { user_id: "U999" } },
		{ name: "slack_read_canvas", args: { canvas_id: "F001" } },
		{ name: "slack_read_file", args: { file_id: "F002" } },
		{
			name: "slack_search_public_and_private",
			args: {
				keywords: ['"launch plan"', "budget"],
				natural_language_query: '"launch plan" budget',
				filters: "from:<@U123> after:2026-01-01",
				content_types: "files",
			},
		},
		{ name: "slack_search_public", args: { keywords: [], natural_language_query: "", filters: "in:#general" } },
	]);
});

test("search results with replies link to their thread; results without replies do not", async () => {
	const core = new FakeSlackCore();
	core.responses.set(
		"slack_search_public",
		jsonResult({
			results: [
				"## Messages (2 results)",
				"### Result 1 of 2",
				"Channel: #draw (ID: C030X274BB3)",
				"Message_ts: 1793865008.251709",
				"Reply count: 7",
				"Text: Released 1.21.0",
				"### Result 2 of 2",
				"Channel: #general (ID: C04MK5YG0)",
				"Message_ts: 1793865009.000001",
				"Reply count: 0",
			].join("\n"),
		}),
	);
	const results = await device(core)({ op: "search", query: "released" });
	expect(results).toContain(
		'Reply count: 7 — read: `{"op":"thread","workspace":"T123","channel":"C030X274BB3","ts":"1793865008.251709"}`',
	);
	expect(results).toEndWith("Reply count: 0");
});

test("channel listings are scoped to the workspace and accept a name prefix", async () => {
	const core = new FakeSlackCore();
	core.responses.set("slack_list_user_channels", jsonResult({ result: LISTED_GENERAL }));
	const listing = await device(core)({ op: "channels", workspace: "T123", channel: "#Gen" });
	expect(core.calls).toEqual([{ name: "slack_list_user_channels", args: { limit: 200, team_id: "T123", name_prefix: "gen" } }]);
	expect(listing).toBe(LISTED_GENERAL.trim());
});

test("a missing connector tool, a Slack error result, and missing fields all surface as errors", async () => {
	const core = new FakeSlackCore();
	core.availableTools = [];
	await expect(device(core)({ op: "channels" })).rejects.toThrow("does not expose `slack_list_user_channels`");

	const failing = new FakeSlackCore();
	failing.responses.set("slack_read_canvas", { content: [{ type: "text", text: "canvas_not_found" }], isError: true });
	const run = device(failing);
	await expect(run({ op: "canvas", id: "F404" })).rejects.toThrow("canvas_not_found");
	await expect(run({ op: "thread", channel: "C04MK5YG0" })).rejects.toThrow('"thread" needs `ts`');
	await expect(run({ op: "search", query: "  " })).rejects.toThrow('"search" needs `query`');
	await expect(run({ op: "history", workspace: "Elsewhere", channel: "C04MK5YG0" })).rejects.toThrow("Unknown workspace Elsewhere");
	expect(failing.calls.map(call => call.name)).toEqual(["slack_read_canvas"]);
});

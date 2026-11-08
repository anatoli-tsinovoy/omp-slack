import { expect, test } from "bun:test";
import type { MCPToolCallResult, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import { executeSlackOperation, slackApproval } from "../src/tool";
import type { SlackCore } from "../src/types";

const TOOLS: MCPToolDefinition[] = [
	{
		name: "slack.slack_read_channel",
		description: "Reads a channel\nLong details",
		inputSchema: { type: "object", properties: { channel_id: { type: "string" } }, required: ["channel_id"] },
		annotations: { readOnlyHint: true },
	},
	{ name: "slack.slack_send_message", description: "Sends a message", inputSchema: { type: "object" } },
];

function fakeCore(result: MCPToolCallResult): SlackCore & { calls: Array<{ tool: string; args: Record<string, unknown> }> } {
	const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	const unused = async (): Promise<never> => {
		throw new Error("unused");
	};
	return {
		calls,
		account: unused,
		login: unused,
		logout: unused,
		closeAll: unused,
		listWorkspaces: async () => [{ teamId: "T1", teamName: "Simply" }],
		listTools: async () => TOOLS,
		async callTool(tool, args) {
			calls.push({ tool, args });
			return result;
		},
	};
}

test("tools and schema present the Slack names the model writes, without the gateway prefix", async () => {
	const core = fakeCore({ content: [] });
	const list = (await executeSlackOperation(core, { op: "tools" })).content.map(block => block.text).join("");
	expect(list).toContain("- `slack_read_channel` (read-only) — Reads a channel");
	expect(list).toContain("- `slack_send_message` — Sends a message");
	expect(list).not.toContain("slack.slack_");
	expect(list).not.toContain("Long details");

	const schema = (await executeSlackOperation(core, { op: "schema", tool: "slack_read_channel" })).content.map(block => block.text).join("");
	expect(schema).toContain('"required": [\n    "channel_id"\n  ]');
});

test("call resolves the prefixed gateway tool and surfaces Slack error results as tool errors", async () => {
	const core = fakeCore({ content: [{ type: "text", text: "channel_not_found" }], isError: true });
	const result = await executeSlackOperation(core, { tool: "slack_read_channel", args: { channel_id: "C404" } });
	expect(core.calls).toEqual([{ tool: "slack.slack_read_channel", args: { channel_id: "C404" } }]);
	expect(result.isError).toBe(true);
	expect(result.content.map(block => block.text).join("")).toContain("channel_not_found");
});

test("unknown tools are refused before any call, listing what exists", async () => {
	const core = fakeCore({ content: [] });
	await expect(executeSlackOperation(core, { tool: "search_emails" })).rejects.toThrow(
		'no tool "search_emails". Available tools: slack_read_channel, slack_send_message',
	);
	await expect(executeSlackOperation(core, { op: "schema" })).rejects.toThrow("requires a tool name");
	expect(core.calls).toEqual([]);
});

test("login without a UI presenter points at /slack login", async () => {
	await expect(executeSlackOperation(fakeCore({ content: [] }), { op: "login" })).rejects.toThrow("/slack login");
});

test("only discovery and Slack read tools skip write approval", () => {
	for (const tool of ["slack_read_channel", "slack.slack_search_public_and_private", "slack_list_user_channels", "slack_get_reactions"]) {
		expect(slackApproval({ tool })).toBe("read");
	}
	for (const op of ["tools", "schema", "workspaces"]) expect(slackApproval({ op })).toBe("read");
	for (const tool of ["slack_send_message", "slack_get_file_upload_url", "slack_update_canvas", "slack_add_reaction"]) {
		expect(slackApproval({ tool })).toBe("write");
	}
	expect(slackApproval({ op: "login" })).toBe("write");
	expect(slackApproval({ op: "schema", tool: "slack_send_message" })).toBe("read");
	expect(slackApproval({})).toBe("write");
});

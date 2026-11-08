import { expect, test } from "bun:test";
import type { MCPToolCallResult, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import { outboundArguments, slackToolDefinition } from "../src/tool";
import type { SlackCore } from "../src/types";

const readChannel: MCPToolDefinition = {
	name: "slack.slack_read_channel",
	description: "Reads a channel",
	inputSchema: {
		type: "object",
		properties: { channel_id: { type: "string" }, cursor: { type: "string" } },
		required: ["channel_id"],
	},
	annotations: { readOnlyHint: true },
};

function coreReturning(result: MCPToolCallResult, calls: Array<{ tool: string; args: Record<string, unknown> }>): SlackCore {
	const unused = async (): Promise<never> => {
		throw new Error("unused");
	};
	return {
		account: unused,
		login: unused,
		logout: unused,
		listTools: unused,
		listWorkspaces: unused,
		resolveWorkspace: unused,
		closeAll: unused,
		async callTool(tool, args) {
			calls.push({ tool, args });
			return result;
		},
	};
}

test("outbound arguments drop the harness intent field and empty optionals, but keep declared fields", () => {
	expect(outboundArguments({ i: "Reading channel", channel_id: "C1", cursor: null }, readChannel.inputSchema)).toEqual({ channel_id: "C1" });
	const declaresIntent: MCPToolDefinition["inputSchema"] = { type: "object", properties: { i: { type: "string" } } };
	expect(outboundArguments({ i: "kept" }, declaresIntent)).toEqual({ i: "kept" });
	expect(outboundArguments({ channel_id: null }, readChannel.inputSchema)).toEqual({ channel_id: null });
});

test("Slack tools take the native slack MCP name and surface Slack error results as tool errors", async () => {
	const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	const definition = slackToolDefinition(
		readChannel,
		coreReturning({ content: [{ type: "text", text: "channel_not_found" }], isError: true }, calls),
	);
	expect(definition.name).toBe("mcp__slack_slack_read_channel");
	expect(definition.mcpToolName).toBe("slack.slack_read_channel");

	const result = await definition.execute("call-1", { i: "Reading", channel_id: "C404" }, undefined, undefined, undefined as never);
	expect(calls).toEqual([{ tool: "slack.slack_read_channel", args: { channel_id: "C404" } }]);
	expect(result.isError).toBe(true);
	expect(JSON.stringify(result.content)).toContain("channel_not_found");
});

import { expect, test } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { MCPToolCallResult, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import { executeSlackOperation } from "../src/tool";
import type { SlackAuthPresenter, SlackCore, SlackWorkspace } from "../src/types";

const storage = {} as AuthStorage;
const workspace: SlackWorkspace = {
	teamId: "T123",
	teamName: "Acme",
	userId: "U456",
	isDefault: true,
};
const searchTool: MCPToolDefinition = {
	name: "slack_search_public",
	description: "Search public Slack messages.\nMore details.",
	inputSchema: { type: "object", properties: { query: { type: "string" } } },
};

class FakeSlackCore implements SlackCore {
	callError: Error | undefined;
	callResult: MCPToolCallResult = { content: [{ type: "text", text: "ok" }] };
	tools: MCPToolDefinition[] = [searchTool];
	resolvedSelector: string | undefined;
	callArguments: { tool: string; args: Record<string, unknown> }[] = [];
	listedTools = 0;
	connectedTeam: string | undefined;

	async listWorkspaces(): Promise<SlackWorkspace[]> {
		return [workspace];
	}

	async resolveWorkspace(_storage: AuthStorage, selector?: string): Promise<SlackWorkspace> {
		this.resolvedSelector = selector;
		return workspace;
	}

	async connectWorkspace(
		_storage: AuthStorage,
		_presenter: SlackAuthPresenter,
		opts?: { team?: string },
	): Promise<SlackWorkspace> {
		this.connectedTeam = opts?.team;
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
		this.callArguments.push({ tool, args });
		if (this.callError) throw this.callError;
		return this.callResult;
	}

	async listTools(): Promise<MCPToolDefinition[]> {
		this.listedTools++;
		return this.tools;
	}

	async closeAll(): Promise<void> { }
}

test("call dispatch forwards tool arguments and preserves MCP error text", async () => {
	const core = new FakeSlackCore();
	const result = await executeSlackOperation(core, storage, {
		op: "call",
		tool: "slack_search_public",
		args: { query: "release notes" },
		workspace: "T123",
	});
	expect(core.resolvedSelector).toBe("T123");
	expect(core.callArguments).toEqual([{ tool: "slack_search_public", args: { query: "release notes" } }]);
	expect(result.content[0]?.text).toBe("ok");

	core.callResult = { isError: true, content: [{ type: "text", text: "invalid Slack MCP arguments" }] };
	const serverError = await executeSlackOperation(core, storage, {
		op: "call",
		tool: "slack_search_public",
	});
	expect(serverError.content[0]?.text).toBe("invalid Slack MCP arguments");

	core.callResult = {
		content: [{ type: "text", text: "concise output" }],
		structuredContent: { remaining: 1 },
	};
	const structured = await executeSlackOperation(core, storage, {
		op: "call",
		tool: "slack_search_public",
	});
	expect(structured.content[0]?.text).toContain("concise output");
	expect(structured.content[0]?.text).toContain('"remaining": 1');

	core.callError = new Error("Slack workspace token expired; run /slack login");
	await expect(
		executeSlackOperation(core, storage, { op: "call", tool: "slack_search_public" }),
	).rejects.toThrow("Slack workspace token expired; run /slack login");
});

test("tools and schema operations expose the server's current tool contract", async () => {
	const core = new FakeSlackCore();
	const tools = await executeSlackOperation(core, storage, { op: "tools", workspace: "Acme" });
	expect(tools.content[0]?.text).toContain("`slack_search_public` — Search public Slack messages.");
	expect(core.listedTools).toBe(1);

	const schema = await executeSlackOperation(core, storage, { op: "schema", tool: "slack_search_public" });
	expect(schema.content[0]?.text).toContain('"query"');
	expect(core.listedTools).toBe(2);
	await expect(
		executeSlackOperation(core, storage, { op: "schema", tool: "missing" }),
	).rejects.toThrow('Available tools: slack_search_public');
});

test("connect accepts the optional team selector and workspaces are local", async () => {
	const core = new FakeSlackCore();
	const presenter: SlackAuthPresenter = { onAuthUrl: () => { } };
	const connected = await executeSlackOperation(core, storage, { op: "connect", team: "T123" }, presenter);
	expect(core.connectedTeam).toBe("T123");
	expect(connected.content[0]?.text).toContain("Acme (T123)");

	const workspaces = await executeSlackOperation(core, storage, { op: "workspaces" });
	expect(workspaces.content[0]?.text).toContain("Acme (T123) (default)");
	expect(core.listedTools).toBe(0);
});

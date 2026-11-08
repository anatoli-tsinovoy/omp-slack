import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import slackToolDescription from "./prompts/slack-tool.md" with { type: "text" };
import { findSlackTool, slackCore } from "./core";
import { runSlackLogin } from "./login";
import { createSlackReads, isSlackReadOp, SLACK_READ_OPS, type SlackReadInput, type SlackReadOp, type SlackReads } from "./reads";
import {
	renderMcpResult,
	renderSlackToolList,
	renderSlackToolSchema,
	renderSlackWorkspaces,
	slackToolDisplayName,
} from "./render";
import type { ChatGPTAccount, SlackCore } from "./types";

const DEVICE_OPS = ["call", "tools", "schema", "workspaces", "login"] as const;
export type SlackToolOperation = (typeof DEVICE_OPS)[number] | SlackReadOp;

export interface SlackToolInput extends SlackReadInput {
	op?: SlackToolOperation;
	tool?: string;
	args?: Record<string, unknown>;
}

export interface SlackOperationOptions {
	/** Curated reads; pass one instance per device so channel-name lookups are remembered across calls. */
	reads?: SlackReads;
	login?: () => Promise<ChatGPTAccount>;
	signal?: AbortSignal;
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
	{ reads = createSlackReads(core), login, signal }: SlackOperationOptions = {},
): Promise<SlackToolResult> {
	const op = input.op ?? "call";
	if (isSlackReadOp(op)) return textResult(await reads.run(op, input, signal));
	switch (op) {
		case "workspaces":
			return textResult(renderSlackWorkspaces(await core.listWorkspaces(signal)));
		case "login": {
			if (!login) throw new Error("ChatGPT sign-in cannot be presented here; have the user run `/slack login`.");
			const account = await login();
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

/** Connector tools that only read Slack; everything else (send, schedule, react, canvas, membership, upload) is a write. */
const READ_ONLY_SLACK_TOOL = /^(?:slack\.)?slack_(?:read_|search_|list_|get_reactions$)/u;

/** Discovery and read calls run at the read tier; Slack mutations and sign-in stay at write. */
export function slackApproval(args: unknown): "read" | "write" {
	const { op = "call", tool } = (args ?? {}) as SlackToolInput;
	if (op === "tools" || op === "schema" || op === "workspaces" || isSlackReadOp(op)) return "read";
	return op === "call" && typeof tool === "string" && READ_ONLY_SLACK_TOOL.test(tool.trim()) ? "read" : "write";
}

/** One discoverable `xd://slack` device; no Slack tool schemas enter context until the model asks for them. */
export function registerSlackTool(pi: ExtensionAPI, core: SlackCore = slackCore): void {
	const z = pi.zod;
	const reads = createSlackReads(core);
	pi.registerTool({
		name: "slack",
		label: "Slack",
		description: slackToolDescription.trim(),
		loadMode: "discoverable",
		approval: slackApproval,
		parameters: z
			.object({
				op: z.enum([...DEVICE_OPS, ...SLACK_READ_OPS]).default("call"),
				tool: z.string().optional().describe("Slack tool name, e.g. slack_send_message; required for call and schema."),
				args: z.record(z.string(), z.unknown()).optional().describe("Arguments for the named tool, per its schema."),
				workspace: z.string().optional().describe("Read ops: team id or name; optional with one workspace."),
				channel: z.string().optional().describe("history/thread: channel id, name, or #name."),
				ts: z.string().optional().describe("thread: parent message timestamp."),
				user: z.string().optional().describe("profile: user id; omit or `me` for yourself."),
				id: z.string().optional().describe("canvas/file: canvas or file id."),
				query: z.string().optional().describe("search: Slack query with modifiers (from:, in:, after:, \"phrase\")."),
				scope: z.enum(["public", "all"]).optional().describe("search: `all` adds private channels and DMs."),
				type: z.enum(["files"]).optional().describe("search: `files` searches files."),
				limit: z.number().int().positive().optional().describe("history: maximum messages."),
				oldest: z.string().optional().describe("history: oldest message ts."),
				latest: z.string().optional().describe("history: latest message ts."),
			})
			.strict(),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeSlackOperation(core, params, { reads, login: () => runSlackLogin(ctx, core, signal), signal });
		},
	});
}

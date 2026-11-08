import type { MCPToolCallResult, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import type { SlackWorkspace } from "./types";

const MAX_RENDERED_MCP_CHARS = 32_000;

type JsonRecord = Record<string, unknown>;

type JsonParseResult = { parsed: true; value: unknown } | { parsed: false };

export function isJsonRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonText(text: string): JsonParseResult {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	const candidate = fenced?.[1] ?? trimmed;
	try {
		return { parsed: true, value: JSON.parse(candidate) as unknown };
	} catch {
		return { parsed: false };
	}
}


function truncateMarkdown(text: string, limit = MAX_RENDERED_MCP_CHARS): string {
	if (text.length <= limit) return text;
	const marker = "\n\n[Slack response truncated.]";
	return `${text.slice(0, Math.max(0, limit - marker.length))}${marker}`;
}

function renderContentBlock(block: MCPToolCallResult["content"][number]): string {
	switch (block.type) {
		case "text":
			return block.text;
		case "image":
			return `[MCP image omitted: ${block.mimeType}]`;
		case "resource": {
			const body = block.resource.text ?? `[Binary resource omitted: ${block.resource.mimeType ?? "unknown type"}]`;
			return `Resource: ${block.resource.uri}\n\n${body}`;
		}
	}
}

/** Render MCP content and structuredContent without hiding server-provided text. */
export function renderMcpResult(result: MCPToolCallResult): string {
	if (
		result.structuredContent === undefined &&
		result.content.length === 1 &&
		result.content[0]?.type === "text"
	) {
		return truncateMarkdown(unwrapTextPayload(result.content[0].text));
	}

	const sections = result.content.map(renderContentBlock).filter(section => section.length > 0);
	if (result.structuredContent !== undefined) {
		sections.push(`Structured content:\n\n\`\`\`json\n${JSON.stringify(result.structuredContent, null, 2) ?? String(result.structuredContent)}\n\`\`\``);
	}
	if (sections.length === 0) {
		sections.push(result.isError ? "Slack MCP returned an error without content." : "Slack MCP returned no content.");
	}
	return truncateMarkdown(sections.join("\n\n"));
}

/**
 * The ChatGPT Slack app answers with pre-rendered text wrapped in JSON (`{"messages":"…","pagination_info":"…"}`).
 * Show that text itself, not its JSON-escaped form; any other payload is returned unchanged.
 */
function unwrapTextPayload(text: string): string {
	const parsed = parseJsonText(text);
	if (!parsed.parsed || !isJsonRecord(parsed.value)) return text;
	const values = Object.values(parsed.value);
	if (values.length === 0 || !values.every(value => typeof value === "string")) return text;
	return values.map(value => value.trim()).filter(Boolean).join("\n\n");
}

/** Use structuredContent first, then decode a JSON text block when available. */
export function mcpPayload(result: MCPToolCallResult): unknown {
	if (result.structuredContent !== undefined) return result.structuredContent;
	for (const content of result.content) {
		if (content.type !== "text") continue;
		const parsed = parseJsonText(content.text);
		if (parsed.parsed) return parsed.value;
	}
	return result.content.find(content => content.type === "text")?.text;
}

function findArray(value: unknown, keys: readonly string[], depth = 0): unknown[] | undefined {
	if (depth > 8) return undefined;
	if (Array.isArray(value)) return value;
	if (!isJsonRecord(value)) return undefined;

	for (const key of keys) {
		const candidate = value[key];
		if (Array.isArray(candidate)) return candidate;
	}
	for (const candidate of Object.values(value)) {
		const nested = findArray(candidate, keys, depth + 1);
		if (nested) return nested;
	}
	return undefined;
}

/** Find the first named record array inside an MCP payload. */
export function mcpRecords(result: MCPToolCallResult, keys: readonly string[]): JsonRecord[] | undefined {
	const records = findArray(mcpPayload(result), keys);
	return records?.filter(isJsonRecord);
}

/** The `xd://slack` call that reads a thread, as the model writes it. */
function slackThreadOp(workspace: string, channel: string, ts: string): string {
	return JSON.stringify({ op: "thread", workspace, channel, ts });
}

/**
 * After each message with replies in the Slack app's channel history (`Thread: N replies`) or search results
 * (`Reply count: N`), add the `thread` op that reads it. The channel comes from the nearest `Channel: … (C…)` line.
 */
export function linkSlackThreads(text: string, workspace: string): string {
	let channel: string | undefined;
	let messageTs: string | undefined;
	return text
		.split("\n")
		.map(line => {
			const channelId = line.match(/^Channel: .*\((?:ID: )?([CDG][A-Z0-9]+)\)\s*$/u)?.[1];
			if (channelId) channel = channelId;
			const ts = line.match(/^Message[ _]TS: (\d+\.\d+)\s*$/iu)?.[1];
			if (ts) messageTs = ts;
			if (!channel || !messageTs || !/^(?:Thread: [1-9]\d* repl|Reply count: [1-9])/u.test(line)) return line;
			return `${line} — read: \`${slackThreadOp(workspace, channel, messageTs)}\``;
		})
		.join("\n");
}

export function renderSlackWorkspaces(workspaces: readonly SlackWorkspace[]): string {
	if (workspaces.length === 0) return "The ChatGPT Slack app reports no Slack workspaces.";
	const rows = workspaces.map(workspace => `- ${workspace.teamName} — \`workspace\`: \`${workspace.teamId}\``);
	return `Slack workspaces:\n${rows.join("\n")}`;
}

/** Tool name as the model writes it: the gateway's `slack.` connector prefix dropped. */
export function slackToolDisplayName(tool: MCPToolDefinition): string {
	return tool.name.replace(/^slack\./u, "");
}

export function renderSlackToolList(tools: readonly MCPToolDefinition[]): string {
	if (tools.length === 0) return "The ChatGPT Slack app exposes no tools.";
	return [
		"Slack tools (inspect one with `{\"op\":\"schema\",\"tool\":\"<name>\"}`):",
		...tools.map(tool => {
			const firstLine = tool.description?.split(/\r?\n/u, 1)[0]?.trim();
			const readOnly = tool.annotations?.readOnlyHint ? " (read-only)" : "";
			return `- \`${slackToolDisplayName(tool)}\`${readOnly}${firstLine ? ` — ${firstLine}` : ""}`;
		}),
	].join("\n");
}

export function renderSlackToolSchema(tool: MCPToolDefinition): string {
	const description = tool.description?.trim();
	return `\`${slackToolDisplayName(tool)}\`${description ? `\n\n${description}` : ""}\n\ninputSchema:\n\n\`\`\`json\n${JSON.stringify(tool.inputSchema, null, 2)}\n\`\`\``;
}

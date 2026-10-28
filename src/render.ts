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
		return truncateMarkdown(result.content[0].text);
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

function firstText(record: JsonRecord, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" || typeof value === "number") return String(value);
		if (isJsonRecord(value)) {
			for (const nestedKey of ["display_name", "real_name", "name", "username", "id", "text"]) {
				const nested = value[nestedKey];
				if (typeof nested === "string" || typeof nested === "number") return String(nested);
			}
		}
	}
	return undefined;
}

function messageText(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	if (Array.isArray(value)) return value.map(messageText).filter(Boolean).join("\n");
	if (isJsonRecord(value)) {
		if (typeof value.text === "string") return value.text;
		for (const key of ["elements", "blocks", "content"]) {
			if (value[key] !== undefined) return messageText(value[key]);
		}
	}
	return "";
}

function replyCount(message: JsonRecord): number {
	for (const key of ["reply_count", "replyCount", "num_replies"]) {
		const value = message[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string") {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return Array.isArray(message.replies) ? message.replies.length : 0;
}

function slackUrl(workspace: string, segments: readonly string[]): string {
	return `slack://${encodeURIComponent(workspace)}/${segments.map(encodeURIComponent).join("/")}`;
}

export interface SlackConversationRenderOptions {
	workspace: string;
	channel: string;
	threadTs?: string;
}

/** Render Slack history/thread payloads into linkable Markdown. */
export function renderSlackConversation(
	result: MCPToolCallResult,
	options: SlackConversationRenderOptions,
): string {
	const threadUrl = options.threadTs
		? slackUrl(options.workspace, ["threads", options.channel, options.threadTs])
		: undefined;
	const messages = mcpRecords(result, ["messages", "thread", "replies", "results", "data"]);
	const heading = options.threadTs ? "# Slack thread" : "# Slack channel history";
	const metadata = [
		`Workspace: \`${options.workspace}\``,
		`Channel: \`${options.channel}\``,
		...(threadUrl ? [`Thread: \`${threadUrl}\``] : []),
	].join(" · ");

	if (!messages || messages.length === 0) {
		return truncateMarkdown(`${heading}\n\n${metadata}\n\n${renderMcpResult(result)}`);
	}

	const renderedMessages = messages.map(message => {
		const timestamp = firstText(message, ["ts", "timestamp", "time"]) ?? "unknown timestamp";
		const author = firstText(message, ["author", "user_name", "username", "userName", "user", "user_id", "userId"])
			?? "unknown author";
		const text = messageText(message.text ?? message.message ?? message.content) || "(no text)";
		const replies = replyCount(message);
		const threadHint = replies > 0 && timestamp !== "unknown timestamp"
			? `\n  Thread: \`${slackUrl(options.workspace, ["threads", options.channel, timestamp])}\``
			: "";
		return `- \`${timestamp}\` — **${author}** (replies: ${replies}): ${text}${threadHint}`;
	});
	return truncateMarkdown(`${heading}\n\n${metadata}\n\n${renderedMessages.join("\n\n")}`);
}

export function renderSlackWorkspaces(workspaces: readonly SlackWorkspace[]): string {
	if (workspaces.length === 0) return "No Slack workspaces connected. Run `/slack login` to connect one.";
	const rows = workspaces.map(workspace => {
		const marker = workspace.isDefault ? " (default)" : "";
		const domain = workspace.domain ? ` — ${workspace.domain}.slack.com` : "";
		return `- ${workspace.teamName} (${workspace.teamId})${marker}${domain}`;
	});
	return `Connected Slack workspaces:\n${rows.join("\n")}`;
}

export function renderSlackToolList(tools: readonly MCPToolDefinition[]): string {
	if (tools.length === 0) return "This Slack MCP server exposes no tools.";
	return [
		"Slack MCP tools:",
		...tools.map(tool => {
			const firstLine = tool.description?.split(/\r?\n/u, 1)[0]?.trim();
			return `- \`${tool.name}\`${firstLine ? ` — ${firstLine}` : ""}`;
		}),
	].join("\n");
}

export function renderSlackToolSchema(tool: MCPToolDefinition): string {
	return `\`${tool.name}\` inputSchema:\n\n\`\`\`json\n${JSON.stringify(tool.inputSchema, null, 2) ?? String(tool.inputSchema)}\n\`\`\``;
}

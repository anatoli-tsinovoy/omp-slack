import type { MCPToolCallResult } from "@oh-my-pi/pi-coding-agent/mcp";
import type { ShellFsDirEntry } from "@oh-my-pi/pi-natives";
import {
	InternalUrlRouter,
	parseInternalUrl,
	type InternalResource,
	type InternalUrl,
	type ProtocolHandler,
	type ResolveContext,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import slackProtocolDescription from "./prompts/slack-protocol.md" with { type: "text" };
import { mcpRecords, renderMcpResult, renderSlackConversation, renderSlackWorkspaces } from "./render";
import { findSlackTool, slackCore } from "./core";
import type { SlackCore, SlackWorkspace } from "./types";

export type SlackUrlRoute =
	| { kind: "workspaces" }
	| { kind: "workspace"; selector: string }
	| { kind: "channels"; workspace: string }
	| { kind: "users"; workspace: string }
	| {
		kind: "channel";
		workspace: string;
		channel: string;
		limit?: number;
		oldest?: string;
		latest?: string;
	}
	| { kind: "thread"; workspace: string; channel: string; ts: string }
	| { kind: "user"; workspace: string; userId: string }
	| { kind: "canvas"; workspace: string; canvasId: string }
	| { kind: "file"; workspace: string; fileId: string }
	| { kind: "search"; workspace: string; query: string; scope: "public" | "all"; type?: "files" };


type UrlToolKey =
	| "listChannels"
	| "searchChannels"
	| "readChannel"
	| "readThread"
	| "readUserProfile"
	| "readCanvas"
	| "readFile"
	| "searchPublic"
	| "searchAll";

interface UrlToolArguments {
	teamId?: string;
	channel?: string;
	channelId?: string;
	limit?: number;
	oldest?: string;
	latest?: string;
	threadTs?: string;
	userId?: string;
	canvasId?: string;
	fileId?: string;
	query?: string;
	type?: "files";
}

interface UrlToolDefinition {
	/** Slack tool name without any gateway connector prefix. */
	name: string;
	args: (input: UrlToolArguments) => Record<string, unknown>;
}

/** Split a free-text query into Slack lexical terms, keeping "quoted phrases" whole. */
export function searchKeywords(query: string): string[] {
	return query.match(/"[^"]+"|\S+/gu) ?? [];
}

function searchArgs(input: UrlToolArguments): Record<string, unknown> {
	const query = input.query ?? "";
	return {
		keywords: searchKeywords(query),
		natural_language_query: query,
		...(input.type === undefined ? {} : { content_types: input.type }),
	};
}

/** Keep every URL-to-Slack-tool name and argument mapping in one place. */
const URL_TOOL_TABLE: Record<UrlToolKey, UrlToolDefinition> = {
	listChannels: {
		name: "slack_list_user_channels",
		args: input => ({ limit: 200, ...(input.teamId === undefined ? {} : { team_id: input.teamId }) }),
	},
	searchChannels: {
		name: "slack_search_channels",
		args: input => ({
			keywords: searchKeywords(input.channel ?? ""),
			natural_language_query: input.channel ?? "",
			channel_types: "public_channel,private_channel",
		}),
	},
	readChannel: {
		name: "slack_read_channel",
		args: input => ({
			channel_id: input.channelId ?? "",
			...(input.limit === undefined ? {} : { limit: input.limit }),
			...(input.oldest === undefined ? {} : { oldest: input.oldest }),
			...(input.latest === undefined ? {} : { latest: input.latest }),
		}),
	},
	readThread: {
		name: "slack_read_thread",
		args: input => ({ channel_id: input.channelId ?? "", message_ts: input.threadTs ?? "" }),
	},
	readUserProfile: {
		name: "slack_read_user_profile",
		args: input => (input.userId === undefined || input.userId === "me" ? {} : { user_id: input.userId }),
	},
	readCanvas: {
		name: "slack_read_canvas",
		args: input => ({ canvas_id: input.canvasId ?? "" }),
	},
	readFile: {
		name: "slack_read_file",
		args: input => ({ file_id: input.fileId ?? "" }),
	},
	searchPublic: {
		name: "slack_search_public",
		args: searchArgs,
	},
	searchAll: {
		name: "slack_search_public_and_private",
		args: searchArgs,
	},
};

const DIRECTORY_TYPE = "dir" as ShellFsDirEntry["fileType"];
const FILE_TYPE = "file" as ShellFsDirEntry["fileType"];
let processHandler: ProtocolHandler | undefined;
let processRegistrationCount = 0;

function decodePathSegments(url: InternalUrl): string[] {
	const rawPath = url.rawPathname ?? url.pathname;
	if (!rawPath || rawPath === "/") return [];
	const withoutLeadingSlash = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
	const rawSegments = withoutLeadingSlash.split("/");
	if (rawSegments.at(-1) === "") rawSegments.pop();
	if (rawSegments.some(segment => segment.length === 0)) {
		throw new Error(`Invalid Slack URL path: empty path segment in \`${url.href}\`.`);
	}

	return rawSegments.map(segment => {
		let decoded: string;
		try {
			decoded = decodeURIComponent(segment);
		} catch {
			throw new Error(`Invalid percent-encoding in Slack URL path segment \`${segment}\`.`);
		}
		if (decoded === "." || decoded === ".." || decoded.includes("/")) {
			throw new Error(`Invalid Slack URL path segment \`${decoded}\`; path traversal is not allowed.`);
		}
		return decoded;
	});
}

function assertQueryParameters(url: InternalUrl, allowed: readonly string[]): void {
	const seen = new Set<string>();
	for (const [key] of url.searchParams) {
		if (!allowed.includes(key)) {
			throw new Error(`Unsupported Slack URL query parameter \`${key}\` in \`${url.href}\`.`);
		}
		if (seen.has(key)) throw new Error(`Slack URL query parameter \`${key}\` may appear only once.`);
		seen.add(key);
	}
	if (url.hash) throw new Error("Slack URLs do not support fragments.");
}

function workspaceSelector(authority: string): string {
	const renderedEntry = authority.match(/^.+\s+\(([^()]+)\)$/u);
	return renderedEntry?.[1] ?? authority;
}

/** Parse and validate every supported Slack URL shape before resolving it. */
export function parseSlackUrl(url: InternalUrl): SlackUrlRoute {
	const authority = url.rawHost || url.hostname;
	const segments = decodePathSegments(url);
	if (!authority) {
		assertQueryParameters(url, []);
		if (segments.length === 0) return { kind: "workspaces" };
		throw new Error(`Slack URL \`${url.href}\` needs a workspace selector: slack://<workspace>/...`);
	}

	const workspace = workspaceSelector(authority);
	if (segments.length === 0) {
		assertQueryParameters(url, []);
		return { kind: "workspace", selector: workspace };
	}

	const [area, first, second] = segments;
	if (area === "channels" && segments.length === 1) {
		assertQueryParameters(url, []);
		return { kind: "channels", workspace };
	}
	if (area === "channels" && segments.length === 2 && first) {
		assertQueryParameters(url, ["limit", "oldest", "latest"]);
		const rawLimit = url.searchParams.get("limit");
		const limit = rawLimit === null ? undefined : Number(rawLimit);
		if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
			throw new Error(`Slack channel history \`limit\` must be a positive integer, got \`${rawLimit}\`.`);
		}
		const oldest = url.searchParams.get("oldest") ?? undefined;
		const latest = url.searchParams.get("latest") ?? undefined;
		return {
			kind: "channel",
			workspace,
			channel: first,
			...(limit === undefined ? {} : { limit }),
			...(oldest === undefined ? {} : { oldest }),
			...(latest === undefined ? {} : { latest }),
		};
	}
	if (area === "users" && segments.length === 1) {
		assertQueryParameters(url, []);
		return { kind: "users", workspace };
	}
	if (area === "users" && segments.length === 2 && first) {
		assertQueryParameters(url, []);
		return { kind: "user", workspace, userId: first };
	}
	if (area === "threads" && segments.length === 3 && first && second) {
		assertQueryParameters(url, []);
		return { kind: "thread", workspace, channel: first, ts: second };
	}
	if (area === "canvases" && segments.length === 2 && first) {
		assertQueryParameters(url, []);
		return { kind: "canvas", workspace, canvasId: first };
	}
	if (area === "files" && segments.length === 2 && first) {
		assertQueryParameters(url, []);
		return { kind: "file", workspace, fileId: first };
	}
	if (area === "search" && segments.length === 1) {
		assertQueryParameters(url, ["q", "scope", "type"]);
		const query = url.searchParams.get("q");
		if (!query?.trim()) throw new Error(`Slack search needs a non-empty query: \`${url.href}\`.`);
		const scopeValue = url.searchParams.get("scope");
		if (scopeValue !== null && scopeValue !== "all") {
			throw new Error(`Slack search supports only \`scope=all\`; got \`${scopeValue}\`.`);
		}
		const typeValue = url.searchParams.get("type");
		if (typeValue !== null && typeValue !== "files") {
			throw new Error(`Slack search supports only \`type=files\`; got \`${typeValue}\`.`);
		}
		return {
			kind: "search",
			workspace,
			query,
			scope: scopeValue === "all" ? "all" : "public",
			...(typeValue === "files" ? { type: "files" as const } : {}),
		};
	}
	assertQueryParameters(url, []);
	throw new Error(
		`Unsupported Slack URL path \`${url.pathname}\`. Use slack://<workspace>/, channels/, channels/<name-or-id>, threads/<channel>/<ts>, users/<id-or-me>, canvases/<id>, files/<id>, or search?q=... .`,
	);
}

function directoryEntry(name: string, fileType: "dir" | "file"): ShellFsDirEntry {
	return { name, fileType: fileType === "dir" ? DIRECTORY_TYPE : FILE_TYPE };
}

function stringField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" || typeof value === "number") return String(value);
	}
	return undefined;
}

function channelIdFromSelector(selector: string): string | undefined {
	const embedded = selector.match(/\s+\(([CDG][A-Z0-9]+)\)$/u);
	if (embedded) return embedded[1];
	return /^[CDG][A-Z0-9]+$/u.test(selector) ? selector : undefined;
}

function normalizeChannelName(name: string): string {
	return name.trim().replace(/^#/u, "").toLowerCase();
}

function channelMemoKey(teamId: string, channel: string): string {
	return `${teamId}\u0000${normalizeChannelName(channel)}`;
}

function missingChannelResponse(result: MCPToolCallResult, channel: string): Error {
	return new Error(`Could not resolve Slack channel \`${channel}\`. Slack MCP response:\n${renderMcpResult(result)}`);
}
async function callUrlTool(
	core: SlackCore,
	workspace: SlackWorkspace,
	key: UrlToolKey,
	input: UrlToolArguments,
	signal?: AbortSignal,
): Promise<MCPToolCallResult> {
	const definition = URL_TOOL_TABLE[key];
	const tools = await core.listTools(signal);
	const tool = findSlackTool(tools, definition.name);
	if (!tool) {
		throw new Error(
			`The ChatGPT Slack app does not expose \`${definition.name}\`. Available tools: ${tools.map(candidate => candidate.name).join(", ") || "none"}.`,
		);
	}
	const result = await core.callTool(tool.name, definition.args({ teamId: workspace.teamId, ...input }), signal);
	if (result.isError) throw new Error(renderMcpResult(result));
	return result;
}

interface SlackChannel {
	id: string;
	name: string;
}

function readChannelRecords(result: MCPToolCallResult): SlackChannel[] {
	const records = mcpRecords(result, ["channels", "results", "items", "data"]);
	if (!records) {
		throw new Error(`Slack channel-list response could not be interpreted. Server response:\n${renderMcpResult(result)}`);
	}
	const channels = records.flatMap(record => {
		const id = stringField(record, ["id", "channel_id", "channelId"]);
		const name = stringField(record, ["name", "channel_name", "channelName"]);
		return id && name ? [{ id, name: name.replace(/^#/u, "") }] : [];
	});
	if (records.length > 0 && channels.length === 0) {
		throw new Error(`Slack channel-list response lacked channel names and ids. Server response:\n${renderMcpResult(result)}`);
	}
	return channels;
}

async function listChannels(core: SlackCore, workspace: SlackWorkspace, signal?: AbortSignal): Promise<SlackChannel[]> {
	return readChannelRecords(await callUrlTool(core, workspace, "listChannels", {}, signal));
}

async function resolveChannelId(
	core: SlackCore,
	workspace: SlackWorkspace,
	selector: string,
	memo: Map<string, string>,
	signal?: AbortSignal,
): Promise<string> {
	const directId = channelIdFromSelector(selector);
	if (directId) {
		memo.set(channelMemoKey(workspace.teamId, selector), directId);
		return directId;
	}
	const key = channelMemoKey(workspace.teamId, selector);
	const cached = memo.get(key);
	if (cached) return cached;

	const result = await callUrlTool(core, workspace, "searchChannels", { channel: normalizeChannelName(selector) }, signal);
	const records = mcpRecords(result, ["channels", "results", "items", "data"]);
	if (!records || records.length === 0) throw missingChannelResponse(result, selector);
	const candidates = records.flatMap(record => {
		const id = stringField(record, ["id", "channel_id", "channelId"]);
		const name = stringField(record, ["name", "channel_name", "channelName"]);
		return id ? [{ id, name }] : [];
	});
	const exact = candidates.filter(candidate => candidate.name && normalizeChannelName(candidate.name) === normalizeChannelName(selector));
	const candidate = exact.length === 1 ? exact[0] : exact.length === 0 && candidates.length === 1 ? candidates[0] : undefined;
	if (!candidate) {
		throw new Error(
			`Slack channel name \`${selector}\` matched ${exact.length > 1 || candidates.length > 1 ? "multiple" : "no"} exact channels. Use a channel id. Server response:\n${renderMcpResult(result)}`,
		);
	}
	memo.set(key, candidate.id);
	if (candidate.name) memo.set(channelMemoKey(workspace.teamId, candidate.name), candidate.id);
	return candidate.id;
}

function workspaceRootEntries(workspaces: readonly SlackWorkspace[]): ShellFsDirEntry[] {
	return workspaces.map(workspace => directoryEntry(`${workspace.teamName} (${workspace.teamId})`, "dir"));
}

function channelDirectoryContent(workspace: SlackWorkspace, channels: readonly SlackChannel[]): string {
	if (channels.length === 0) return `No channels are available in ${workspace.teamName}.`;
	const rows = channels.map(channel => {
		const selector = encodeURIComponent(`${channel.name} (${channel.id})`);
		return `- #${channel.name} (${channel.id}) — \`slack://${encodeURIComponent(workspace.teamId)}/channels/${selector}\``;
	});
	return `# Channels in ${workspace.teamName}\n\n${rows.join("\n")}`;
}

function channelDirectoryEntries(channels: readonly SlackChannel[]): ShellFsDirEntry[] {
	return channels.map(channel => directoryEntry(`${channel.name} (${channel.id})`, "file"));
}

function resource(url: InternalUrl, content: string, isDirectory = false): InternalResource {
	return { url: url.href, content, contentType: "text/markdown", immutable: true, isDirectory };
}

export function createSlackProtocolHandler(core: SlackCore = slackCore): ProtocolHandler {
	const channelIds = new Map<string, string>();

	async function resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const route = parseSlackUrl(url);
		const signal = context?.signal;
		switch (route.kind) {
			case "workspaces":
				return resource(url, `# ${renderSlackWorkspaces(await core.listWorkspaces(signal))}`, true);
			case "workspace": {
				const workspace = await core.resolveWorkspace(route.selector, signal);
				const urlPrefix = `slack://${encodeURIComponent(workspace.teamId)}`;
				return resource(
					url,
					`# ${workspace.teamName}\n\n- Channels: \`${urlPrefix}/channels/\`\n- Users: \`${urlPrefix}/users/\`\n- Search: \`${urlPrefix}/search?q=...\``,
					true,
				);
			}
			case "channels": {
				const workspace = await core.resolveWorkspace(route.workspace, signal);
				if (context?.skipDirectoryListing) return resource(url, "", true);
				return resource(url, channelDirectoryContent(workspace, await listChannels(core, workspace, signal)), true);
			}
			case "users": {
				const workspace = await core.resolveWorkspace(route.workspace, signal);
				return resource(
					url,
					`# Slack users in ${workspace.teamName}\n\nRead a profile with \`slack://${encodeURIComponent(workspace.teamId)}/users/<user-id>\` or \`/users/me\`.`,
					true,
				);
			}
			case "channel": {
				const workspace = await core.resolveWorkspace(route.workspace, signal);
				const channelId = await resolveChannelId(core, workspace, route.channel, channelIds, signal);
				const result = await callUrlTool(
					core,
					workspace,
					"readChannel",
					{ channelId, limit: route.limit, oldest: route.oldest, latest: route.latest },
					signal,
				);
				return resource(url, renderSlackConversation(result, { workspace: workspace.teamId, channel: channelId }));
			}
			case "thread": {
				const workspace = await core.resolveWorkspace(route.workspace, signal);
				const channelId = await resolveChannelId(core, workspace, route.channel, channelIds, signal);
				const result = await callUrlTool(core, workspace, "readThread", { channelId, threadTs: route.ts }, signal);
				return resource(
					url,
					renderSlackConversation(result, { workspace: workspace.teamId, channel: channelId, threadTs: route.ts }),
				);
			}
			case "user": {
				const workspace = await core.resolveWorkspace(route.workspace, signal);
				const result = await callUrlTool(core, workspace, "readUserProfile", { userId: route.userId }, signal);
				return resource(url, `# Slack user ${route.userId}\n\n${renderMcpResult(result)}`);
			}
			case "canvas": {
				const workspace = await core.resolveWorkspace(route.workspace, signal);
				const result = await callUrlTool(core, workspace, "readCanvas", { canvasId: route.canvasId }, signal);
				return resource(url, `# Slack canvas ${route.canvasId}\n\n${renderMcpResult(result)}`);
			}
			case "file": {
				const workspace = await core.resolveWorkspace(route.workspace, signal);
				const result = await callUrlTool(core, workspace, "readFile", { fileId: route.fileId }, signal);
				return resource(url, `# Slack file ${route.fileId}\n\n${renderMcpResult(result)}`);
			}
			case "search": {
				const workspace = await core.resolveWorkspace(route.workspace, signal);
				const result = await callUrlTool(
					core,
					workspace,
					route.scope === "all" ? "searchAll" : "searchPublic",
					{ query: route.query, type: route.type },
					signal,
				);
				return resource(url, `# Slack search: ${route.query}\n\n${renderMcpResult(result)}`);
			}
		}
	}

	async function readDirectory(url: InternalUrl, context?: ResolveContext): Promise<ShellFsDirEntry[]> {
		const route = parseSlackUrl(url);
		const signal = context?.signal;
		switch (route.kind) {
			case "workspaces":
				return workspaceRootEntries(await core.listWorkspaces(signal));
			case "workspace":
				await core.resolveWorkspace(route.selector, signal);
				return [directoryEntry("channels", "dir"), directoryEntry("users", "dir"), directoryEntry("search", "file")];
			case "channels": {
				const workspace = await core.resolveWorkspace(route.workspace, signal);
				return channelDirectoryEntries(await listChannels(core, workspace, signal));
			}
			case "users":
				await core.resolveWorkspace(route.workspace, signal);
				return [];
			default:
				throw new Error(`Not a Slack directory: \`${url.href}\`.`);
		}
	}

	async function enumerate(url: InternalUrl, context?: ResolveContext): Promise<Array<{ url: string; content: string }>> {
		const route = parseSlackUrl(url);
		if (route.kind === "workspaces" || route.kind === "workspace" || route.kind === "channels" || route.kind === "users") {
			return [];
		}
		const resolved = await resolve(url, context);
		return [{ url: url.href, content: resolved.content }];
	}

	return {
		scheme: "slack",
		spec: { backing: "remote", selectors: "opaque", immutable: true },
		resolve,
		readDirectory,
		enumerate,
		promptDoc: () => slackProtocolDescription.trim(),
	};
}

/** Register the one process-global handler; the returned cleanup reports whether it was the last registration. */
export function registerSlackProtocol(core: SlackCore = slackCore): () => boolean {
	const router = InternalUrlRouter.instance();
	if (!processHandler) processHandler = createSlackProtocolHandler(core);
	const existing = router.getHandler("slack");
	if (existing && existing !== processHandler) throw new Error("Cannot register slack://: another handler already owns the scheme.");
	if (!existing) router.register(processHandler);
	processRegistrationCount++;

	let released = false;
	return () => {
		if (released) return false;
		released = true;
		processRegistrationCount--;
		if (processRegistrationCount !== 0) return false;
		if (router.getHandler("slack") === processHandler) router.unregister("slack");
		processHandler = undefined;
		return true;
	};
}

export function parseSlackUrlString(value: string): SlackUrlRoute {
	return parseSlackUrl(parseInternalUrl(value));
}

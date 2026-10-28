import type { MCPToolCallResult } from "@oh-my-pi/pi-coding-agent/mcp";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
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
import { mcpRecords, renderMcpResult, renderSlackConversation } from "./render";
import { slackCore } from "./core";
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

export type SlackAuthStorageResolver = (context?: ResolveContext) => AuthStorage | undefined;

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
	name: string;
	args: (input: UrlToolArguments) => Record<string, unknown>;
	discoverBeforeCall?: true;
}

/** Keep every URL-to-MCP name and argument mapping in one place. */
const URL_TOOL_TABLE: Record<UrlToolKey, UrlToolDefinition> = {
	listChannels: {
		name: "slack_list_user_channels",
		args: () => ({}),
		discoverBeforeCall: true,
	},
	searchChannels: {
		name: "slack_search_channels",
		args: input => ({ query: input.channel ?? "" }),
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
		args: input => ({ channel_id: input.channelId ?? "", thread_ts: input.threadTs ?? "" }),
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
		args: input => ({ query: input.query ?? "", ...(input.type === undefined ? {} : { type: input.type }) }),
	},
	searchAll: {
		name: "slack_search_public_and_private",
		args: input => ({ query: input.query ?? "", ...(input.type === undefined ? {} : { type: input.type }) }),
	},
};

const DIRECTORY_TYPE = "dir" as ShellFsDirEntry["fileType"];
const FILE_TYPE = "file" as ShellFsDirEntry["fileType"];
const activeStorageLeases = new Map<symbol, AuthStorage>();
let processHandler: ProtocolHandler | undefined;
let processRegistrationCount = 0;

function latestAuthStorage(): AuthStorage | undefined {
	let latest: AuthStorage | undefined;
	for (const storage of activeStorageLeases.values()) latest = storage;
	return latest;
}

function storageFor(context: ResolveContext | undefined, resolver: SlackAuthStorageResolver): AuthStorage {
	const storage =
		context?.session?.modelRegistry?.authStorage ?? context?.session?.authStorage ?? resolver(context);
	if (!storage) {
		throw new Error("No OMP auth storage is available for slack://. Open the plugin in an OMP session, then run `/slack login`.");
	}
	return storage;
}

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
	storage: AuthStorage,
	workspace: SlackWorkspace,
	key: UrlToolKey,
	input: UrlToolArguments,
	signal?: AbortSignal,
) {
	const definition = URL_TOOL_TABLE[key];
	if (definition.discoverBeforeCall) {
		const tools = await core.listTools(storage, workspace, signal);
		if (!tools.some(tool => tool.name === definition.name)) {
			const available = tools.map(tool => tool.name).join(", ") || "none";
			throw new Error(
				`This Slack MCP server does not expose \`${definition.name}\`, required to list your channels. Available tools: ${available}. Inspect \`read xd://slack\` and run \`{"op":"tools"}\` for the server's tool list.`,
			);
		}
	}
	return core.callTool(storage, workspace, definition.name, definition.args(input), signal);
}

interface SlackChannel {
	id: string;
	name: string;
}

function readChannelRecords(result: MCPToolCallResult): SlackChannel[] {
	if (result.isError) throw new Error(renderMcpResult(result));
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

async function listChannels(
	core: SlackCore,
	storage: AuthStorage,
	workspace: SlackWorkspace,
	signal?: AbortSignal,
): Promise<SlackChannel[]> {
	const result = await callUrlTool(core, storage, workspace, "listChannels", {}, signal);
	return readChannelRecords(result);
}

async function resolveChannelId(
	core: SlackCore,
	storage: AuthStorage,
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

	const result = await callUrlTool(core, storage, workspace, "searchChannels", { channel: selector }, signal);
	if (result.isError) throw new Error(renderMcpResult(result));
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

function workspaceRootContent(workspaces: readonly SlackWorkspace[]): string {
	if (workspaces.length === 0) return "No Slack workspaces connected. Run `/slack login` to connect one.";
	const rows = workspaces.map(workspace => {
		const url = `slack://${encodeURIComponent(workspace.teamId)}/`;
		const marker = workspace.isDefault ? " (default)" : "";
		return `- ${workspace.teamName} (${workspace.teamId})${marker} — \`${url}\``;
	});
	return `# Slack workspaces\n\n${rows.join("\n")}`;
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


export function createSlackProtocolHandler(
	core: SlackCore = slackCore,
	resolveStorage: SlackAuthStorageResolver = () => latestAuthStorage(),
): ProtocolHandler {
	const channelIds = new Map<string, string>();

	async function workspaceFor(storage: AuthStorage, selector: string): Promise<SlackWorkspace> {
		return core.resolveWorkspace(storage, selector);
	}

	async function resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const route = parseSlackUrl(url);
		const storage = storageFor(context, resolveStorage);
		switch (route.kind) {
			case "workspaces": {
				const workspaces = await core.listWorkspaces(storage);
				return resource(url, workspaceRootContent(workspaces), true);
			}
			case "workspace": {
				const workspace = await workspaceFor(storage, route.selector);
				const urlPrefix = `slack://${encodeURIComponent(workspace.teamId)}`;
				return resource(
					url,
					`# ${workspace.teamName}\n\n- Channels: \`${urlPrefix}/channels/\`\n- Users: \`${urlPrefix}/users/\`\n- Search: \`${urlPrefix}/search?q=...\``,
					true,
				);
			}
			case "channels": {
				const workspace = await workspaceFor(storage, route.workspace);
				if (context?.skipDirectoryListing) return resource(url, "", true);
				const channels = await listChannels(core, storage, workspace, context?.signal);
				return resource(url, channelDirectoryContent(workspace, channels), true);
			}
			case "users": {
				const workspace = await workspaceFor(storage, route.workspace);
				return resource(
					url,
					`# Slack users in ${workspace.teamName}\n\nRead a profile with \`slack://${encodeURIComponent(workspace.teamId)}/users/<user-id>\` or \`/users/me\`.`,
					true,
				);
			}
			case "channel": {
				const workspace = await workspaceFor(storage, route.workspace);
				const channelId = await resolveChannelId(core, storage, workspace, route.channel, channelIds, context?.signal);
				const result = await callUrlTool(
					core,
					storage,
					workspace,
					"readChannel",
					{ channelId, limit: route.limit, oldest: route.oldest, latest: route.latest },
					context?.signal,
				);
				if (result.isError) throw new Error(renderMcpResult(result));
				return resource(url, renderSlackConversation(result, { workspace: workspace.teamId, channel: channelId }));
			}
			case "thread": {
				const workspace = await workspaceFor(storage, route.workspace);
				const channelId = await resolveChannelId(core, storage, workspace, route.channel, channelIds, context?.signal);
				const result = await callUrlTool(
					core,
					storage,
					workspace,
					"readThread",
					{ channelId, threadTs: route.ts },
					context?.signal,
				);
				if (result.isError) throw new Error(renderMcpResult(result));
				return resource(
					url,
					renderSlackConversation(result, { workspace: workspace.teamId, channel: channelId, threadTs: route.ts }),
				);
			}
			case "user": {
				const workspace = await workspaceFor(storage, route.workspace);
				const result = await callUrlTool(core, storage, workspace, "readUserProfile", { userId: route.userId }, context?.signal);
				if (result.isError) throw new Error(renderMcpResult(result));
				return resource(url, `# Slack user ${route.userId}\n\n${renderMcpResult(result)}`);
			}
			case "canvas": {
				const workspace = await workspaceFor(storage, route.workspace);
				const result = await callUrlTool(core, storage, workspace, "readCanvas", { canvasId: route.canvasId }, context?.signal);
				if (result.isError) throw new Error(renderMcpResult(result));
				return resource(url, `# Slack canvas ${route.canvasId}\n\n${renderMcpResult(result)}`);
			}
			case "file": {
				const workspace = await workspaceFor(storage, route.workspace);
				const result = await callUrlTool(core, storage, workspace, "readFile", { fileId: route.fileId }, context?.signal);
				if (result.isError) throw new Error(renderMcpResult(result));
				return resource(url, `# Slack file ${route.fileId}\n\n${renderMcpResult(result)}`);
			}
			case "search": {
				const workspace = await workspaceFor(storage, route.workspace);
				const result = await callUrlTool(
					core,
					storage,
					workspace,
					route.scope === "all" ? "searchAll" : "searchPublic",
					{ query: route.query, type: route.type },
					context?.signal,
				);
				if (result.isError) throw new Error(renderMcpResult(result));
				return resource(url, `# Slack search: ${route.query}\n\n${renderMcpResult(result)}`);
			}
		}
	}

	async function readDirectory(url: InternalUrl, context?: ResolveContext): Promise<ShellFsDirEntry[]> {
		const route = parseSlackUrl(url);
		const storage = storageFor(context, resolveStorage);
		switch (route.kind) {
			case "workspaces":
				return workspaceRootEntries(await core.listWorkspaces(storage));
			case "workspace":
				await workspaceFor(storage, route.selector);
				return [directoryEntry("channels", "dir"), directoryEntry("users", "dir"), directoryEntry("search", "file")];
			case "channels": {
				const workspace = await workspaceFor(storage, route.workspace);
				return channelDirectoryEntries(await listChannels(core, storage, workspace, context?.signal));
			}
			case "users":
				await workspaceFor(storage, route.workspace);
				return [];
			default:
				throw new Error(`Not a Slack directory: \`${url.href}\`.`);
		}
	}

	async function enumerate(url: InternalUrl, context?: ResolveContext): Promise<Array<{ url: string; content: string }>> {
		const route = parseSlackUrl(url);
		if (
			route.kind === "workspaces" ||
			route.kind === "workspace" ||
			route.kind === "channels" ||
			route.kind === "users"
		) {
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

/** Register the one process-global handler; returned cleanup reports the last session. */
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
		activeStorageLeases.clear();
		return true;
	};
}

/**
 * Fallback for callers with no session auth storage. It selects the most recently
 * started active session; concurrent profile-less URL calls cannot be disambiguated.
 */
export function trackSlackProtocolStorage(storage: AuthStorage): () => void {
	const lease = Symbol("slack protocol auth storage");
	activeStorageLeases.set(lease, storage);
	return () => {
		activeStorageLeases.delete(lease);
	};
}

export function parseSlackUrlString(value: string): SlackUrlRoute {
	return parseSlackUrl(parseInternalUrl(value));
}



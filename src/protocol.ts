import {
	InternalUrlRouter,
	type InternalResource,
	type InternalUrl,
	type ProtocolHandler,
	type ResolveContext,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ShellFsDirEntry } from "@oh-my-pi/pi-natives";
import { slackCore } from "./core";
import protocolDoc from "./prompts/slack-protocol.md" with { type: "text" };
import { createSlackReads, isChannelId, listedChannels, type SlackChannel, type SlackReadInput, type SlackReadOp } from "./reads";
import type { SlackCore, SlackWorkspace } from "./types";

/**
 * Read-only `slack://` URLs over the curated `xd://slack` reads, as a tree `read`, `glob`, and `grep` walk:
 *
 *   slack://                                    connected workspaces
 *   slack://<workspace>/channels/               channels you're in; each file is its recent history
 *   slack://<workspace>/channels/<name or id>   history (`?limit=&oldest=&latest=`)
 *   slack://<workspace>/threads/<channel>/<ts>  one thread
 *   slack://<workspace>/users/<id or me>        a profile; also canvases/<id>, files/<id>
 *   slack://<workspace>/search?q=…              search results (`&scope=all&type=files&limit=`)
 *
 * The workspace is a team name or id. Content is the Slack app's own text, with each thread linked by its `slack://` URL.
 */

const SCHEME = "slack";
const CACHE_MS = 60_000;
const MAX_CACHED = 128;
const DIRECTORY = "dir" as ShellFsDirEntry["fileType"];
const FILE = "file" as ShellFsDirEntry["fileType"];
/** Slack channel names: lowercase letters, digits, `-`, and `_`; no spaces or periods, so walk probes (`.gitignore`) never match. */
const CHANNEL_NAME = /^#?[\p{L}\p{N}_-]{1,80}$/u;
const HISTORY_PARAMS = ["limit", "oldest", "latest"] as const;
const SEARCH_PARAMS = ["q", "scope", "type", "limit"] as const;
const URL_FORMS =
	"`channels/`, `channels/<name or id>?limit=&oldest=&latest=`, `threads/<channel>/<ts>`, `users/<id or me>`, `canvases/<id>`, `files/<id>`, `search?q=…&scope=all&type=files&limit=`";

export type SlackRoute =
	| { kind: "workspaces" }
	| { kind: "workspace"; workspace: string }
	| { kind: "channels"; workspace: string }
	| { kind: "read"; op: SlackReadOp; input: SlackReadInput & { workspace: string } };

interface ChannelListing {
	channels: SlackChannel[];
	/** `showing N of M total` from the Slack app, when it lists fewer channels than you're in. */
	partial?: string;
}

/** Time-bounded memo of in-flight and settled loads; failures are dropped so the next caller retries. */
class LoadCache<T> {
	readonly #entries = new Map<string, { at: number; value: Promise<T> }>();

	get(key: string, load: () => Promise<T>): Promise<T> {
		const hit = this.#entries.get(key);
		if (hit && Date.now() - hit.at < CACHE_MS) {
			this.#entries.delete(key);
			this.#entries.set(key, hit);
			return hit.value;
		}
		const value = load();
		const entry = { at: Date.now(), value };
		this.#entries.delete(key);
		this.#entries.set(key, entry);
		value.catch(() => {
			if (this.#entries.get(key) === entry) this.#entries.delete(key);
		});
		for (const oldest of this.#entries.keys()) {
			if (this.#entries.size <= MAX_CACHED) break;
			this.#entries.delete(oldest);
		}
		return value;
	}
}

function decodeSegment(segment: string): string {
	let name: string;
	try {
		name = decodeURIComponent(segment);
	} catch {
		name = segment;
	}
	if (name === "." || name === "..") throw new Error(`Invalid slack:// path segment \`${name}\`.`);
	return name;
}

function queryParams(url: InternalUrl, allowed: readonly string[]): Map<string, string> {
	const params = new Map<string, string>();
	for (const [key, value] of url.searchParams) {
		if (!allowed.includes(key)) {
			throw new Error(allowed.length ? `Unsupported slack:// parameter \`${key}\`; use ${allowed.join(", ")}.` : `\`${url.href}\` takes no query string.`);
		}
		if (params.has(key)) throw new Error(`slack:// parameter \`${key}\` may appear only once.`);
		params.set(key, value);
	}
	return params;
}

function positiveLimit(params: Map<string, string>): { limit?: number } {
	const raw = params.get("limit");
	if (raw === undefined) return {};
	const limit = Number(raw);
	if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`slack:// \`limit\` must be a positive integer, got \`${raw}\`.`);
	return { limit };
}

function channelSelector(selector: string): string {
	if (!isChannelId(selector) && !CHANNEL_NAME.test(selector)) {
		throw new Error(`Slack channel \`${selector}\` not found: channel names are letters, digits, \`-\`, and \`_\`.`);
	}
	return selector;
}

/** Parse and validate a `slack://` URL before any gateway call. */
export function parseSlackUrl(url: InternalUrl): SlackRoute {
	if (url.hash) throw new Error("slack:// URLs take no fragment.");
	const workspace = url.rawHost ? decodeSegment(url.rawHost) : "";
	const segments = (url.rawPathname ?? url.pathname).split("/").filter(Boolean).map(decodeSegment);
	if (!workspace) {
		queryParams(url, []);
		if (segments.length) throw new Error("slack:// needs a workspace before the path: `slack://<workspace>/channels/…`.");
		return { kind: "workspaces" };
	}
	const [area, first, second, ...rest] = segments;
	if (area === undefined) {
		queryParams(url, []);
		return { kind: "workspace", workspace };
	}
	if (area === "channels" && first === undefined) {
		queryParams(url, []);
		return { kind: "channels", workspace };
	}
	if (area === "channels" && first !== undefined && second === undefined) {
		const params = queryParams(url, HISTORY_PARAMS);
		const oldest = params.get("oldest");
		const latest = params.get("latest");
		const input = { workspace, channel: channelSelector(first), ...positiveLimit(params), ...(oldest ? { oldest } : {}), ...(latest ? { latest } : {}) };
		return { kind: "read", op: "history", input };
	}
	if (area === "threads" && first !== undefined && second !== undefined && rest.length === 0) {
		if (!/^\d+\.\d+$/u.test(second)) throw new Error(`Slack thread timestamp \`${second}\` not found: timestamps look like \`1700000000.123456\`.`);
		return { kind: "read", op: "thread", input: { workspace, channel: channelSelector(first), ts: second, ...positiveLimit(queryParams(url, ["limit"])) } };
	}
	if (area === "search" && first === undefined) {
		const params = queryParams(url, SEARCH_PARAMS);
		const query = params.get("q")?.trim();
		if (!query) throw new Error("slack://<workspace>/search needs a query: `?q=<words>`.");
		const scope = params.get("scope");
		if (scope !== undefined && scope !== "all" && scope !== "public") throw new Error(`slack:// search \`scope\` is \`all\` or \`public\`, got \`${scope}\`.`);
		const type = params.get("type");
		if (type !== undefined && type !== "files") throw new Error(`slack:// search \`type\` is \`files\`, got \`${type}\`.`);
		return {
			kind: "read",
			op: "search",
			input: { workspace, query, ...(scope === "all" ? { scope } : {}), ...(type ? { type } : {}), ...positiveLimit(params) },
		};
	}
	if (first !== undefined && second === undefined) {
		queryParams(url, []);
		if (area === "users") return { kind: "read", op: "profile", input: { workspace, user: first } };
		if (area === "canvases") return { kind: "read", op: "canvas", input: { workspace, id: first } };
		if (area === "files") return { kind: "read", op: "file", input: { workspace, id: first } };
	}
	throw new Error(`\`${url.href}\` not found. Under slack://<workspace>/ use ${URL_FORMS}.`);
}

/** Root entry names: the team name, or its id when the name is shared or holds a `/`. */
function workspaceNames(workspaces: readonly SlackWorkspace[]): Array<{ name: string; workspace: SlackWorkspace }> {
	const counts = new Map<string, number>();
	for (const { teamName } of workspaces) counts.set(teamName.toLowerCase(), (counts.get(teamName.toLowerCase()) ?? 0) + 1);
	return workspaces.map(workspace => ({
		name: counts.get(workspace.teamName.toLowerCase()) === 1 && !workspace.teamName.includes("/") ? workspace.teamName : workspace.teamId,
		workspace,
	}));
}

function directoryResource(url: InternalUrl, content: string): InternalResource {
	return { url: url.href, content, contentType: "text/markdown", immutable: true, isDirectory: true };
}

export function createSlackProtocolHandler(core: SlackCore = slackCore): ProtocolHandler {
	const reads = createSlackReads(core, (workspace, channel, ts) => `slack://${workspace}/threads/${channel}/${ts}`);
	const listings = new LoadCache<ChannelListing>();
	const texts = new LoadCache<string>();

	function channelsOf(workspace: SlackWorkspace, signal?: AbortSignal): Promise<ChannelListing> {
		return listings.get(workspace.teamId, async () => {
			const text = await reads.run("channels", { workspace: workspace.teamId }, signal);
			const shown = text.match(/showing (\d+) of (\d+) total/u);
			return { channels: listedChannels(text), ...(shown && shown[1] !== shown[2] ? { partial: `${shown[1]} of ${shown[2]}` } : {}) };
		});
	}

	/** Channel names resolve through the cached listing; names you aren't in fall through to the reads' channel search. */
	async function readText(url: InternalUrl, op: SlackReadOp, input: SlackReadInput & { workspace: string }, signal?: AbortSignal): Promise<string> {
		const workspace = await core.resolveWorkspace(input.workspace, signal);
		return texts.get(`${workspace.teamId}\u0000${url.rawPathname ?? url.pathname}?${url.searchParams}`, async () => {
			let channel = input.channel;
			if (channel && !isChannelId(channel)) {
				const name = channel.replace(/^#/u, "").toLowerCase();
				channel = (await channelsOf(workspace, signal)).channels.find(candidate => candidate.name.toLowerCase() === name)?.id ?? channel;
			}
			const text = await reads.run(op, { ...input, workspace: workspace.teamId, ...(channel ? { channel } : {}) }, signal);
			return text.endsWith("\n") ? text : `${text}\n`;
		});
	}

	async function resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const route = parseSlackUrl(url);
		const signal = context?.signal;
		const skip = context?.skipDirectoryListing;
		switch (route.kind) {
			case "workspaces": {
				if (skip) return directoryResource(url, "");
				const rows = workspaceNames(await core.listWorkspaces(signal)).map(({ name, workspace }) => `- ${name}/ — id \`${workspace.teamId}\``);
				return directoryResource(url, ["# Slack workspaces", "", ...rows, "", `Under each workspace: ${URL_FORMS}.`].join("\n"));
			}
			case "workspace": {
				const workspace = await core.resolveWorkspace(route.workspace, signal);
				if (skip) return directoryResource(url, "");
				return directoryResource(url, `# ${workspace.teamName} (\`${workspace.teamId}\`)\n\n- channels/ — channels you're in\n\nAlso: ${URL_FORMS}.`);
			}
			case "channels": {
				const workspace = await core.resolveWorkspace(route.workspace, signal);
				if (skip) return directoryResource(url, "");
				const { channels, partial } = await channelsOf(workspace, signal);
				const rows = channels.map(channel => `- ${channel.name} — #${channel.name} · id \`${channel.id}\``);
				const heading = `# Channels you're in — ${workspace.teamName}${partial ? ` (${partial}; the Slack app lists no more)` : ""}`;
				return directoryResource(url, [heading, "", ...rows].join("\n"));
			}
			case "read": {
				const content = await readText(url, route.op, route.input, signal);
				return { url: url.href, content, contentType: "text/markdown", size: Buffer.byteLength(content, "utf-8"), immutable: true };
			}
		}
	}

	async function readDirectory(url: InternalUrl, context?: ResolveContext): Promise<ShellFsDirEntry[]> {
		const route = parseSlackUrl(url);
		const signal = context?.signal;
		switch (route.kind) {
			case "workspaces":
				return workspaceNames(await core.listWorkspaces(signal)).map(({ name }) => ({ name, fileType: DIRECTORY }));
			case "workspace":
				await core.resolveWorkspace(route.workspace, signal);
				return [{ name: "channels", fileType: DIRECTORY }];
			case "channels": {
				const { channels } = await channelsOf(await core.resolveWorkspace(route.workspace, signal), signal);
				// Metadata up front, so a walk doesn't stat (and fetch) each channel's history before filtering.
				return channels.map(channel => ({ name: channel.name, fileType: FILE, metadata: { fileType: FILE, size: 0, mode: 0o444 } }));
			}
			case "read":
				throw new Error(`\`${url.href}\` is a file, not a folder.`);
		}
	}

	return {
		scheme: SCHEME,
		spec: { backing: "remote", selectors: "lines", pathAuthority: true, immutable: true },
		resolve,
		readDirectory,
		promptDoc: () => protocolDoc.trim(),
	};
}

/** Install `slack://` on the process-global router; the returned cleanup removes it. */
export function registerSlackProtocol(core: SlackCore = slackCore): () => void {
	const router = InternalUrlRouter.instance();
	if (router.getHandler(SCHEME)) throw new Error("Cannot register slack://: another handler already owns the scheme.");
	const handler = createSlackProtocolHandler(core);
	router.register(handler);
	return () => {
		if (router.getHandler(SCHEME) === handler) router.unregister(SCHEME);
	};
}

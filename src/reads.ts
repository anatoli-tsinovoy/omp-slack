import type { MCPToolCallResult } from "@oh-my-pi/pi-coding-agent/mcp";
import { findSlackTool } from "./core";
import { linkSlackThreads, renderMcpResult } from "./render";
import type { SlackCore, SlackWorkspace } from "./types";

/** Curated `xd://slack` reads: workspace and channel names resolve to ids, and history links its threads. */
export const SLACK_READ_OPS = ["channels", "history", "thread", "profile", "canvas", "file", "search"] as const;
export type SlackReadOp = (typeof SLACK_READ_OPS)[number];

export interface SlackReadInput {
	/** Team id or name; optional when one workspace is connected. */
	workspace?: string;
	/** Channel id, name, or `#name`; a name prefix for `channels`. */
	channel?: string;
	/** Parent message timestamp of a thread. */
	ts?: string;
	/** User id; omitted or `me` reads the authenticated user. */
	user?: string;
	/** Canvas or file id. */
	id?: string;
	query?: string;
	/** `all` adds private channels and DMs to a search. */
	scope?: "public" | "all";
	/** `files` searches files instead of messages. */
	type?: "files";
	limit?: number;
	oldest?: string;
	latest?: string;
}

export interface SlackReads {
	run(op: SlackReadOp, input: SlackReadInput, signal?: AbortSignal): Promise<string>;
}

export function isSlackReadOp(op: string): op is SlackReadOp {
	return SLACK_READ_OPS.some(candidate => candidate === op);
}

/** Split a free-text query into Slack lexical terms, keeping "quoted phrases" whole. */
function searchKeywords(query: string): string[] {
	return query.match(/"[^"]+"|\S+/gu) ?? [];
}

const SEARCH_MODIFIER = /^-?(?:in|from|to|creator|is|has|hasmy|before|after|on|during|type):\S/u;

/** Slack search arguments for one free-text query: modifiers go to `filters`, everything else is lexical and semantic text. */
function searchArgs(query: string): { keywords: string[]; natural_language_query: string; filters?: string } {
	const terms = searchKeywords(query);
	const filters = terms.filter(term => SEARCH_MODIFIER.test(term));
	const keywords = terms.filter(term => !SEARCH_MODIFIER.test(term));
	return {
		keywords,
		natural_language_query: keywords.join(" "),
		...(filters.length > 0 ? { filters: filters.join(" ") } : {}),
	};
}

function required(op: SlackReadOp, field: keyof SlackReadInput, value: string | undefined): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new Error(`Slack "${op}" needs \`${field}\`.`);
	return trimmed;
}

function normalizeChannelName(name: string): string {
	return name.trim().replace(/^#/u, "").toLowerCase();
}

function isChannelId(selector: string): boolean {
	return /^[CDG][A-Z0-9]{6,}$/u.test(selector);
}

interface SlackChannel {
	id: string;
	name: string;
}

/** `### #name` / `- **ID:** C…` entries of `slack_list_user_channels`. */
function listedChannels(text: string): SlackChannel[] {
	return [...text.matchAll(/^### #(\S+)\s*\n- \*\*ID:\*\* ([CDG][A-Z0-9]+)/gmu)].map(([, name = "", id = ""]) => ({ id, name }));
}

/** `Name: #name` … `/archives/C…` result blocks of `slack_search_channels`. */
function searchedChannels(text: string): SlackChannel[] {
	return text.split(/^### Result /mu).flatMap(block => {
		const name = block.match(/^Name: #(\S+)/mu)?.[1];
		const id = block.match(/\/archives\/([CDG][A-Z0-9]+)/u)?.[1];
		return name && id ? [{ id, name }] : [];
	});
}

export function createSlackReads(core: SlackCore): SlackReads {
	const channelIds = new Map<string, string>();

	async function call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
		const tools = await core.listTools(signal);
		const tool = findSlackTool(tools, name);
		if (!tool) {
			throw new Error(
				`The ChatGPT Slack app does not expose \`${name}\`. Available tools: ${tools.map(candidate => candidate.name).join(", ") || "none"}.`,
			);
		}
		const result: MCPToolCallResult = await core.callTool(tool.name, args, signal);
		const text = renderMcpResult(result);
		if (result.isError) throw new Error(text);
		return text;
	}

	/** Channels you belong to first (`name_prefix`), then a channel search for public channels you haven't joined. */
	async function resolveChannelId(workspace: SlackWorkspace, selector: string, signal?: AbortSignal): Promise<string> {
		if (isChannelId(selector)) return selector;
		const name = normalizeChannelName(selector);
		const key = `${workspace.teamId}\u0000${name}`;
		const cached = channelIds.get(key);
		if (cached) return cached;

		const exact = (channels: SlackChannel[]) => channels.filter(channel => normalizeChannelName(channel.name) === name);
		let matches = exact(listedChannels(await call("slack_list_user_channels", { name_prefix: name, limit: 200, team_id: workspace.teamId }, signal)));
		let response = "";
		if (matches.length === 0) {
			response = await call(
				"slack_search_channels",
				{ keywords: searchKeywords(name), natural_language_query: name, channel_types: "public_channel,private_channel" },
				signal,
			);
			matches = exact(searchedChannels(response));
		}
		const ids = new Set(matches.map(channel => channel.id));
		const [id] = ids;
		if (ids.size !== 1 || !id) {
			throw new Error(
				`Slack channel \`${selector}\` matched ${ids.size > 1 ? "several" : "no"} channels in ${workspace.teamName}; pass its channel id.${response ? ` Channel search:\n${response}` : ""}`,
			);
		}
		channelIds.set(key, id);
		return id;
	}

	return {
		async run(op, input, signal) {
			const workspace = await core.resolveWorkspace(input.workspace, signal);
			switch (op) {
				case "channels": {
					const prefix = input.channel?.trim() ? normalizeChannelName(input.channel) : undefined;
					return call(
						"slack_list_user_channels",
						{ limit: input.limit ?? 200, team_id: workspace.teamId, ...(prefix ? { name_prefix: prefix } : {}) },
						signal,
					);
				}
				case "history": {
					const channel = await resolveChannelId(workspace, required(op, "channel", input.channel), signal);
					const history = await call(
						"slack_read_channel",
						{
							channel_id: channel,
							...(input.limit === undefined ? {} : { limit: input.limit }),
							...(input.oldest === undefined ? {} : { oldest: input.oldest }),
							...(input.latest === undefined ? {} : { latest: input.latest }),
						},
						signal,
					);
					return linkSlackThreads(history, workspace.teamId);
				}
				case "thread": {
					const channel = await resolveChannelId(workspace, required(op, "channel", input.channel), signal);
					return call(
						"slack_read_thread",
						{ channel_id: channel, message_ts: required(op, "ts", input.ts), ...(input.limit === undefined ? {} : { limit: input.limit }) },
						signal,
					);
				}
				case "profile": {
					const user = input.user?.trim();
					return call("slack_read_user_profile", !user || user === "me" ? {} : { user_id: user }, signal);
				}
				case "canvas":
					return call("slack_read_canvas", { canvas_id: required(op, "id", input.id) }, signal);
				case "file":
					return call("slack_read_file", { file_id: required(op, "id", input.id) }, signal);
				case "search": {
					const query = required(op, "query", input.query);
					const results = await call(
						input.scope === "all" ? "slack_search_public_and_private" : "slack_search_public",
						{
							...searchArgs(query),
							...(input.type === undefined ? {} : { content_types: input.type }),
							...(input.limit === undefined ? {} : { limit: input.limit }),
						},
						signal,
					);
					return linkSlackThreads(results, workspace.teamId);
				}
			}
		},
	};
}

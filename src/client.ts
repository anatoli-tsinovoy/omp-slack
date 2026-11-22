import {
	callTool as callMCPTool,
	connectToServer,
	disconnectServer,
	listTools as listMCPTools,
} from "@oh-my-pi/pi-coding-agent/mcp";
import type {
	HostedMCPConnection,
	MCPConnectOptions,
	MCPHttpServerConfig,
	MCPToolCallResult,
	MCPToolDefinition,
} from "@oh-my-pi/pi-coding-agent/mcp";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import type { ChatGPTAuth } from "./credentials";
import { SlackAuthError } from "./errors";
import { CHATGPT_APPS_MCP_URL, type ChatGPTCredential, SLACK_CONNECTOR_ID } from "./types";

export interface SlackGatewayOptions {
	endpoint?: string;
	connectorId?: string;
	/** Override the process MCP host, primarily for integration tests. */
	access?: MCPConnectOptions["access"];
	/** Called when the gateway announces `notifications/tools/list_changed`. */
	onToolsChanged?: () => void;
}

interface GatewayConnection {
	connection: HostedMCPConnection;
	/** Access token the hosted MCP link currently sends. */
	access: string;
	active: number;
	retired: boolean;
	closing?: Promise<void>;
}

function isHttpAuthFailure(error: unknown): error is MCPTransportError {
	return error instanceof MCPTransportError && error.failure === "http_status" && (error.code === 401 || error.code === 403);
}

function rejectedLogin(cause: unknown): SlackAuthError {
	return new SlackAuthError(
		"ChatGPT rejected the Slack plugin's refreshed login. Have the user run `/slack login`.",
		{ cause },
	);
}

/** Honest OMP identity plus the ChatGPT workspace the plugin login belongs to. */
export function gatewayHeaders(credential: ChatGPTCredential): Record<string, string> {
	return {
		Authorization: `Bearer ${credential.access}`,
		"ChatGPT-Account-ID": credential.accountId,
		"X-OpenAI-Product-Sku": "codex",
		originator: "omp",
	};
}

/** ChatGPT returns `structuredContent: null` for absent payloads; MCP models it as an optional record. */
function normalizeResult(result: MCPToolCallResult): MCPToolCallResult {
	const structured: unknown = result.structuredContent;
	if (structured !== null) return result;
	const { structuredContent: _absent, ...rest } = result;
	return rest;
}

/**
 * One lazily-opened connection to the ChatGPT apps MCP gateway. Only tools whose
 * `_meta.connector_id` is the ChatGPT Slack app are listed or callable.
 */
export class SlackGatewayClient {
	readonly #auth: ChatGPTAuth;
	readonly #endpoint: string;
	readonly #connectorId: string;
	readonly #access: MCPConnectOptions["access"];
	readonly #onToolsChanged: (() => void) | undefined;
	#entry: Promise<GatewayConnection> | undefined;
	#tools: Promise<MCPToolDefinition[]> | undefined;

	constructor(auth: ChatGPTAuth, options: SlackGatewayOptions = {}) {
		this.#auth = auth;
		this.#endpoint = options.endpoint ?? CHATGPT_APPS_MCP_URL;
		this.#connectorId = options.connectorId ?? SLACK_CONNECTOR_ID;
		this.#access = options.access;
		this.#onToolsChanged = options.onToolsChanged;
	}

	listTools(signal?: AbortSignal): Promise<MCPToolDefinition[]> {
		signal?.throwIfAborted();
		if (!this.#tools) {
			const pending = this.#withConnection(signal, async entry => {
				entry.connection.tools = undefined;
				const all = await listMCPTools(entry.connection, signal ? { signal } : undefined);
				return all.filter(tool => tool._meta?.connector_id === this.#connectorId);
			});
			this.#tools = pending;
			pending.catch(() => {
				if (this.#tools === pending) this.#tools = undefined;
			});
		}
		return this.#tools;
	}

	async callTool(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<MCPToolCallResult> {
		const tools = await this.listTools(signal);
		if (!tools.some(candidate => candidate.name === tool)) {
			throw new Error(
				`\`${tool}\` is not a tool of the ChatGPT Slack app. Available: ${tools.map(candidate => candidate.name).join(", ") || "none"}.`,
			);
		}
		return this.#withConnection(signal, async entry =>
			normalizeResult(await callMCPTool(entry.connection, tool, args, signal ? { signal } : undefined)),
		);
	}

	/** Drop the cached tool list and connection (logout, re-login). */
	async reset(): Promise<void> {
		this.#tools = undefined;
		await this.closeAll();
	}

	async closeAll(): Promise<void> {
		const pending = this.#entry;
		this.#entry = undefined;
		const entry = await pending?.catch(() => undefined);
		if (entry) await this.#retire(entry);
	}

	async #withConnection<T>(signal: AbortSignal | undefined, run: (entry: GatewayConnection) => Promise<T>): Promise<T> {
		const entry = await this.#acquire(signal);
		entry.active += 1;
		try {
			return await run(entry);
		} catch (error) {
			if (isHttpAuthFailure(error)) throw rejectedLogin(error);
			throw error;
		} finally {
			entry.active -= 1;
			if (entry.retired && entry.active === 0) void this.#close(entry);
		}
	}

	async #acquire(signal?: AbortSignal): Promise<GatewayConnection> {
		const credential = await this.#auth.current(signal);
		const pending = this.#entry;
		if (pending) {
			const entry = await pending.catch(() => undefined);
			if (entry && !entry.retired && entry.access === credential.access) return entry;
			if (this.#entry === pending) {
				this.#entry = undefined;
				if (entry) void this.#retire(entry);
			}
			if (this.#entry) return this.#acquire(signal);
		}
		const opening = this.#open(credential, signal);
		this.#entry = opening;
		opening.catch(() => {
			if (this.#entry === opening) this.#entry = undefined;
		});
		return opening;
	}

	async #open(credential: ChatGPTCredential, signal?: AbortSignal): Promise<GatewayConnection> {
		let current = credential;
		let entry: GatewayConnection | undefined;
		let connection: HostedMCPConnection;
		try {
			connection = await this.#connect(current, signal, async () => {
				current = await this.#auth.recover(current.access, entry ? undefined : signal);
				if (entry) entry.access = current.access;
				return gatewayHeaders(current);
			});
		} catch (error) {
			if (isHttpAuthFailure(error)) throw rejectedLogin(error);
			throw error;
		}
		entry = { connection, access: current.access, active: 0, retired: false };
		return entry;
	}

	#connect(
		credential: ChatGPTCredential,
		signal: AbortSignal | undefined,
		onAuthError: NonNullable<MCPConnectOptions["onAuthError"]>,
	): Promise<HostedMCPConnection> {
		const config: MCPHttpServerConfig = {
			type: "http",
			url: this.#endpoint,
			headerPolicy: "origin-locked",
			headers: gatewayHeaders(credential),
		};
		return connectToServer("slack", config, {
			...(signal ? { signal } : {}),
			access: this.#access,
			live: true,
			onAuthError,
			onNotification: method => {
				if (method !== "notifications/tools/list_changed") return;
				this.#tools = undefined;
				this.#onToolsChanged?.();
			},
		});
	}

	#retire(entry: GatewayConnection): Promise<void> {
		entry.retired = true;
		if (entry.active > 0) return Promise.resolve();
		return this.#close(entry);
	}

	#close(entry: GatewayConnection): Promise<void> {
		entry.closing ??= disconnectServer(entry.connection).catch(() => { });
		return entry.closing;
	}
}

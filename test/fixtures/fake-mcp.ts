import { MCP_LEGACY_PROTOCOL_VERSION, type MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { SLACK_CONNECTOR_ID } from "../../src/types";

export interface FakeGatewayRequest {
	method: string;
	authorization: string | null;
	accountId: string | null;
}

export interface FakeGatewayToolCall {
	name: string;
	args: Record<string, unknown>;
}

export interface FakeGatewayOptions {
	/** Bearer tokens answered with HTTP 401. */
	rejectedTokens?: Set<string>;
	onToolCall?: (call: FakeGatewayToolCall) => unknown;
	redirectDiscoverTo?: string;
}

export interface FakeGateway {
	endpoint: string;
	requests: FakeGatewayRequest[];
	setTools(tools: MCPToolDefinition[]): void;
	waitForSse(): Promise<void>;
	notifyToolsChanged(): void;
	stop(): Promise<void>;
}

/** Gateway tools: two from the ChatGPT Slack app, one from another connector. */
export const FAKE_GATEWAY_TOOLS: MCPToolDefinition[] = [
	{
		name: "slack.slack_list_workspaces",
		description: "Lists Slack workspaces",
		inputSchema: { type: "object", properties: { limit: { type: "number" } } },
		_meta: { connector_id: SLACK_CONNECTOR_ID },
	},
	{
		name: "slack.slack_read_channel",
		description: "Reads a channel",
		inputSchema: { type: "object", properties: { channel_id: { type: "string" } }, required: ["channel_id"] },
		_meta: { connector_id: SLACK_CONNECTOR_ID },
	},
	{
		name: "gmail.search_emails",
		description: "Another connector",
		inputSchema: { type: "object" },
		_meta: { connector_id: "connector_gmail" },
	},
];

function response(id: unknown, result: unknown): Response {
	return Response.json({ jsonrpc: "2.0", id, result });
}

export function createFakeGateway(options: FakeGatewayOptions = {}): FakeGateway {
	const requests: FakeGatewayRequest[] = [];
	const tools = [...FAKE_GATEWAY_TOOLS];
	const sseListeners = new Set<ReadableStreamDefaultController<Uint8Array>>();
	const sseWaiters = new Set<() => void>();
	const encoder = new TextEncoder();
	let eventId = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const authorization = request.headers.get("Authorization");
			const accountId = request.headers.get("ChatGPT-Account-ID");
			if (request.method === "GET") {
				requests.push({ method: "GET", authorization, accountId });
				if (!request.headers.get("Accept")?.includes("text/event-stream")) return new Response(null, { status: 405 });
				let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
				const body = new ReadableStream<Uint8Array>({
					start(streamController) {
						controller = streamController;
						sseListeners.add(streamController);
						streamController.enqueue(encoder.encode(": ready\n\n"));
						for (const resolve of sseWaiters) resolve();
						sseWaiters.clear();
					},
					cancel() {
						if (controller) sseListeners.delete(controller);
					},
				});
				return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
			}
			if (request.method === "DELETE") {
				requests.push({ method: "DELETE", authorization, accountId });
				return new Response(null, { status: 200 });
			}
			const payload: unknown = await request.json().catch(() => undefined);
			if (!isRecord(payload) || typeof payload.method !== "string") {
				return new Response("Malformed JSON-RPC request", { status: 400 });
			}
			requests.push({ method: payload.method, authorization, accountId });
			const token = authorization?.replace(/^Bearer /u, "");
			if (token && options.rejectedTokens?.has(token)) return new Response("Unauthorized", { status: 401 });
			if (payload.method === "server/discover" && options.redirectDiscoverTo) {
				return new Response(null, { status: 307, headers: { Location: options.redirectDiscoverTo } });
			}
			if (!("id" in payload)) return new Response(null, { status: 202 });

			switch (payload.method) {
				case "initialize":
					return response(payload.id, {
						protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
						capabilities: { tools: { listChanged: true } },
						serverInfo: { name: "fake-chatgpt-apps", version: "1.0.0" },
					});
				case "tools/list":
					return response(payload.id, { tools });
				case "tools/call": {
					const params = isRecord(payload.params) ? payload.params : {};
					const call = {
						name: typeof params.name === "string" ? params.name : "",
						args: isRecord(params.arguments) ? params.arguments : {},
					};
					const result = options.onToolCall?.(call) ?? {
						content: [{ type: "text", text: JSON.stringify({ ok: true, teams: [{ id: "T1", name: "Simply" }] }) }],
						structuredContent: null,
					};
					return response(payload.id, result);
				}
				default:
					return Response.json({
						jsonrpc: "2.0",
						id: payload.id,
						error: { code: -32_601, message: `Unsupported method: ${payload.method}` },
					});
			}
		},
	});

	return {
		endpoint: new URL("/backend-api/ps/mcp", server.url).toString(),
		requests,
		setTools(next) {
			tools.splice(0, tools.length, ...next);
		},
		async waitForSse() {
			if (sseListeners.size > 0) return;
			const { promise, resolve } = Promise.withResolvers<void>();
			sseWaiters.add(resolve);
			await promise;
		},
		notifyToolsChanged() {
			const data = encoder.encode(
				`id: ${++eventId}\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: {} })}\n\n`,
			);
			for (const listener of sseListeners) {
				try {
					listener.enqueue(data);
				} catch {
					sseListeners.delete(listener);
				}
			}
		},
		stop: async () => {
			await server.stop(true);
		},
	};
}

import { MCP_PROTOCOL_VERSION } from "@oh-my-pi/pi-coding-agent/mcp";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";

export interface FakeMCPRequest {
 method: string;
 authorization: string | null;
}

export interface FakeMCPToolCall {
 attempt: number;
 name: string;
 args: Record<string, unknown>;
 authorization: string | null;
}

export type FakeMCPToolReply =
 | { kind: "result"; result: unknown }
 | { kind: "http-error"; status: number; body?: string };

export interface FakeMCPServerOptions {
 initializeDelayMs?: number;
 onToolCall?: (call: FakeMCPToolCall) => FakeMCPToolReply | Promise<FakeMCPToolReply>;
}

export interface FakeMCPServer {
 endpoint: string;
 requests: FakeMCPRequest[];
 stop(): Promise<void>;
}


function response(id: unknown, result: unknown): Response {
 return Response.json({ jsonrpc: "2.0", id, result });
}

export function createFakeMCPServer(options: FakeMCPServerOptions = {}): FakeMCPServer {
 const requests: FakeMCPRequest[] = [];
 let toolAttempt = 0;
 const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
   let payload: unknown;
   try {
    payload = await request.json();
   } catch {
    return new Response("Malformed JSON", { status: 400 });
   }
   if (!isRecord(payload) || typeof payload.method !== "string") {
    return new Response("Malformed JSON-RPC request", { status: 400 });
   }
   const method = payload.method;
   requests.push({ method, authorization: request.headers.get("Authorization") });
   if (!("id" in payload)) return new Response(null, { status: 202 });

   if (method === "initialize") {
    const delay = options.initializeDelayMs;
    if (delay !== undefined && delay > 0) {
     const { promise, resolve } = Promise.withResolvers<void>();
     setTimeout(resolve, delay);
     await promise;
    }
    return response(payload.id, {
     protocolVersion: MCP_PROTOCOL_VERSION,
     capabilities: { tools: {} },
     serverInfo: { name: "fake-slack", version: "1.0.0" },
    });
   }
   if (method === "tools/list") {
    return response(payload.id, {
     tools: [
      {
       name: "slack_search_public",
       description: "Search messages",
       inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
     ],
    });
   }
   if (method === "tools/call") {
    const params = isRecord(payload.params) ? payload.params : {};
    const args = isRecord(params.arguments) ? params.arguments : {};
    toolAttempt += 1;
    const reply = await options.onToolCall?.({
     attempt: toolAttempt,
     name: typeof params.name === "string" ? params.name : "",
     args,
     authorization: request.headers.get("Authorization"),
    }) ?? { kind: "result", result: { content: [{ type: "text", text: "ok" }] } };
    if (reply.kind === "http-error") {
     return new Response(reply.body ?? "Unauthorized", { status: reply.status });
    }
    return response(payload.id, reply.result);
   }
   return Response.json({
    jsonrpc: "2.0",
    id: payload.id,
    error: { code: -32_601, message: `Unsupported method: ${method}` },
   });
  },
 });

 return {
  endpoint: new URL("/mcp", server.url).toString(),
  requests,
  stop: async () => {
   await server.stop(true);
  },
 };
}

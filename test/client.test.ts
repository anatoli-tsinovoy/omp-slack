import { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-utils";
import { describe, expect, test } from "bun:test";
import { SLACK_TOKEN_URL, slackWorkspaceCredentialId } from "../src/config";
import type { SlackStoredWorkspaceCredential } from "../src/auth";
import { SlackAuthError, createSlackCore } from "../src/core";
import type { SlackWorkspace } from "../src/types";
import { createFakeMCPServer } from "./fixtures/fake-mcp";


function workspace(): SlackWorkspace {
 return {
  teamId: "T_ACME",
  teamName: "Acme",
  userId: "U_ALICE",
  domain: "acme",
  isDefault: true,
 };
}

async function seedWorkspace(storage: AuthStorage, expires: number): Promise<void> {
 const credential: SlackStoredWorkspaceCredential = {
  type: "oauth",
  access: "old-access-token",
  refresh: "old-refresh-token",
  expires,
  accountId: "T_ACME",
  teamId: "T_ACME",
  teamName: "Acme",
  userId: "U_ALICE",
  domain: "acme",
  isDefault: true,
 };
 await storage.credentials.set(slackWorkspaceCredentialId("T_ACME"), credential);
}

function refreshFetcher(
 handler: (form: URLSearchParams) => Response | Promise<Response>,
): FetchImpl {
 return async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== SLACK_TOKEN_URL) throw new Error(`Unexpected refresh request: ${url}`);
  const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
  return handler(form);
 };
}

describe("Slack MCP client", () => {
 test("connects only on first use and shares concurrent first connections", async () => {
  const storage = await AuthStorage.create(":memory:");
  const server = createFakeMCPServer({ initializeDelayMs: 25 });
  const core = createSlackCore({ client: { endpoint: server.endpoint }, auth: { env: {} } });
  try {
   await seedWorkspace(storage, Date.now() + 3_600_000);
   expect(server.requests).toHaveLength(0);

   const results = await Promise.all([
    core.callTool(storage, workspace(), "slack_search_public", { query: "decision" }),
    core.callTool(storage, workspace(), "slack_search_public", { query: "launch" }),
   ]);

   expect(results).toHaveLength(2);
   expect(server.requests.filter(request => request.method === "initialize")).toHaveLength(1);
   expect(server.requests.filter(request => request.method === "notifications/initialized")).toHaveLength(1);
   expect(server.requests.filter(request => request.method === "tools/list")).toHaveLength(0);
   expect(server.requests.filter(request => request.method === "tools/call")).toHaveLength(2);
  } finally {
   await core.closeAll();
   await server.stop();
   storage.close();
  }
 });

 test("refreshes on HTTP 401, retries once, and persists a rotated refresh token", async () => {
  const storage = await AuthStorage.create(":memory:");
  const toolCalls: Array<{ authorization: string | null; attempt: number }> = [];
  const server = createFakeMCPServer({
   onToolCall(call) {
    toolCalls.push({ authorization: call.authorization, attempt: call.attempt });
    if (call.attempt === 1) return { kind: "http-error", status: 401, body: "expired token" };
    return { kind: "result", result: { content: [{ type: "text", text: "sent" }] } };
   },
  });
  let refreshCount = 0;
  const fetch: FetchImpl = refreshFetcher(form => {
   refreshCount += 1;
   expect(form.get("grant_type")).toBe("refresh_token");
   expect(form.get("refresh_token")).toBe("old-refresh-token");
   expect(form.get("client_id")).toBe("client-id");
   expect(form.get("client_secret")).toBe("client-secret");
   return Response.json({
    ok: true,
    access_token: "new-access-token",
    refresh_token: "rotated-refresh-token",
    expires_in: 3600,
   });
  });
  const core = createSlackCore({
   auth: { env: {}, fetch },
   client: { endpoint: server.endpoint },
  });
  try {
   await seedWorkspace(storage, Date.now() + 3_600_000);
   await core.saveClientCredentials(storage, { clientId: "client-id", clientSecret: "client-secret" });

   const result = await core.callTool(storage, workspace(), "slack_send_message", { channel: "C1", text: "hello" });

   expect(result.content).toEqual([{ type: "text", text: "sent" }]);
   expect(toolCalls).toEqual([
    { authorization: "Bearer old-access-token", attempt: 1 },
    { authorization: "Bearer new-access-token", attempt: 2 },
   ]);
   expect(refreshCount).toBe(1);
   expect(storage.credentials.get(slackWorkspaceCredentialId("T_ACME"))).toMatchObject({
    access: "new-access-token",
    refresh: "rotated-refresh-token",
   });
  } finally {
   await core.closeAll();
   await server.stop();
   storage.close();
  }
 });

 test("converts Slack HTTP 200 ok:false refresh responses into login guidance", async () => {
  const storage = await AuthStorage.create(":memory:");
  const server = createFakeMCPServer();
  const fetch: FetchImpl = refreshFetcher(() => Response.json({ ok: false, error: "invalid_refresh_token" }));
  const core = createSlackCore({ auth: { env: {}, fetch }, client: { endpoint: server.endpoint } });
  try {
   await seedWorkspace(storage, Date.now() - 1);
   await core.saveClientCredentials(storage, { clientId: "client-id" });

   let caught: unknown;
   try {
    await core.callTool(storage, workspace(), "slack_search_public", { query: "hello" });
   } catch (error) {
    caught = error;
   }

   expect(caught).toBeInstanceOf(SlackAuthError);
   expect((caught as Error).message).toContain("invalid_refresh_token");
   expect((caught as Error).message).toContain("/slack login T_ACME");
   expect(server.requests).toHaveLength(0);
  } finally {
   await core.closeAll();
   await server.stop();
   storage.close();
  }
 });

 test("uses non-expiring tokens without attempting OAuth refresh", async () => {
  const storage = await AuthStorage.create(":memory:");
  const server = createFakeMCPServer();
  let refreshAttempts = 0;
  const fetch: FetchImpl = async () => {
   refreshAttempts += 1;
   throw new Error("A permanent token should not be refreshed");
  };
  const core = createSlackCore({ auth: { env: {}, fetch }, client: { endpoint: server.endpoint } });
  try {
   const permanentCredential: SlackStoredWorkspaceCredential = {
    type: "oauth",
    access: "permanent-access-token",
    refresh: "",
    expires: Number.MAX_SAFE_INTEGER,
    accountId: "T_ACME",
    teamId: "T_ACME",
    teamName: "Acme",
    userId: "U_ALICE",
    isDefault: true,
   };
   await storage.credentials.set(slackWorkspaceCredentialId("T_ACME"), permanentCredential);

   await core.callTool(storage, workspace(), "slack_search_public", { query: "hello" });

   expect(refreshAttempts).toBe(0);
   expect(server.requests.filter(request => request.method === "tools/call")).toHaveLength(1);
  } finally {
   await core.closeAll();
   await server.stop();
   storage.close();
  }
 });

 test("returns tool-level error results without throwing and memoizes tools/list", async () => {
  const storage = await AuthStorage.create(":memory:");
  const server = createFakeMCPServer({
   onToolCall: () => ({
    kind: "result",
    result: { isError: true, content: [{ type: "text", text: "invalid arguments" }] },
   }),
  });
  const core = createSlackCore({ client: { endpoint: server.endpoint }, auth: { env: {} } });
  try {
   await seedWorkspace(storage, Date.now() + 3_600_000);
   const firstTools = await core.listTools(storage, workspace());
   const secondTools = await core.listTools(storage, workspace());
   expect(firstTools).toEqual(secondTools);
   expect(server.requests.filter(request => request.method === "tools/list")).toHaveLength(1);

   const result = await core.callTool(storage, workspace(), "slack_search_public", { query: "bad" });
   expect(result.isError).toBe(true);
   expect(result.content).toEqual([{ type: "text", text: "invalid arguments" }]);
  } finally {
   await core.closeAll();
   await server.stop();
   storage.close();
  }
 });
});

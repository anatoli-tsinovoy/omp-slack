import { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-utils";
import { describe, expect, test } from "bun:test";
import { SLACK_AUTH_TEST_URL, SLACK_TOKEN_URL, slackWorkspaceCredentialId, resolveClientCredentials } from "../src/config";
import type { SlackStoredWorkspaceCredential } from "../src/auth";
import {
 SLACK_USER_SCOPES,
 SlackAmbiguousWorkspaceError,
 SlackConfigError,
 SlackNotConnectedError,
 createSlackCore,
} from "../src/core";
import type { SlackCore, SlackWorkspace } from "../src/types";

function fetchUrl(input: string | URL | Request): string {
 if (typeof input === "string") return input;
 if (input instanceof URL) return input.href;
 return input.url;
}

async function rejectedValue<T>(promise: Promise<T>): Promise<unknown> {
 try {
  await promise;
 } catch (error) {
  return error;
 }
 throw new Error("Expected promise to reject");
}

async function freePort(): Promise<number> {
 const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
 const port = probe.port;
 await probe.stop(true);
 if (typeof port !== "number") throw new Error("Failed to reserve an OAuth callback port");
 return port;
}

async function seedWorkspace(
 storage: AuthStorage,
 workspace: Omit<SlackWorkspace, "isDefault"> & { isDefault: boolean },
): Promise<void> {
 const credential: SlackStoredWorkspaceCredential = {
  type: "oauth",
  access: `access-${workspace.teamId}`,
  refresh: `refresh-${workspace.teamId}`,
  expires: Date.now() + 3_600_000,
  accountId: workspace.teamId,
  teamId: workspace.teamId,
  teamName: workspace.teamName,
  userId: workspace.userId,
  isDefault: workspace.isDefault,
  ...(workspace.domain ? { domain: workspace.domain } : {}),
 };
 await storage.credentials.set(slackWorkspaceCredentialId(workspace.teamId), credential);
}

async function authorizeThroughLoopback(storage: AuthStorage, core: SlackCore, teamId: string): Promise<SlackWorkspace> {
 const authorization = Promise.withResolvers<string>();
 let callback: Promise<void> | undefined;
 const connect = core.connectWorkspace(
  storage,
  {
   onAuthUrl(url) {
    authorization.resolve(url);
    callback = (async () => {
     const authUrl = new URL(url);
     const redirect = authUrl.searchParams.get("redirect_uri");
     const state = authUrl.searchParams.get("state");
     if (!redirect || !state) throw new Error("OAuth authorization URL omitted callback data");
     const callbackUrl = new URL(redirect);
     callbackUrl.searchParams.set("code", "test-code");
     callbackUrl.searchParams.set("state", state);
     const response = await fetch(callbackUrl);
     if (!response.ok) throw new Error(`OAuth callback failed with HTTP ${response.status}`);
    })();
   },
  },
  { team: teamId },
 );
 const authUrl = await authorization.promise;
 const parsed = new URL(authUrl);
 expect(parsed.searchParams.get("team")).toBe(teamId);
 expect(parsed.searchParams.get("scope")).toBe(SLACK_USER_SCOPES.join(","));
 expect(parsed.searchParams.get("resource")).toBe("https://mcp.slack.com");
 expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
 expect(parsed.searchParams.get("code_challenge")).toBeTruthy();
 if (!callback) throw new Error("OAuth presenter did not start the local callback");
 await callback;
 return connect;
}


describe("Slack auth", () => {
 test("environment credentials win and ID-only configuration uses PKCE without a stored secret", async () => {
  const storage = await AuthStorage.create(":memory:");
  try {
   await createSlackCore().saveClientCredentials(storage, { clientId: "saved-id", clientSecret: "saved-secret" });
   expect(resolveClientCredentials(storage, {})).toEqual({ clientId: "saved-id", clientSecret: "saved-secret" });
   expect(resolveClientCredentials(storage, { OMP_SLACK_CLIENT_ID: "env-id" })).toEqual({ clientId: "env-id" });
   expect(
    resolveClientCredentials(storage, {
     OMP_SLACK_CLIENT_ID: "env-id",
     OMP_SLACK_CLIENT_SECRET: "env-secret",
    }),
   ).toEqual({ clientId: "env-id", clientSecret: "env-secret" });

   await createSlackCore().clearClientCredentials(storage);
   let missingCredentials: unknown;
   try {
    resolveClientCredentials(storage, {});
   } catch (error) {
    missingCredentials = error;
   }
   expect(missingCredentials).toBeInstanceOf(SlackConfigError);
   expect((missingCredentials as Error).message).toContain("/slack setup");
   expect((missingCredentials as Error).message).toContain("OMP_SLACK_CLIENT_ID");
   expect((missingCredentials as Error).message).toContain("slack-app-manifest.json");
  } finally {
   storage.close();
  }
 });

 test("resolves defaults and selectors while reporting ambiguity and missing workspaces", async () => {
  const storage = await AuthStorage.create(":memory:");
  try {
   const core = createSlackCore();
   expect(await rejectedValue(core.resolveWorkspace(storage))).toBeInstanceOf(SlackNotConnectedError);
   await seedWorkspace(storage, {
    teamId: "T_ACME",
    teamName: "Shared",
    userId: "U_ACME",
    domain: "acme",
    isDefault: true,
   });
   await seedWorkspace(storage, {
    teamId: "T_BETA",
    teamName: "Shared",
    userId: "U_BETA",
    domain: "beta",
    isDefault: false,
   });

   expect((await core.listWorkspaces(storage)).map(workspace => workspace.teamId)).toEqual(["T_ACME", "T_BETA"]);
   expect((await core.resolveWorkspace(storage)).teamId).toBe("T_ACME");
   expect((await core.resolveWorkspace(storage, "t_beta")).teamId).toBe("T_BETA");
   expect((await core.resolveWorkspace(storage, "BETA")).teamId).toBe("T_BETA");
   expect(await rejectedValue(core.resolveWorkspace(storage, "shared"))).toBeInstanceOf(SlackAmbiguousWorkspaceError);
   expect(await rejectedValue(core.resolveWorkspace(storage, "missing"))).toBeInstanceOf(SlackNotConnectedError);

   await core.setDefaultWorkspace(storage, "t_beta");
   expect((await core.resolveWorkspace(storage)).teamId).toBe("T_BETA");
   await core.disconnectWorkspace(storage, "T_BETA");
   expect((await core.resolveWorkspace(storage)).teamId).toBe("T_ACME");
  } finally {
   storage.close();
  }
 });

 test("connects through user OAuth, confirms auth.test identity, and replaces a team's record", async () => {
  const storage = await AuthStorage.create(":memory:");
  const port = await freePort();
  let tokenExchangeCount = 0;
  const tokenForms: URLSearchParams[] = [];
  const testFetch: FetchImpl = async (input, init) => {
   const url = fetchUrl(input);
   if (url === SLACK_TOKEN_URL) {
    tokenExchangeCount += 1;
    const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    tokenForms.push(form);
    return Response.json({
     ok: true,
     access_token: `xoxp-test-${tokenExchangeCount}`,
     token_type: "user",
     refresh_token: `refresh-${tokenExchangeCount}`,
     expires_in: 3600,
    });
   }
   if (url === SLACK_AUTH_TEST_URL) {
    expect(new Headers(init?.headers).get("Authorization")).toMatch(/^Bearer xoxp-test-/u);
    return Response.json({
     ok: true,
     team: "Acme Workspace",
     team_id: "T_ACME",
     user_id: "U_ALICE",
     url: "https://acme.slack.com/",
    });
   }
   throw new Error(`Unexpected Slack request: ${url}`);
  };
  const core = createSlackCore({ auth: { env: {}, callbackPort: port, fetch: testFetch } });
  try {
   await core.saveClientCredentials(storage, { clientId: "client-id" });
   const first = await authorizeThroughLoopback(storage, core, "T_ACME");
   const firstRow = storage.credentials.list(slackWorkspaceCredentialId("T_ACME"))[0];
   expect(first).toEqual({
    teamId: "T_ACME",
    teamName: "Acme Workspace",
    userId: "U_ALICE",
    domain: "acme",
    isDefault: true,
   });
   expect(firstRow?.credential.type).toBe("oauth");
   expect(firstRow?.credential).toMatchObject({
    access: "xoxp-test-1",
    refresh: "refresh-1",
    teamId: "T_ACME",
    teamName: "Acme Workspace",
    userId: "U_ALICE",
    domain: "acme",
    isDefault: true,
   });
   const firstRowId = firstRow?.id;

   const second = await authorizeThroughLoopback(storage, core, "T_ACME");
   const rows = storage.credentials.list(slackWorkspaceCredentialId("T_ACME"));
   expect(second.isDefault).toBe(true);
   expect(rows).toHaveLength(1);
   expect(rows[0]?.id).toBe(firstRowId);
   expect(rows[0]?.credential).toMatchObject({ access: "xoxp-test-2", refresh: "refresh-2" });
   expect(tokenExchangeCount).toBe(2);
   expect(tokenForms[0]?.get("client_id")).toBe("client-id");
   expect(tokenForms[0]?.get("client_secret")).toBeNull();
   expect(tokenForms[0]?.get("code_verifier")).toBeTruthy();
   expect(parsedRedirectPort(tokenForms[0]?.get("redirect_uri"))).toBe(port);
  } finally {
   storage.close();
  }
 });
});

function parsedRedirectPort(value: string | null | undefined): number | undefined {
 if (!value) return undefined;
 return Number(new URL(value).port);
}

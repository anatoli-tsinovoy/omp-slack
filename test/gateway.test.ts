import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import { LocalMcpHost } from "@oh-my-pi/pi-coding-agent/mcp/host/local";
import { mcpUpstreams } from "@oh-my-pi/pi-coding-agent/mcp/host/peers";
import { McpStore } from "@oh-my-pi/pi-coding-agent/mcp/host/store";
import type { SlackGatewayOptions } from "../src/client";
import { createSlackCore } from "../src/core";
import { ChatGPTCredentialStore, type ChatGPTAuthOptions, type ChatGPTOAuthFlow } from "../src/credentials";
import { SlackAuthError, SlackNotConnectedError } from "../src/errors";
import { SLACK_CONNECTOR_ID, type ChatGPTCredential } from "../src/types";
import { createFakeGateway, FAKE_GATEWAY_TOOLS, type FakeGateway } from "./fixtures/fake-mcp";

const HOUR = 3_600_000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempStore(): Promise<ChatGPTCredentialStore> {
	const directory = await mkdtemp(path.join(tmpdir(), "omp-slack-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	return new ChatGPTCredentialStore(path.join(directory, "omp-slack", "chatgpt-auth.json"));
}

function gateway(options?: Parameters<typeof createFakeGateway>[0]): FakeGateway {
	const fake = createFakeGateway(options);
	cleanups.push(() => fake.stop());
	return fake;
}

function coreWithGateway(
	fake: FakeGateway,
	auth: ChatGPTAuthOptions,
	options: Omit<SlackGatewayOptions, "endpoint" | "access"> = {},
) {
	const access = new LocalMcpHost({ store: McpStore.memory(), upstreams: mcpUpstreams });
	cleanups.push(() => access.dispose());
	const core = createSlackCore({ auth, gateway: { ...options, endpoint: fake.endpoint, access } });
	cleanups.push(() => core.closeAll());
	return core;
}

function credential(overrides: Partial<ChatGPTCredential> = {}): ChatGPTCredential {
	return { access: "access-1", refresh: "refresh-1", expires: Date.now() + HOUR, accountId: "acct-work", email: "me@work.example", ...overrides };
}

/** Rotating refresh flow; login is never expected in these tests. */
function refreshFlow(next: () => OAuthCredentials): ChatGPTOAuthFlow & { refreshed: OAuthCredentials[] } {
	const refreshed: OAuthCredentials[] = [];
	return {
		refreshed,
		async login() {
			throw new Error("interactive login must not run");
		},
		async refresh(previous) {
			refreshed.push(previous);
			return next();
		},
	};
}

function bearerTokens(fake: FakeGateway): Array<string | null> {
	return fake.requests.map(request => request.authorization?.replace(/^Bearer /u, "") ?? null);
}

describe("Slack over the ChatGPT apps gateway", () => {
	test("exposes only the Slack connector's tools and refuses other gateway tools", async () => {
		const fake = gateway();
		const store = await tempStore();
		await store.save(credential());
		const core = coreWithGateway(fake, {
			store,
			flow: refreshFlow(() => {
				throw new Error("no refresh");
			}),
		});

		const tools = await core.listTools();
		expect(tools.map(tool => tool.name)).toEqual(["slack.slack_list_workspaces", "slack.slack_read_channel"]);
		await expect(core.callTool("gmail.search_emails", {})).rejects.toThrow("not a tool of the ChatGPT Slack app");
		expect(await core.listWorkspaces()).toEqual([{ teamId: "T1", teamName: "Simply" }]);
		expect(fake.requests.every(request => request.accountId === "acct-work")).toBe(true);
		expect(fake.requests.filter(request => request.method === "tools/call")).toHaveLength(1);
	});

	test("notifications refresh the Slack-only tool list", async () => {
		const fake = gateway();
		const store = await tempStore();
		await store.save(credential());
		const changed = Promise.withResolvers<void>();
		let changeCount = 0;
		const core = coreWithGateway(fake, { store, flow: refreshFlow(() => { throw new Error("no refresh"); }) }, {
			onToolsChanged() {
				changeCount++;
				changed.resolve();
			},
		});

		expect((await core.listTools()).map(tool => tool.name)).toEqual([
			"slack.slack_list_workspaces",
			"slack.slack_read_channel",
		]);
		await fake.waitForSse();
		fake.setTools([
			...FAKE_GATEWAY_TOOLS,
			{
				name: "slack.slack_send_message",
				description: "Sends a message",
				inputSchema: { type: "object" },
				_meta: { connector_id: SLACK_CONNECTOR_ID },
			},
		]);
		fake.notifyToolsChanged();
		await changed.promise;

		expect(changeCount).toBe(1);
		expect((await core.listTools()).map(tool => tool.name)).toEqual([
			"slack.slack_list_workspaces",
			"slack.slack_read_channel",
			"slack.slack_send_message",
		]);
	});

	test("an expired login refreshes before connecting and persists the rotated grant privately", async () => {
		const fake = gateway({ rejectedTokens: new Set(["access-1"]) });
		const store = await tempStore();
		await store.save(credential({ expires: Date.now() - 1 }));
		const flow = refreshFlow(() => ({ access: "access-2", refresh: "refresh-2", expires: Date.now() + HOUR, accountId: "acct-work" }));
		const core = coreWithGateway(fake, { store, flow });

		expect(await core.listWorkspaces()).toEqual([{ teamId: "T1", teamName: "Simply" }]);
		expect(flow.refreshed.map(grant => grant.refresh)).toEqual(["refresh-1"]);
		expect(bearerTokens(fake)).not.toContain("access-1");
		const saved = await store.load();
		expect(saved).toMatchObject({ access: "access-2", refresh: "refresh-2", accountId: "acct-work", email: "me@work.example" });
		expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
		expect((await stat(path.dirname(store.filePath))).mode & 0o777).toBe(0o700);
	});

	test("a gateway 401 during hosted connection refreshes through onAuthError", async () => {
		const fake = gateway({ rejectedTokens: new Set(["access-1"]) });
		const store = await tempStore();
		await store.save(credential());
		const flow = refreshFlow(() => ({ access: "access-2", refresh: "refresh-2", expires: Date.now() + HOUR, accountId: "acct-work" }));
		const core = coreWithGateway(fake, { store, flow });

		expect((await core.listTools()).map(tool => tool.name)).toHaveLength(2);
		expect(flow.refreshed).toHaveLength(1);
		expect(bearerTokens(fake)).toContain("access-1");
		expect(bearerTokens(fake).at(-1)).toBe("access-2");
		expect((await store.load())?.refresh).toBe("refresh-2");
	});

	test("configured authentication headers never cross an origin-locked redirect", async () => {
		const forwarded: Array<{ authorization: string | null; accountId: string | null; originator: string | null }> = [];
		const foreign = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const payload: unknown = await request.json();
				const id = typeof payload === "object" && payload !== null && "id" in payload ? payload.id : null;
				forwarded.push({
					authorization: request.headers.get("Authorization"),
					accountId: request.headers.get("ChatGPT-Account-ID"),
					originator: request.headers.get("originator"),
				});
				return Response.json({ jsonrpc: "2.0", id, error: { code: -32_601, message: "Unsupported method" } });
			},
		});
		cleanups.push(() => foreign.stop(true));
		const fake = gateway({ redirectDiscoverTo: new URL("/redirected", foreign.url).toString() });
		const store = await tempStore();
		await store.save(credential());
		const core = coreWithGateway(fake, { store, flow: refreshFlow(() => { throw new Error("no refresh"); }) });

		expect((await core.listTools()).map(tool => tool.name)).toHaveLength(2);
		expect(forwarded.length).toBeGreaterThan(0);
		expect(forwarded.every(headers => Object.values(headers).every(value => value === null))).toBe(true);
	});

	test("a 401 from the gateway refreshes once and retries without interactive sign-in", async () => {
		const rejected = new Set<string>();
		const fake = gateway({ rejectedTokens: rejected });
		const store = await tempStore();
		await store.save(credential());
		const flow = refreshFlow(() => ({ access: "access-2", refresh: "refresh-2", expires: Date.now() + HOUR, accountId: "acct-work" }));
		const core = coreWithGateway(fake, { store, flow });

		await core.listTools();
		rejected.add("access-1");
		const result = await core.callTool("slack.slack_list_workspaces", {});

		expect(result.isError).toBeFalsy();
		expect("structuredContent" in result).toBe(false);
		expect(flow.refreshed).toHaveLength(1);
		expect(bearerTokens(fake).at(-1)).toBe("access-2");
		expect((await store.load())?.refresh).toBe("refresh-2");
	});

	test("a refresh that switches ChatGPT workspace is rejected and leaves the stored login intact", async () => {
		const fake = gateway();
		const store = await tempStore();
		await store.save(credential({ expires: Date.now() - 1 }));
		const flow = refreshFlow(() => ({ access: "other", refresh: "other", expires: Date.now() + HOUR, accountId: "acct-personal" }));
		const core = coreWithGateway(fake, { store, flow });

		await expect(core.listTools()).rejects.toBeInstanceOf(SlackAuthError);
		expect((await store.load())?.accountId).toBe("acct-work");
		expect(fake.requests).toHaveLength(0);
	});

	test("without a plugin login, calls ask for /slack login and nothing reaches the gateway", async () => {
		const fake = gateway();
		const store = await tempStore();
		const core = coreWithGateway(fake, {
			store,
			flow: refreshFlow(() => {
				throw new Error("no refresh");
			}),
		});

		expect(await core.account()).toBeUndefined();
		const failure = core.listTools();
		await expect(failure).rejects.toBeInstanceOf(SlackNotConnectedError);
		await expect(failure).rejects.toThrow("/slack login");
		expect(fake.requests).toHaveLength(0);
	});

	test("login stores the grant in the plugin file and logout removes it", async () => {
		const store = await tempStore();
		const urls: string[] = [];
		const core = createSlackCore({
			auth: {
				store,
				flow: {
					async login(controller) {
						controller.onAuth?.({ url: "https://auth.example/authorize?x=1", launchUrl: "http://localhost:1455/start" });
						return { access: "a", refresh: "r", expires: Date.now() + HOUR, accountId: "acct-work", email: "me@work.example" };
					},
					async refresh() {
						throw new Error("no refresh");
					},
				},
			},
		});

		const account = await core.login({ onAuth: info => urls.push(info.url) });
		expect(account).toMatchObject({ accountId: "acct-work", email: "me@work.example" });
		expect(urls).toEqual(["https://auth.example/authorize?x=1"]);
		expect(await store.load()).toMatchObject({ access: "a", refresh: "r" });
		await core.logout();
		expect(await store.load()).toBeUndefined();
	});
});

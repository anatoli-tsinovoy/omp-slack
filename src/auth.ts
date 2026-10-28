import type { AuthCredential, AuthStorage, OAuthCredential } from "@oh-my-pi/pi-ai";
import type { OAuthController } from "@oh-my-pi/pi-ai/oauth/types";
import type { FetchImpl } from "@oh-my-pi/pi-utils";
import { MCPOAuthFlow, refreshMCPOAuthToken } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import {
 isSlackWorkspaceCredentialId,
 resolveSlackOAuthConfig,
 slackWorkspaceCredentialId,
 type SlackOAuthConfigOptions,
} from "./config";
import { SlackAmbiguousWorkspaceError, SlackAuthError, SlackNotConnectedError } from "./errors";
import type { SlackAuthPresenter, SlackWorkspace } from "./types";

export const SLACK_USER_SCOPES = [
 "search:read.public",
 "search:read.private",
 "search:read.mpim",
 "search:read.im",
 "search:read.files",
 "files:read",
 "files:write",
 "emoji:read",
 "search:read.users",
 "users:read",
 "users:read.email",
 "chat:write",
 "channels:history",
 "groups:history",
 "mpim:history",
 "im:history",
 "channels:write",
 "groups:write",
 "im:write",
 "mpim:write",
 "reactions:write",
 "reactions:read",
 "canvases:read",
 "canvases:write",
 "channels:read",
 "groups:read",
 "mpim:read",
 "im:read",
 "lists:read",
 "lists:write",
] as const;

const REFRESH_LEEWAY_MS = 60_000;
const NON_EXPIRING_TOKEN = Number.MAX_SAFE_INTEGER;

export interface SlackStoredWorkspaceCredential extends OAuthCredential {
 teamId: string;
 teamName: string;
 userId: string;
 domain?: string;
 isDefault: boolean;
}

export interface SlackAuthOptions extends SlackOAuthConfigOptions {
 fetch?: FetchImpl;
 refreshLeewayMs?: number;
}

interface SlackWorkspaceIdentity {
 teamId: string;
 teamName: string;
 userId: string;
 domain?: string;
}

function storedSlackCredential(credential: AuthCredential | undefined): SlackStoredWorkspaceCredential | undefined {
 if (!credential || credential.type !== "oauth") return undefined;
 if (
  typeof credential.access !== "string" ||
  typeof credential.refresh !== "string" ||
  !Number.isFinite(credential.expires) ||
  !("teamId" in credential) ||
  typeof credential.teamId !== "string" ||
  !("teamName" in credential) ||
  typeof credential.teamName !== "string" ||
  !("userId" in credential) ||
  typeof credential.userId !== "string" ||
  !("isDefault" in credential) ||
  typeof credential.isDefault !== "boolean"
 ) {
  return undefined;
 }
 if ("domain" in credential && credential.domain !== undefined && typeof credential.domain !== "string") {
  return undefined;
 }
 return credential as SlackStoredWorkspaceCredential;
}

function workspaceFromCredential(credential: SlackStoredWorkspaceCredential): SlackWorkspace {
 return {
  teamId: credential.teamId,
  teamName: credential.teamName,
  userId: credential.userId,
  isDefault: credential.isDefault,
  ...(credential.domain ? { domain: credential.domain } : {}),
 };
}
// AuthStorage's snapshot comparison tracks standard OAuth fields, not plugin metadata.
// Include the default bit in the account identity so `credentials.set` refreshes the live snapshot.
function slackCredentialAccountId(teamId: string, isDefault: boolean): string {
 return `slack:${teamId}:${isDefault ? "default" : "connected"}`;
}

function compareText(left: string, right: string): number {
 const normalizedLeft = left.toLowerCase();
 const normalizedRight = right.toLowerCase();
 if (normalizedLeft < normalizedRight) return -1;
 if (normalizedLeft > normalizedRight) return 1;
 return 0;
}

function workspaceChoices(workspaces: readonly SlackWorkspace[]): string {
 return workspaces
  .map(workspace => `${workspace.teamName} (${workspace.teamId}${workspace.domain ? `, ${workspace.domain}` : ""})`)
  .join("; ");
}

function loginRequiredError(workspace: SlackWorkspace, detail: string): SlackAuthError {
 return new SlackAuthError(
  `Slack authentication for ${workspace.teamName} (${workspace.teamId}) needs attention: ${detail} Have the user run \`/slack login ${workspace.teamId}\`.`,
 );
}

function domainFromUrl(value: string | undefined): string | undefined {
 if (!value) return undefined;
 try {
  const hostname = new URL(value).hostname.toLowerCase();
  for (const suffix of [".slack.com", ".slack-gov.com"]) {
   if (hostname.endsWith(suffix)) return hostname.slice(0, -suffix.length) || undefined;
  }
  return hostname || undefined;
 } catch {
  return undefined;
 }
}

function fetchUrl(input: RequestInfo | URL): string {
 if (typeof input === "string") return input;
 if (input instanceof URL) return input.href;
 return input.url;
}

function slackErrorFromPayload(payload: unknown): string | undefined {
 if (payload === null || typeof payload !== "object" || Array.isArray(payload) || !("ok" in payload)) {
  return undefined;
 }
 if (payload.ok !== false) return undefined;
 return "error" in payload && typeof payload.error === "string" ? payload.error : "Slack returned ok:false";
}

export class SlackAuthService {
 readonly #options: SlackAuthOptions;
 readonly #fetch: FetchImpl;
 readonly #refreshFlights = new Map<string, Promise<SlackStoredWorkspaceCredential>>();

 constructor(options: SlackAuthOptions = {}) {
  this.#options = options;
  this.#fetch = options.fetch ?? fetch;
 }

 async listWorkspaces(storage: AuthStorage): Promise<SlackWorkspace[]> {
  const workspaces: SlackWorkspace[] = [];
  for (const row of storage.credentials.list()) {
   if (!isSlackWorkspaceCredentialId(row.provider)) continue;
   const credential = storedSlackCredential(row.credential);
   if (!credential || row.provider !== slackWorkspaceCredentialId(credential.teamId)) continue;
   workspaces.push(workspaceFromCredential(credential));
  }
  workspaces.sort((left, right) => {
   if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
   return compareText(left.teamName, right.teamName) || compareText(left.teamId, right.teamId);
  });
  return workspaces;
 }

 async resolveWorkspace(storage: AuthStorage, selector?: string): Promise<SlackWorkspace> {
  const workspaces = await this.listWorkspaces(storage);
  const normalized = selector?.trim().toLowerCase();
  if (!normalized) {
   if (workspaces.length === 0) {
    throw new SlackNotConnectedError("No Slack workspace is connected. Have the user run `/slack login`.");
   }
   const defaults = workspaces.filter(workspace => workspace.isDefault);
   if (defaults.length === 1) return defaults[0]!;
   if (defaults.length === 0 && workspaces.length === 1) return workspaces[0]!;
   throw new SlackAmbiguousWorkspaceError(
    `More than one Slack workspace is connected${defaults.length > 1 ? " and more than one is marked as default" : " without a default"}: ${workspaceChoices(workspaces)}. Have the user specify a workspace ID, name, or domain.`,
   );
  }

  const matches = workspaces.filter(workspace =>
   [workspace.teamId, workspace.teamName, workspace.domain].some(value => value?.toLowerCase() === normalized),
  );
  if (matches.length === 0) {
   throw new SlackNotConnectedError(
    `Slack workspace "${selector?.trim()}" is not connected. Have the user run \`/slack login\` and pick that workspace in Slack's authorization screen (or \`/slack login <team-id>\` to pin it).`,
   );
  }
  if (matches.length > 1) {
   throw new SlackAmbiguousWorkspaceError(
    `Slack workspace selector "${selector?.trim()}" matches multiple workspaces: ${workspaceChoices(matches)}. Have the user specify a workspace ID.`,
   );
  }
  return matches[0]!;
 }

 async connectWorkspace(
  storage: AuthStorage,
  presenter: SlackAuthPresenter,
  opts?: { team?: string },
 ): Promise<SlackWorkspace> {
  const config = resolveSlackOAuthConfig(storage, this.#configOptions());
  const authorizationUrl = new URL(config.authorizationUrl);
  const requestedTeam = opts?.team?.trim();
  if (requestedTeam) authorizationUrl.searchParams.set("team", requestedTeam);

  const controller: OAuthController = {
   onAuth: info => presenter.onAuthUrl(info.url, info.instructions),
   onProgress: message => presenter.onProgress?.(message),
   ...(presenter.signal ? { signal: presenter.signal } : {}),
   fetch: this.#fetch,
  };
  const flow = new MCPOAuthFlow(
   {
    authorizationUrl: authorizationUrl.toString(),
    tokenUrl: config.tokenUrl,
    clientId: config.clientId,
    ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
    scopes: SLACK_USER_SCOPES.join(","),
    redirectUri: config.redirectUri,
    callbackPort: config.callbackPort,
    resource: config.resource,
    fetch: this.#fetch,
   },
   controller,
  );
  const tokens = await flow.login();
  const identity = await this.#identifyWorkspace(config.authTestUrl, tokens.access, presenter.signal);
  if (requestedTeam && identity.teamId.toLowerCase() !== requestedTeam.toLowerCase()) {
   throw new SlackAuthError(
    `Slack authorized ${identity.teamName} (${identity.teamId}) instead of the requested workspace ${requestedTeam}. Have the user run \`/slack login ${requestedTeam}\` and confirm the workspace in Slack's authorization screen.`,
   );
  }

  const provider = slackWorkspaceCredentialId(identity.teamId);
  const previous = storedSlackCredential(storage.credentials.get(provider));
  const current = await this.listWorkspaces(storage);
  const hasDefault = current.some(workspace => workspace.isDefault);
  const isDefault = previous?.isDefault === true || !hasDefault;
  const credential: SlackStoredWorkspaceCredential = {
   type: "oauth",
   access: tokens.access,
   refresh: tokens.refresh,
   expires: tokens.refresh ? tokens.expires : NON_EXPIRING_TOKEN,
   accountId: slackCredentialAccountId(identity.teamId, isDefault),
   teamId: identity.teamId,
   teamName: identity.teamName,
   userId: identity.userId,
   isDefault,
   ...(identity.domain ? { domain: identity.domain } : {}),
  };
  await storage.credentials.set(provider, credential);
  return workspaceFromCredential(credential);
 }

 async disconnectWorkspace(storage: AuthStorage, selector: string): Promise<SlackWorkspace> {
  const workspace = await this.resolveWorkspace(storage, selector);
  await storage.credentials.remove(slackWorkspaceCredentialId(workspace.teamId));
  const remaining = await this.listWorkspaces(storage);
  if (remaining.length > 0 && !remaining.some(candidate => candidate.isDefault)) {
   const replacement = storedSlackCredential(storage.credentials.get(slackWorkspaceCredentialId(remaining[0]!.teamId)));
   if (replacement) {
    const updated: SlackStoredWorkspaceCredential = {
     ...replacement,
     accountId: slackCredentialAccountId(replacement.teamId, true),
     isDefault: true,
    };
    await storage.credentials.set(slackWorkspaceCredentialId(replacement.teamId), updated);
   }
  }
  return workspace;
 }

 async setDefaultWorkspace(storage: AuthStorage, selector: string): Promise<SlackWorkspace> {
  const workspace = await this.resolveWorkspace(storage, selector);
  const credentials = storage.credentials
   .list()
   .filter(row => isSlackWorkspaceCredentialId(row.provider))
   .map(row => ({ provider: row.provider, credential: storedSlackCredential(row.credential) }))
   .filter(
    (entry): entry is { provider: string; credential: SlackStoredWorkspaceCredential } =>
     entry.credential !== undefined && entry.provider === slackWorkspaceCredentialId(entry.credential.teamId),
   );
  for (const entry of credentials) {
   const isDefault = entry.credential.teamId === workspace.teamId;
   if (entry.credential.isDefault !== isDefault) {
    const updated: SlackStoredWorkspaceCredential = {
     ...entry.credential,
     accountId: slackCredentialAccountId(entry.credential.teamId, isDefault),
     isDefault,
    };
    await storage.credentials.set(entry.provider, updated);
   }
  }
  return { ...workspace, isDefault: true };
 }

 async getAccessToken(storage: AuthStorage, workspace: SlackWorkspace): Promise<string> {
  const credential = this.#requireWorkspaceCredential(storage, workspace.teamId);
  const leeway = this.#options.refreshLeewayMs ?? REFRESH_LEEWAY_MS;
  if (credential.refresh && credential.expires <= Date.now() + leeway) {
   return (await this.#refreshCredential(storage, workspace, credential.access)).access;
  }
  if (!credential.refresh && credential.expires <= Date.now() + leeway) {
   throw loginRequiredError(workspace, "the access token has expired and no refresh token is available.");
  }
  return credential.access;
 }

 async refreshAfterAuthError(
  storage: AuthStorage,
  workspace: SlackWorkspace,
  rejectedAccessToken?: string,
 ): Promise<string> {
  const credential = this.#requireWorkspaceCredential(storage, workspace.teamId);
  if (!credential.refresh) {
   throw loginRequiredError(workspace, "Slack rejected the access token and this app did not issue a refresh token.");
  }
  const refreshed = await this.#refreshCredential(storage, workspace, rejectedAccessToken ?? credential.access);
  return refreshed.access;
 }

 #configOptions(): SlackOAuthConfigOptions {
  return {
   ...(this.#options.env ? { env: this.#options.env } : {}),
   ...(this.#options.authorizationUrl ? { authorizationUrl: this.#options.authorizationUrl } : {}),
   ...(this.#options.tokenUrl ? { tokenUrl: this.#options.tokenUrl } : {}),
   ...(this.#options.authTestUrl ? { authTestUrl: this.#options.authTestUrl } : {}),
   ...(this.#options.resource ? { resource: this.#options.resource } : {}),
   ...(this.#options.callbackPort !== undefined ? { callbackPort: this.#options.callbackPort } : {}),
   ...(this.#options.redirectUri ? { redirectUri: this.#options.redirectUri } : {}),
  };
 }

 #requireWorkspaceCredential(storage: AuthStorage, teamId: string): SlackStoredWorkspaceCredential {
  const credential = storedSlackCredential(storage.credentials.get(slackWorkspaceCredentialId(teamId)));
  if (!credential || credential.teamId !== teamId) {
   throw new SlackNotConnectedError(`Slack workspace ${teamId} is no longer connected. Have the user run "/slack login ${teamId}".`);
  }
  return credential;
 }

 async #identifyWorkspace(url: string, accessToken: string, signal?: AbortSignal): Promise<SlackWorkspaceIdentity> {
  const response = await this.#fetch(url, {
   method: "POST",
   headers: {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/x-www-form-urlencoded",
   },
   body: "",
   ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
   const detail = await response.text();
   throw new SlackAuthError(`Slack auth.test failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}.`);
  }
  const payload: unknown = await response.json();
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
   throw new SlackAuthError("Slack auth.test returned an invalid response.");
  }
  const slackError = slackErrorFromPayload(payload);
  if (slackError) throw new SlackAuthError(`Slack auth.test failed: ${slackError}.`);
  if (
   !("team_id" in payload) ||
   typeof payload.team_id !== "string" ||
   !("user_id" in payload) ||
   typeof payload.user_id !== "string"
  ) {
   throw new SlackAuthError("Slack auth.test did not identify both the workspace and user.");
  }
  const teamName = "team" in payload && typeof payload.team === "string" && payload.team.trim()
   ? payload.team.trim()
   : payload.team_id;
  const urlValue = "url" in payload && typeof payload.url === "string" ? payload.url : undefined;
  const domain = domainFromUrl(urlValue);
  return {
   teamId: payload.team_id,
   teamName,
   userId: payload.user_id,
   ...(domain ? { domain } : {}),
  };
 }

 #refreshCredential(
  storage: AuthStorage,
  workspace: SlackWorkspace,
  observedAccessToken: string,
 ): Promise<SlackStoredWorkspaceCredential> {
  const provider = slackWorkspaceCredentialId(workspace.teamId);
  const pending = this.#refreshFlights.get(provider);
  if (pending) return pending;

  const refresh = this.#performRefresh(storage, workspace, observedAccessToken).finally(() => {
   if (this.#refreshFlights.get(provider) === refresh) this.#refreshFlights.delete(provider);
  });
  this.#refreshFlights.set(provider, refresh);
  return refresh;
 }

 async #performRefresh(
  storage: AuthStorage,
  workspace: SlackWorkspace,
  observedAccessToken: string,
 ): Promise<SlackStoredWorkspaceCredential> {
  const provider = slackWorkspaceCredentialId(workspace.teamId);
  const current = this.#requireWorkspaceCredential(storage, workspace.teamId);
  if (current.access !== observedAccessToken) return current;
  if (!current.refresh) {
   throw loginRequiredError(workspace, "no refresh token is available.");
  }

  let providerError: string | undefined;
  try {
   const config = resolveSlackOAuthConfig(storage, this.#configOptions());
   const validatingFetch: FetchImpl = async (input, init) => {
    const response = await this.#fetch(input, init);
    if (fetchUrl(input) === config.tokenUrl && response.ok) {
     try {
      providerError = slackErrorFromPayload(await response.clone().json());
     } catch {
      // The OAuth helper performs the authoritative response parse below.
     }
    }
    return response;
   };
   const tokens = await refreshMCPOAuthToken(
    config.tokenUrl,
    current.refresh,
    config.clientId,
    config.clientSecret,
    config.resource,
    { fetch: validatingFetch, authorizationUrl: config.authorizationUrl },
   );
   if (providerError) throw new Error(providerError);
   if (typeof tokens.access !== "string" || !tokens.access.trim()) {
    throw new Error("Slack returned no access token.");
   }
   const refreshed: SlackStoredWorkspaceCredential = {
    ...current,
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expires,
   };
   await storage.credentials.set(provider, refreshed);
   return refreshed;
  } catch (error) {
   const detail = providerError ?? (error instanceof Error ? error.message : String(error));
   throw new SlackAuthError(
    `Slack token refresh failed for ${workspace.teamName} (${workspace.teamId}): ${detail}. Have the user run \`/slack login ${workspace.teamId}\`.`,
    { cause: error },
   );
  }
 }
}

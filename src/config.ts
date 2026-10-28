import type { AuthCredential, AuthStorage } from "@oh-my-pi/pi-ai";
import { getActiveProfile } from "@oh-my-pi/pi-utils";
import { SlackConfigError } from "./errors";
import type { SlackClientCredentials } from "./types";

export const SLACK_AUTHORIZATION_URL = "https://slack.com/oauth/v2_user/authorize";
export const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.user.access";
export const SLACK_AUTH_TEST_URL = "https://slack.com/api/auth.test";
/** The resource indicator advertised by Slack's protected-resource metadata. */
export const SLACK_RESOURCE = "https://mcp.slack.com";
export const DEFAULT_SLACK_CALLBACK_PORT = 3118;

const SLACK_CREDENTIAL_PREFIX = "omp-slack:";

export interface SlackEnvironment {
 OMP_SLACK_CLIENT_ID?: string;
 OMP_SLACK_CLIENT_SECRET?: string;
 OMP_SLACK_CALLBACK_PORT?: string;
}

export interface SlackOAuthConfigOptions {
 env?: SlackEnvironment;
 authorizationUrl?: string;
 tokenUrl?: string;
 authTestUrl?: string;
 resource?: string;
 callbackPort?: number;
 redirectUri?: string;
}

export interface SlackOAuthConfig extends SlackClientCredentials {
 authorizationUrl: string;
 tokenUrl: string;
 authTestUrl: string;
 resource: string;
 callbackPort: number;
 redirectUri: string;
}

function profileSuffix(profile: string | undefined): string {
 return profile ? `profile:${encodeURIComponent(profile)}:` : "";
}

export function slackAppCredentialId(profile = getActiveProfile()): string {
 return `${SLACK_CREDENTIAL_PREFIX}${profileSuffix(profile)}client`;
}

export function slackWorkspaceCredentialId(teamId: string, profile = getActiveProfile()): string {
 return `${SLACK_CREDENTIAL_PREFIX}${profileSuffix(profile)}${encodeURIComponent(teamId)}`;
}

export function isSlackWorkspaceCredentialId(provider: string, profile = getActiveProfile()): boolean {
 const prefix = `${SLACK_CREDENTIAL_PREFIX}${profileSuffix(profile)}`;
 if (!provider.startsWith(prefix) || provider === slackAppCredentialId(profile)) return false;
 // The default profile has no explicit scope segment; don't read broker rows
 // belonging to named profiles from its shared provider namespace.
 if (profile === undefined && provider.startsWith(`${SLACK_CREDENTIAL_PREFIX}profile:`)) return false;
 return true;
}

function nonEmpty(value: string | undefined): string | undefined {
 const trimmed = value?.trim();
 return trimmed ? trimmed : undefined;
}

function currentEnvironment(): SlackEnvironment {
 return {
  OMP_SLACK_CLIENT_ID: process.env.OMP_SLACK_CLIENT_ID,
  OMP_SLACK_CLIENT_SECRET: process.env.OMP_SLACK_CLIENT_SECRET,
  OMP_SLACK_CALLBACK_PORT: process.env.OMP_SLACK_CALLBACK_PORT,
 };
}

function parseSavedClientCredentials(credential: AuthCredential | undefined): SlackClientCredentials | undefined {
 if (credential?.type !== "api_key") return undefined;
 try {
  const parsed: unknown = JSON.parse(credential.key);
  if (
   parsed === null ||
   typeof parsed !== "object" ||
   Array.isArray(parsed) ||
   !("clientId" in parsed)
  ) return undefined;
  const clientId = nonEmpty(typeof parsed.clientId === "string" ? parsed.clientId : undefined);
  if (!clientId) return undefined;
  const clientSecret = nonEmpty(
   "clientSecret" in parsed && typeof parsed.clientSecret === "string" ? parsed.clientSecret : undefined,
  );
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
 } catch {
  return undefined;
 }
}


export async function saveClientCredentials(
 storage: AuthStorage,
 credentials: SlackClientCredentials,
): Promise<void> {
 const clientId = nonEmpty(credentials.clientId);
 if (!clientId) {
  throw new SlackConfigError("A Slack client ID is required. Run `/slack setup` or set OMP_SLACK_CLIENT_ID.");
 }
 const clientSecret = nonEmpty(credentials.clientSecret);
 const saved = { clientId, ...(clientSecret ? { clientSecret } : {}) };
 await storage.credentials.set(slackAppCredentialId(), {
  type: "api_key",
  key: JSON.stringify(saved),
 });
}

export async function clearClientCredentials(storage: AuthStorage): Promise<void> {
 await storage.credentials.remove(slackAppCredentialId());
}

export function resolveClientCredentials(
 storage: AuthStorage,
 env: SlackEnvironment = currentEnvironment(),
): SlackClientCredentials {
 const environmentClientId = nonEmpty(env.OMP_SLACK_CLIENT_ID);
 const environmentClientSecret = nonEmpty(env.OMP_SLACK_CLIENT_SECRET);
 const saved = parseSavedClientCredentials(storage.credentials.get(slackAppCredentialId()));
 const clientId = environmentClientId ?? saved?.clientId;
 // Supplying an environment client ID alone intentionally selects the public
 // PKCE path; don't accidentally pair it with a secret saved for another app.
 const clientSecret = environmentClientSecret ?? (environmentClientId ? undefined : saved?.clientSecret);
 if (!clientId) {
  throw new SlackConfigError(
   "Slack app credentials are missing. Run `/slack setup` or set OMP_SLACK_CLIENT_ID (and OMP_SLACK_CLIENT_SECRET for a confidential client). Create an internal Slack app from `slack-app-manifest.json`.",
  );
 }
 return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

function resolveCallbackPort(options: SlackOAuthConfigOptions, env: SlackEnvironment): number {
 const configured = options.callbackPort ?? (env.OMP_SLACK_CALLBACK_PORT ? Number(env.OMP_SLACK_CALLBACK_PORT) : DEFAULT_SLACK_CALLBACK_PORT);
 if (!Number.isInteger(configured) || configured < 1 || configured > 65_535) {
  throw new SlackConfigError("OMP_SLACK_CALLBACK_PORT must be an integer from 1 to 65535.");
 }
 return configured;
}

export function resolveSlackOAuthConfig(
 storage: AuthStorage,
 options: SlackOAuthConfigOptions = {},
): SlackOAuthConfig {
 const env = options.env ?? currentEnvironment();
 const callbackPort = resolveCallbackPort(options, env);
 return {
  ...resolveClientCredentials(storage, env),
  authorizationUrl: options.authorizationUrl ?? SLACK_AUTHORIZATION_URL,
  tokenUrl: options.tokenUrl ?? SLACK_TOKEN_URL,
  authTestUrl: options.authTestUrl ?? SLACK_AUTH_TEST_URL,
  resource: options.resource ?? SLACK_RESOURCE,
  callbackPort,
  redirectUri: options.redirectUri ?? `http://localhost:${callbackPort}/callback`,
 };
}

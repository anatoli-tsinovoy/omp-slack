/**
 * Shared contract between the auth/client core and the surfaces (xd://slack tool, /slack command, slack:// URLs).
 * Core owns: src/config.ts, src/auth.ts, src/client.ts. Surfaces own: src/tool.ts, src/command.ts, src/protocol.ts, src/index.ts.
 */
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { MCPToolCallResult, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";

export const SLACK_MCP_URL = "https://mcp.slack.com/mcp";

/** A Slack workspace the user has authorized. Persisted (with tokens) in OMP auth storage. */
export interface SlackWorkspace {
 teamId: string;
 teamName: string;
 /** Workspace subdomain, e.g. "acme" for acme.slack.com, when known. */
 domain?: string;
 userId: string;
 /** True for the workspace used when no selector is supplied. */
 isDefault: boolean;
}

/** Slack app credentials used for user-token OAuth. A PKCE public client may omit its secret. */
export interface SlackClientCredentials {
 clientId: string;
 clientSecret?: string;
}

/** Presentation hooks for the interactive OAuth flow; surfaces adapt ctx.ui / pi.exec into this. */
export interface SlackAuthPresenter {
 /** Show (and ideally open) the authorization URL. */
 onAuthUrl(url: string, instructions?: string): void;
 onProgress?(message: string): void;
 signal?: AbortSignal;
}

export interface SlackCore {
 /** Authorized workspaces, default first. Never touches the network. */
 listWorkspaces(storage: AuthStorage): Promise<SlackWorkspace[]>;
 /**
  * Resolve a selector (team id, team name, domain, case-insensitive) to a workspace.
  * `undefined` → default workspace, or the only one. Throws SlackNotConnectedError / SlackAmbiguousWorkspaceError
  * with messages that tell the agent exactly what to do next.
  */
 resolveWorkspace(storage: AuthStorage, selector?: string): Promise<SlackWorkspace>;
 /** Run user OAuth (optionally pinned to a team id) and persist the workspace. First workspace becomes default. */
 connectWorkspace(storage: AuthStorage, presenter: SlackAuthPresenter, opts?: { team?: string }): Promise<SlackWorkspace>;
 /** Save app credentials to the active profile's auth storage. */
 saveClientCredentials(storage: AuthStorage, credentials: SlackClientCredentials): Promise<void>;
 /** Remove app credentials from auth storage; environment overrides remain active. */
 clearClientCredentials(storage: AuthStorage): Promise<void>;
 disconnectWorkspace(storage: AuthStorage, selector: string): Promise<SlackWorkspace>;
 setDefaultWorkspace(storage: AuthStorage, selector: string): Promise<SlackWorkspace>;
 /** Lazily connects (initialize only, no tools/list), refreshes on expiry/401 once, reuses the connection per workspace. */
 callTool(
  storage: AuthStorage,
  workspace: SlackWorkspace,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
 ): Promise<MCPToolCallResult>;
 /** tools/list for the workspace, memoized in-process per workspace. */
 listTools(storage: AuthStorage, workspace: SlackWorkspace, signal?: AbortSignal): Promise<MCPToolDefinition[]>;
 /** Close every live MCP connection (session_shutdown). */
 closeAll(): Promise<void>;
}

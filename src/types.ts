/**
 * Shared contract between the core (credentials + ChatGPT apps gateway client) and the surfaces
 * (Slack tools, /slack command, slack:// URLs).
 */
import type { MCPToolCallResult, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";

/** ChatGPT apps MCP gateway; Slack is reached through the user's installed ChatGPT Slack app. */
export const CHATGPT_APPS_MCP_URL = "https://chatgpt.com/backend-api/ps/mcp";
/** Connector id of the ChatGPT Slack app (Settings → Plugins → Slack). */
export const SLACK_CONNECTOR_ID = "asdk_app_69a1d78e929881919bba0dbda1f6436d";

/** The plugin's own ChatGPT login; never shared with OMP's openai-codex credentials. */
export interface ChatGPTCredential {
 access: string;
 refresh: string;
 /** Epoch ms. */
 expires: number;
 /** ChatGPT workspace id, sent as `ChatGPT-Account-ID`. */
 accountId: string;
 email?: string;
}

/** Non-secret view of the stored login. */
export interface ChatGPTAccount {
 email?: string;
 accountId: string;
 expires: number;
}

/** A Slack workspace reported by the connector's `slack_list_workspaces`. */
export interface SlackWorkspace {
 teamId: string;
 teamName: string;
}

/** Presentation hooks for the interactive ChatGPT sign-in. */
export interface SlackAuthPresenter {
 /** Show (and ideally open) the authorization URL. */
 onAuthUrl(url: string, instructions?: string): void;
 onProgress?(message: string): void;
 signal?: AbortSignal;
}

export interface SlackCore {
 /** Stored login without touching the network. */
 account(): Promise<ChatGPTAccount | undefined>;
 /** Interactive ChatGPT sign-in; replaces any previous plugin login. */
 login(presenter: SlackAuthPresenter): Promise<ChatGPTAccount>;
 /** Forget the plugin login and close connections. */
 logout(): Promise<void>;
 /** Slack tools of the ChatGPT Slack connector, memoized until logout or tools/list_changed. */
 listTools(signal?: AbortSignal): Promise<MCPToolDefinition[]>;
 /** Call one Slack connector tool; other gateway tools are refused. */
 callTool(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<MCPToolCallResult>;
 /** Workspaces from `slack_list_workspaces`, memoized per login. */
 listWorkspaces(signal?: AbortSignal): Promise<SlackWorkspace[]>;
 /**
  * Resolve a team id or name (case-insensitive). `undefined` → the only workspace.
  * Throws SlackNotConnectedError / SlackAmbiguousWorkspaceError with next-step guidance.
  */
 resolveWorkspace(selector?: string, signal?: AbortSignal): Promise<SlackWorkspace>;
 /** Close the live gateway connection (session_shutdown). */
 closeAll(): Promise<void>;
}

import {
 callTool as callMCPTool,
 connectToServer,
 disconnectServer,
 listTools as listMCPTools,
} from "@oh-my-pi/pi-coding-agent/mcp";
import type { MCPHttpServerConfig, MCPServerConnection, MCPToolCallResult, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import { HttpTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/http";
import { slackWorkspaceCredentialId } from "./config";
import { SlackAuthError } from "./errors";
import type { SlackAuthService } from "./auth";
import { SLACK_MCP_URL, type SlackWorkspace } from "./types";

export interface SlackClientOptions {
 endpoint?: string;
}

interface ConnectionEntry {
 key: string;
 connection: MCPServerConnection;
 accessToken: string;
 activeCalls: number;
 retired: boolean;
 closed: Promise<void>;
 resolveClosed: () => void;
 closePromise?: Promise<void>;
 authRecovery?: Promise<Record<string, string>>;
 recoveredAccessToken?: string;
}

interface PendingConnection {
 accessToken: string;
 promise: Promise<ConnectionEntry>;
}

function isHttpAuthFailure(error: unknown): error is MCPTransportError {
 return (
  error instanceof MCPTransportError &&
  error.failure === "http_status" &&
  (error.code === 401 || error.code === 403)
 );
}

function authenticationRetryError(workspace: SlackWorkspace, cause: unknown): SlackAuthError {
 return new SlackAuthError(
  `Slack rejected the refreshed token for ${workspace.teamName} (${workspace.teamId}). Have the user run \`/slack login ${workspace.teamId}\`.`,
  { cause },
 );
}

export class SlackMCPClient {
 readonly #auth: SlackAuthService;
 readonly #endpoint: string;
 readonly #connections = new Map<string, ConnectionEntry>();
 readonly #connecting = new Map<string, PendingConnection>();
 readonly #allConnections = new Set<ConnectionEntry>();
 readonly #toolLists = new Map<string, Promise<MCPToolDefinition[]>>();

 constructor(auth: SlackAuthService, options: SlackClientOptions = {}) {
  this.#auth = auth;
  this.#endpoint = options.endpoint ?? SLACK_MCP_URL;
 }

 async callTool(
  storage: AuthStorage,
  workspace: SlackWorkspace,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
 ): Promise<MCPToolCallResult> {
  signal?.throwIfAborted();
  const accessToken = await this.#auth.getAccessToken(storage, workspace);
  const entry = await this.#connectionFor(storage, workspace, accessToken);
  entry.activeCalls += 1;
  try {
   return await callMCPTool(entry.connection, tool, args, signal ? { signal } : undefined);
  } catch (error) {
   if (isHttpAuthFailure(error)) throw authenticationRetryError(workspace, error);
   throw error;
  } finally {
   this.#release(entry);
  }
 }

 async listTools(
  storage: AuthStorage,
  workspace: SlackWorkspace,
  signal?: AbortSignal,
 ): Promise<MCPToolDefinition[]> {
  signal?.throwIfAborted();
  const key = slackWorkspaceCredentialId(workspace.teamId);
  const cached = this.#toolLists.get(key);
  if (cached) return cached;

  const pending = this.#listToolsUncached(storage, workspace, signal);
  this.#toolLists.set(key, pending);
  try {
   return await pending;
  } catch (error) {
   if (this.#toolLists.get(key) === pending) this.#toolLists.delete(key);
   throw error;
  }
 }

 async closeWorkspace(workspace: SlackWorkspace): Promise<void> {
  const key = slackWorkspaceCredentialId(workspace.teamId);
  this.#toolLists.delete(key);
  const entry = this.#connections.get(key);
  if (entry) await this.#retire(entry);
  const pending = this.#connecting.get(key);
  if (pending) {
   const connected = await pending.promise.catch(() => undefined);
   if (connected) await this.#retire(connected);
  }
 }

 async closeAll(): Promise<void> {
  this.#toolLists.clear();
  await Promise.allSettled([...this.#connecting.values()].map(pending => pending.promise));
  await Promise.allSettled([...this.#allConnections].map(entry => this.#retire(entry)));
  this.#connections.clear();
  this.#connecting.clear();
  this.#allConnections.clear();
 }

 async #listToolsUncached(
  storage: AuthStorage,
  workspace: SlackWorkspace,
  signal?: AbortSignal,
 ): Promise<MCPToolDefinition[]> {
  const accessToken = await this.#auth.getAccessToken(storage, workspace);
  const entry = await this.#connectionFor(storage, workspace, accessToken);
  entry.activeCalls += 1;
  try {
   return await listMCPTools(entry.connection, signal ? { signal } : undefined);
  } catch (error) {
   if (isHttpAuthFailure(error)) throw authenticationRetryError(workspace, error);
   throw error;
  } finally {
   this.#release(entry);
  }
 }

 async #connectionFor(
  storage: AuthStorage,
  workspace: SlackWorkspace,
  accessToken: string,
 ): Promise<ConnectionEntry> {
  const key = slackWorkspaceCredentialId(workspace.teamId);
  const current = this.#connections.get(key);
  if (current && !current.retired && current.accessToken === accessToken) return current;
  if (current && !current.retired) {
   const latestAccessToken = await this.#auth.getAccessToken(storage, workspace);
   if (latestAccessToken !== accessToken) {
    return this.#connectionFor(storage, workspace, latestAccessToken);
   }
   if (current.accessToken === latestAccessToken) return current;
  }
  if (current) void this.#retire(current).catch(() => { });

  const pending = this.#connecting.get(key);
  if (pending) {
   const connected = await pending.promise;
   if (!connected.retired && connected.accessToken === accessToken) return connected;
   const latestAccessToken = await this.#auth.getAccessToken(storage, workspace);
   return this.#connectionFor(storage, workspace, latestAccessToken);
  }

  const promise = this.#connectWithRecovery(storage, workspace, key, accessToken).then(entry => {
   this.#connections.set(key, entry);
   this.#allConnections.add(entry);
   return entry;
  });
  const newPending = { accessToken, promise };
  this.#connecting.set(key, newPending);
  try {
   return await promise;
  } finally {
   if (this.#connecting.get(key) === newPending) this.#connecting.delete(key);
  }
 }

 async #connectWithRecovery(
  storage: AuthStorage,
  workspace: SlackWorkspace,
  key: string,
  initialAccessToken: string,
 ): Promise<ConnectionEntry> {
  try {
   return await this.#connectOnce(workspace, key, initialAccessToken, storage);
  } catch (error) {
   if (!isHttpAuthFailure(error)) throw error;
   const refreshed = await this.#auth.refreshAfterAuthError(storage, workspace, initialAccessToken);
   try {
    return await this.#connectOnce(workspace, key, refreshed, storage);
   } catch (retryError) {
    if (isHttpAuthFailure(retryError)) throw authenticationRetryError(workspace, retryError);
    throw retryError;
   }
  }
 }

 async #connectOnce(
  workspace: SlackWorkspace,
  key: string,
  accessToken: string,
  storage: AuthStorage,
 ): Promise<ConnectionEntry> {
  const config: MCPHttpServerConfig = {
   type: "http",
   url: this.#endpoint,
   headers: { Authorization: `Bearer ${accessToken}` },
  };
  const connection = await connectToServer(`slack:${workspace.teamId}`, config);
  const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
  const entry: ConnectionEntry = {
   key,
   connection,
   accessToken,
   activeCalls: 0,
   retired: false,
   closed,
   resolveClosed,
  };
  if (connection.transport instanceof HttpTransport) {
   connection.transport.onAuthError = () => {
    if (entry.authRecovery) return entry.authRecovery;
    if (entry.recoveredAccessToken) {
     return Promise.resolve({ Authorization: `Bearer ${entry.accessToken}` });
    }
    const rejectedAccessToken = entry.accessToken;
    const recovery = this.#auth
     .refreshAfterAuthError(storage, workspace, rejectedAccessToken)
     .then(refreshed => {
      entry.recoveredAccessToken = rejectedAccessToken;
      entry.accessToken = refreshed;
      return { Authorization: `Bearer ${refreshed}` };
     })
     .finally(() => {
      entry.authRecovery = undefined;
     });
    entry.authRecovery = recovery;
    return recovery;
   };
  }
  return entry;
 }

 #release(entry: ConnectionEntry): void {
  entry.activeCalls -= 1;
  if (entry.retired && entry.activeCalls === 0) {
   void this.#closeEntry(entry).catch(() => { });
  }
 }

 #retire(entry: ConnectionEntry): Promise<void> {
  entry.retired = true;
  if (this.#connections.get(entry.key) === entry) this.#connections.delete(entry.key);
  if (entry.activeCalls === 0) return this.#closeEntry(entry);
  return entry.closed;
 }

 #closeEntry(entry: ConnectionEntry): Promise<void> {
  if (entry.closePromise) return entry.closePromise;
  entry.closePromise = disconnectServer(entry.connection).finally(() => {
   this.#allConnections.delete(entry);
   entry.resolveClosed();
  });
  return entry.closePromise;
 }
}

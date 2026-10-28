import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { SlackAuthService, SLACK_USER_SCOPES, type SlackAuthOptions } from "./auth";
import { SlackMCPClient, type SlackClientOptions } from "./client";
import { clearClientCredentials, saveClientCredentials } from "./config";
import { SlackAmbiguousWorkspaceError, SlackAuthError, SlackConfigError, SlackNotConnectedError } from "./errors";
import type { SlackClientCredentials, SlackCore, SlackWorkspace } from "./types";

export { SLACK_USER_SCOPES, clearClientCredentials, saveClientCredentials };
export { SlackAmbiguousWorkspaceError, SlackAuthError, SlackConfigError, SlackNotConnectedError };
export type { SlackAuthOptions, SlackClientOptions };

export interface SlackCoreOptions {
 auth?: SlackAuthOptions;
 client?: SlackClientOptions;
}

export function createSlackCore(options: SlackCoreOptions = {}): SlackCore {
 const auth = new SlackAuthService(options.auth);
 const client = new SlackMCPClient(auth, options.client);
 return {
  listWorkspaces: storage => auth.listWorkspaces(storage),
  resolveWorkspace: (storage, selector) => auth.resolveWorkspace(storage, selector),
  connectWorkspace: (storage, presenter, connectOptions) => auth.connectWorkspace(storage, presenter, connectOptions),
  saveClientCredentials: (storage: AuthStorage, credentials: SlackClientCredentials) =>
   saveClientCredentials(storage, credentials),
  clearClientCredentials: (storage: AuthStorage) => clearClientCredentials(storage),
  disconnectWorkspace: async (storage: AuthStorage, selector: string): Promise<SlackWorkspace> => {
   const workspace = await auth.resolveWorkspace(storage, selector);
   await client.closeWorkspace(workspace);
   return auth.disconnectWorkspace(storage, workspace.teamId);
  },
  setDefaultWorkspace: (storage, selector) => auth.setDefaultWorkspace(storage, selector),
  callTool: (storage, workspace, tool, args, signal) => client.callTool(storage, workspace, tool, args, signal),
  listTools: (storage, workspace, signal) => client.listTools(storage, workspace, signal),
  closeAll: () => client.closeAll(),
 };
}

export const slackCore: SlackCore = createSlackCore();

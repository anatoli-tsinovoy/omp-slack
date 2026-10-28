import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { openPath } from "@oh-my-pi/pi-coding-agent/utils/open";
import { renderSlackWorkspaces } from "./render";
import { slackCore } from "./core";
import type { SlackAuthPresenter, SlackCore, SlackWorkspace } from "./types";

const SUBCOMMANDS = ["setup", "login", "logout", "status", "default"] as const;
type SlackSubcommand = (typeof SUBCOMMANDS)[number];

export interface SlackCommandController {
	refreshWorkspaceCompletions(storage: AuthStorage): Promise<void>;
}

function parseCommandLine(args: string): { subcommand: string; value: string } {
	const trimmed = args.trim();
	const separator = trimmed.search(/\s/u);
	if (separator < 0) return { subcommand: trimmed.toLowerCase(), value: "" };
	return {
		subcommand: trimmed.slice(0, separator).toLowerCase(),
		value: trimmed.slice(separator).trim(),
	};
}

function commandUsage(subcommand?: string): string {
	switch (subcommand) {
		case "login":
			return "Usage: /slack login [team-id]";
		case "logout":
			return "Usage: /slack logout <workspace>";
		case "default":
			return "Usage: /slack default <workspace>";
		case "setup":
			return "Usage: /slack setup";
		case "status":
			return "Usage: /slack status";
		default:
			return "Slack commands: /slack setup, /slack login [team-id], /slack logout <workspace>, /slack status, /slack default <workspace>.";
	}
}

function authPresenter(ctx: ExtensionCommandContext): SlackAuthPresenter {
	return {
		onAuthUrl(url, instructions) {
			ctx.ui.notify(`${instructions ? `${instructions}\n\n` : ""}${url}`, "info");
			openPath(url);
		},
		onProgress(message) {
			ctx.ui.notify(message, "info");
		},
	};
}


function workspaceCompletions(prefix: string, workspaces: readonly SlackWorkspace[]) {
	const separator = prefix.search(/\s/u);
	if (separator < 0) {
		const normalized = prefix.toLowerCase();
		return SUBCOMMANDS
			.filter(subcommand => subcommand.startsWith(normalized))
			.map(subcommand => ({ value: subcommand, label: subcommand }));
	}

	const rawSubcommand = prefix.slice(0, separator);
	const subcommand = rawSubcommand.toLowerCase();
	if (subcommand !== "login" && subcommand !== "logout" && subcommand !== "default") return null;
	const selectorPrefix = prefix.slice(separator + 1).trimStart().toLowerCase();
	const matches = workspaces.filter(workspace =>
		[workspace.teamId, workspace.teamName, workspace.domain ?? ""].some(value => value.toLowerCase().startsWith(selectorPrefix)),
	);
	if (matches.length === 0) return null;
	return matches.map(workspace => ({
		value: `${rawSubcommand} ${workspace.teamId} `,
		label: `${workspace.teamName} (${workspace.teamId})${workspace.isDefault ? " (default)" : ""}`,
		description: workspace.domain,
	}));
}

async function handleSlackCommand(
	args: string,
	ctx: ExtensionCommandContext,
	core: SlackCore,
	setCompletions: (workspaces: SlackWorkspace[]) => void,
): Promise<void> {
	const { subcommand, value } = parseCommandLine(args);
	if (!subcommand) {
		ctx.ui.notify(commandUsage(), "info");
		return;
	}
	if (!SUBCOMMANDS.some(candidate => candidate === subcommand)) {
		ctx.ui.notify(commandUsage(), "error");
		return;
	}
	if ((subcommand === "setup" || subcommand === "status") && value) {
		ctx.ui.notify(commandUsage(subcommand), "error");
		return;
	}
	if ((subcommand === "logout" || subcommand === "default") && !value) {
		ctx.ui.notify(commandUsage(subcommand), "error");
		return;
	}

	const storage = ctx.modelRegistry.authStorage;
	try {
		switch (subcommand as SlackSubcommand) {
			case "setup": {
				const clientIdInput = await ctx.ui.input("Slack app client ID", "Client ID from your Slack app");
				if (clientIdInput === undefined) return;
				const clientId = clientIdInput.trim();
				if (!clientId) {
					ctx.ui.notify("A Slack app client ID is required.", "error");
					return;
				}
				const clientSecret = await ctx.ui.input(
					"Slack app client secret (optional)",
					"Leave blank for a public-client PKCE flow",
					{ secret: true },
				);
				if (clientSecret === undefined) return;
				await core.saveClientCredentials(storage, {
					clientId,
					...(clientSecret.trim() ? { clientSecret } : {}),
				});
				ctx.ui.notify("Slack app credentials saved for this OMP profile.", "info");
				return;
			}
			case "login": {
				const team = value || undefined;
				const workspace = await core.connectWorkspace(storage, authPresenter(ctx), team ? { team } : undefined);
				setCompletions(await core.listWorkspaces(storage));
				ctx.ui.notify(`Connected to ${workspace.teamName} (${workspace.teamId}).`, "info");
				return;
			}
			case "logout": {
				const workspace = await core.disconnectWorkspace(storage, value);
				setCompletions(await core.listWorkspaces(storage));
				ctx.ui.notify(`Logged out of ${workspace.teamName} (${workspace.teamId}).`, "info");
				return;
			}
			case "status": {
				const workspaces = await core.listWorkspaces(storage);
				setCompletions(workspaces);
				ctx.ui.notify(renderSlackWorkspaces(workspaces), "info");
				return;
			}
			case "default": {
				const workspace = await core.setDefaultWorkspace(storage, value);
				const workspaces = await core.listWorkspaces(storage);
				setCompletions(workspaces);
				ctx.ui.notify(`Default Slack workspace is now ${workspace.teamName} (${workspace.teamId}).`, "info");
				return;
			}
		}
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export function registerSlackCommand(pi: ExtensionAPI, core: SlackCore = slackCore): SlackCommandController {
	let workspaces: SlackWorkspace[] = [];
	const setCompletions = (next: SlackWorkspace[]) => {
		workspaces = next;
	};
	pi.registerCommand("slack", {
		description: "Set up, connect, and manage Slack workspaces",
		getArgumentCompletions: prefix => workspaceCompletions(prefix, workspaces),
		handler: (args, ctx) => handleSlackCommand(args, ctx, core, setCompletions),
	});
	return {
		async refreshWorkspaceCompletions(storage) {
			workspaces = await core.listWorkspaces(storage);
		},
	};
}

import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { openPath } from "@oh-my-pi/pi-coding-agent/utils/open";
import { slackCore } from "./core";
import { renderSlackWorkspaces } from "./render";
import type { SlackAuthPresenter, SlackCore } from "./types";

const SUBCOMMANDS = ["login", "logout", "status"] as const;
type SlackSubcommand = (typeof SUBCOMMANDS)[number];

const USAGE = "Slack commands: /slack login, /slack logout, /slack status.";

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

function isSubcommand(value: string): value is SlackSubcommand {
	return SUBCOMMANDS.some(candidate => candidate === value);
}

export interface SlackCommandOptions {
	/** Runs after a successful login, e.g. to register the Slack app's tools. */
	onLogin?: () => Promise<number>;
}

async function handleSlackCommand(
	args: string,
	ctx: ExtensionCommandContext,
	core: SlackCore,
	options: SlackCommandOptions,
): Promise<void> {
	const subcommand = args.trim().toLowerCase();
	if (!subcommand) {
		ctx.ui.notify(USAGE, "info");
		return;
	}
	if (!isSubcommand(subcommand)) {
		ctx.ui.notify(USAGE, "error");
		return;
	}
	try {
		switch (subcommand) {
			case "login": {
				const account = await core.login(authPresenter(ctx));
				const toolCount = (await options.onLogin?.()) ?? (await core.listTools()).length;
				const workspaces = await core.listWorkspaces();
				ctx.ui.notify(
					`Signed in to ChatGPT as ${account.email ?? account.accountId}; the Slack app exposes ${toolCount} tools.\n${renderSlackWorkspaces(workspaces)}`,
					"info",
				);
				return;
			}
			case "logout":
				await core.logout();
				ctx.ui.notify("Signed out of the Slack plugin's ChatGPT login.", "info");
				return;
			case "status": {
				const account = await core.account();
				if (!account) {
					ctx.ui.notify("Not signed in. Run `/slack login` to sign in with ChatGPT.", "info");
					return;
				}
				const tools = await core.listTools();
				const workspaces = await core.listWorkspaces();
				ctx.ui.notify(
					`ChatGPT login: ${account.email ?? "unknown email"} (workspace ${account.accountId}). Slack app tools: ${tools.length}.\n${renderSlackWorkspaces(workspaces)}`,
					"info",
				);
				return;
			}
		}
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export function registerSlackCommand(pi: ExtensionAPI, core: SlackCore = slackCore, options: SlackCommandOptions = {}): void {
	pi.registerCommand("slack", {
		description: "Sign in to ChatGPT for Slack, sign out, or show status",
		getArgumentCompletions: prefix => {
			const normalized = prefix.trim().toLowerCase();
			const matches = SUBCOMMANDS.filter(subcommand => subcommand.startsWith(normalized));
			return matches.length > 0 ? matches.map(subcommand => ({ value: subcommand, label: subcommand })) : null;
		},
		handler: (args, ctx) => handleSlackCommand(args, ctx, core, options),
	});
}

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerSlackCommand } from "./command";
import { slackCore } from "./core";
import { registerSlackProtocol, trackSlackProtocolStorage } from "./protocol";
import { registerSlackTool } from "./tool";

export default function slackExtension(pi: ExtensionAPI): void {
	const command = registerSlackCommand(pi, slackCore);
	registerSlackTool(pi, slackCore, storage => command.refreshWorkspaceCompletions(storage));
	const releaseProtocol = registerSlackProtocol(slackCore);
	let releaseStorage: (() => void) | undefined;
	let shutdownHandled = false;

	pi.on("session_start", async (_event, ctx) => {
		releaseStorage?.();
		const storage = ctx.modelRegistry.authStorage;
		releaseStorage = trackSlackProtocolStorage(storage);
		try {
			await command.refreshWorkspaceCompletions(storage);
		} catch (error) {
			pi.logger.warn("Could not load Slack workspace selectors for /slack completion", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});

	pi.on("session_shutdown", async () => {
		if (shutdownHandled) return;
		shutdownHandled = true;
		releaseStorage?.();
		releaseStorage = undefined;
		if (releaseProtocol()) await slackCore.closeAll();
	});
}

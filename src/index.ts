import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerSlackCommand } from "./command";
import { slackCore } from "./core";
import { registerSlackProtocol } from "./protocol";
import { registerSlackTools } from "./tool";

export default function slackExtension(pi: ExtensionAPI): void {
	const tools = registerSlackTools(pi, slackCore);
	registerSlackCommand(pi, slackCore, { onLogin: () => tools.sync() });
	const releaseProtocol = registerSlackProtocol(slackCore);
	let shutdownHandled = false;

	pi.on("session_start", async () => {
		if (!(await slackCore.account())) return;
		// Background: the Slack app's tools register once the gateway answers tools/list.
		void tools.sync().catch(error => {
			pi.logger.warn("Could not load Slack tools from the ChatGPT Slack app", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	});

	pi.on("session_shutdown", async () => {
		if (shutdownHandled) return;
		shutdownHandled = true;
		if (releaseProtocol()) await slackCore.closeAll();
	});
}

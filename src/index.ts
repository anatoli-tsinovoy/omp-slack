import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerSlackCommand } from "./command";
import { slackCore } from "./core";
import { registerSlackTool } from "./tool";

/** Sessions in this process sharing the `slackCore` gateway connection (subagents load the plugin too). */
let activeSessions = 0;

export default function slackExtension(pi: ExtensionAPI): void {
	registerSlackTool(pi, slackCore);
	registerSlackCommand(pi, slackCore);
	activeSessions++;
	let shutdownHandled = false;

	pi.on("session_shutdown", async () => {
		if (shutdownHandled) return;
		shutdownHandled = true;
		if (--activeSessions === 0) await slackCore.closeAll();
	});
}

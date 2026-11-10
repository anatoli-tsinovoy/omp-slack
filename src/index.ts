import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerSlackCommand } from "./command";
import { slackCore } from "./core";
import { registerSlackProtocol } from "./protocol";
import { registerSlackTool } from "./tool";

/** Sessions in this process sharing the `slackCore` gateway connection and the global `slack://` handler (subagents load the plugin too). */
let activeSessions = 0;
let releaseProtocol: (() => void) | undefined;

export default function slackExtension(pi: ExtensionAPI): void {
	registerSlackTool(pi, slackCore);
	registerSlackCommand(pi, slackCore);
	if (activeSessions++ === 0) releaseProtocol = registerSlackProtocol(slackCore);
	let shutdownHandled = false;

	pi.on("session_shutdown", async () => {
		if (shutdownHandled) return;
		shutdownHandled = true;
		if (--activeSessions > 0) return;
		releaseProtocol?.();
		releaseProtocol = undefined;
		await slackCore.closeAll();
	});
}

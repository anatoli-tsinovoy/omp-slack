import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerSlackCommand } from "./command";
import { slackCore } from "./core";
import { registerSlackProtocol } from "./protocol";
import { registerSlackTool } from "./tool";

export default function slackExtension(pi: ExtensionAPI): void {
	registerSlackTool(pi, slackCore);
	registerSlackCommand(pi, slackCore);
	const releaseProtocol = registerSlackProtocol(slackCore);
	let shutdownHandled = false;

	pi.on("session_shutdown", async () => {
		if (shutdownHandled) return;
		shutdownHandled = true;
		if (releaseProtocol()) await slackCore.closeAll();
	});
}

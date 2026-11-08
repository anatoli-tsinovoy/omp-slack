# omp-slack

An OMP plugin that reaches Slack through the **ChatGPT Slack app**. It signs in to ChatGPT with its own OAuth login and talks to the ChatGPT apps MCP gateway (`https://chatgpt.com/backend-api/ps/mcp`). Every Slack operation, read or write, goes through one discoverable `xd://slack` device. You don't create a Slack app or OAuth client.

## Install

```sh
omp plugin install github:anatoli-tsinovoy/omp-slack
```

OMP accepts `github:user/repo` plugin sources. Restart OMP if the current session does not discover the plugin. Requires OMP 18.18.1 or newer.

## Setup

### 1. Install Slack in ChatGPT

1. Sign in at [chatgpt.com](https://chatgpt.com) with the account and ChatGPT workspace that should reach Slack (for a work Slack, use your work ChatGPT workspace).
2. Open **Settings → Plugins**, choose **Slack**, and connect it to your Slack workspace. Your ChatGPT workspace admin may need to enable the Slack app first.

![ChatGPT Settings → Plugins with the Slack plugin installed](docs/chatgpt-slack-plugin.png)

### 2. Sign in from OMP

Run `/slack login` in OMP. Like OMP's own `/login openai-codex`, it opens a sign-in dialog that shows the full ChatGPT authorization URL, a local shortcut (`http://localhost:1455/launch`, this machine only), and a paste field, and it tries to open your browser. Pick the same account and ChatGPT workspace as in step 1. After sign-in, the Slack tools load into the current session.

On a headless or remote host (SSH, containers), open the full authorization URL in a browser on any machine. Once you sign in, the browser lands on `http://localhost:1455/auth/callback?code=…`, which won't load. Copy that whole URL from the address bar and paste it into the dialog. The authorization code alone also works. When OMP runs on the same machine as the browser, the callback on port 1455 finishes sign-in without a paste.

- `/slack status` shows the signed-in ChatGPT account and the Slack workspaces the app can reach.
- `/slack logout` deletes the plugin's login.

## Credentials

- The login is stored only in `~/.omp/agent/omp-slack/chatgpt-auth.json`, or `chatgpt-auth.<profile>.json` under a non-default OMP profile. The directory is mode `0700` and the file `0600`.
- It is separate from OMP's own logins. `/login openai-codex` and OMP's auth database are neither read nor changed, so the plugin can use a different ChatGPT workspace than your model provider.
- The access token is refreshed with the stored refresh token before it expires, and again after a `401` from the gateway. Neither case needs a new browser sign-in. Concurrent OMP processes pick up each other's rotated tokens from the file.
- A refresh that returns a different ChatGPT workspace is rejected; run `/slack login` again to switch.

## Use

All Slack operations go through the `xd://slack` device (`write` JSON to it; `read xd://slack` shows its usage):

```json
{"op":"workspaces"}
{"op":"tools"}
{"op":"schema","tool":"slack_read_channel"}
{"tool":"slack_search_public","args":{"keywords":["launch"],"natural_language_query":"launch plan"}}
{"tool":"slack_read_thread","args":{"channel_id":"C123456","message_ts":"1712345678.123456"}}
{"op":"login"}
```

- `op` defaults to `call`. Tool names drop the gateway's `slack.` prefix (the prefixed form also works).
- With several Slack workspaces, pass the `team_id` from `workspaces` in `args` where the tool's schema accepts it.
- No gateway connection opens until Slack is first used, and no Slack tool schemas enter the model's context at load: `tools` lists names, and each schema arrives only through its own `schema` op.
- Approval tiers: `tools`, `schema`, `workspaces`, and calls to the Slack app's read tools (`slack_read_*`, `slack_search_*`, `slack_list_*`, `slack_get_reactions`) run at the `read` tier. Sending, scheduling, reactions, canvas edits, membership changes, uploads, and `login` run at `write`. Tools from other ChatGPT connectors are never listed or callable.

Confirm with the user before sending or scheduling messages, adding reactions, or creating/editing canvases unless they explicitly requested that exact action.

## Included prompts

Bundled skills: `slack-search`, `slack-messaging`. Bundled workflow commands are namespaced with `slack-`: `/slack-summarize-channel`, `/slack-find-discussions`, `/slack-draft-announcement`, `/slack-standup`, and `/slack-channel-digest`.

**Avoid duplicate Slack skills:** Do not also run `npx skills add slackapi/slack-skills-plugin`. Its same-named skills target a different tool surface.

**NOTICE:** The `slack-search` and `slack-messaging` skills and five workflow commands are adapted from Slack's `slackapi/slack-skills-plugin` (MIT; Copyright (c) 2020- Slack Technologies, LLC). See [`skills/UPSTREAM-LICENSE`](./skills/UPSTREAM-LICENSE).

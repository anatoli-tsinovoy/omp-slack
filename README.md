# omp-slack

An OMP plugin that reaches Slack through the **ChatGPT Slack app**. It signs in to ChatGPT with its own OAuth login and talks to the ChatGPT apps MCP gateway (`https://chatgpt.com/backend-api/ps/mcp`). Only the Slack connector's tools are exposed, as native `mcp__slack_*` tools, alongside read-only `slack://` URLs for `read`, `glob`, and `grep`. You don't create a Slack app or OAuth client.

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

Run `/slack login` in OMP. A browser opens the ChatGPT sign-in page (OAuth callback `http://localhost:1455/auth/callback`, so port 1455 must be free). Pick the same account and ChatGPT workspace as in step 1. After sign-in, the Slack tools load into the current session.

- `/slack status` shows the signed-in ChatGPT account and the Slack workspaces the app can reach.
- `/slack logout` deletes the plugin's login.

## Credentials

- The login is stored only in `~/.omp/agent/omp-slack/chatgpt-auth.json`, or `chatgpt-auth.<profile>.json` under a non-default OMP profile. The directory is mode `0700` and the file `0600`.
- It is separate from OMP's own logins. `/login openai-codex` and OMP's auth database are neither read nor changed, so the plugin can use a different ChatGPT workspace than your model provider.
- The access token is refreshed with the stored refresh token before it expires, and again after a `401` from the gateway. Neither case needs a new browser sign-in. Concurrent OMP processes pick up each other's rotated tokens from the file.
- A refresh that returns a different ChatGPT workspace is rejected; run `/slack login` again to switch.

## Use

Read Slack data with `read` (and `grep` or `glob` on Slack URLs). `slack://` lists the connected workspaces; other URLs start with a workspace selector, either the team ID or the name:

```text
slack://
slack://acme/channels/
slack://acme/channels/engineering
slack://acme/threads/C123456/1712345678.123456
slack://acme/users/me
slack://acme/canvases/<canvas-id>
slack://acme/files/<file-id>
slack://acme/search?q=launch%20plan&scope=all
slack://acme/search?q=budget&type=files
```

In search, `q` is split into keywords, with quoted phrases kept whole, and is also sent as the natural-language query.

All other Slack operations use the Slack app's own tools, for example `mcp__slack_slack_search_public`, `mcp__slack_slack_read_user_profile`, and `mcp__slack_slack_send_message`. They are discoverable tools with the gateway's schemas, and they require approval like other write-capable tools. Tools from other ChatGPT connectors are never exposed or callable.

`slack://` is read-only. Confirm with the user before sending or scheduling messages, adding reactions, or creating/editing canvases unless they explicitly requested that exact action.

## Included prompts

Bundled skills: `slack-search`, `slack-messaging`. Bundled workflow commands are namespaced with `slack-`: `/slack-summarize-channel`, `/slack-find-discussions`, `/slack-draft-announcement`, `/slack-standup`, and `/slack-channel-digest`.

**Avoid duplicate Slack skills:** Do not also run `npx skills add slackapi/slack-skills-plugin`. Its same-named skills target a different tool surface.

**NOTICE:** The `slack-search` and `slack-messaging` skills and five workflow commands are adapted from Slack's `slackapi/slack-skills-plugin` (MIT; Copyright (c) 2020- Slack Technologies, LLC). See [`skills/UPSTREAM-LICENSE`](./skills/UPSTREAM-LICENSE).

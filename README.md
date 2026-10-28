# omp-slack

A standalone OMP plugin for Slack's hosted MCP server. It accesses Slack as your user account: reads use `slack://` URLs, other Slack tools use `xd://slack`, and no MCP connection opens until Slack is first used. It requests no bot scopes, subscribes to no events, and uses no Socket Mode.

## Install

```sh
omp plugin install github:anatoli-tsinovoy/omp-slack
```

OMP accepts `github:user/repo` plugin sources. Use the CLI so OMP records the installed package and runtime state; restart OMP if the current session does not discover the plugin.

## One-time Slack app setup

1. In your Slack org, create an internal app from [`slack-app-manifest.json`](./slack-app-manifest.json). It registers the default callback `http://localhost:3118/callback` and enables PKCE plus token rotation for refresh.
   If you set `OMP_SLACK_CALLBACK_PORT`, also add `http://localhost:<port>/callback` to `oauth_config.redirect_urls`; Slack requires the callback URI to match exactly.
2. Have a workspace/org admin approve the app and allow Slack MCP access if required by your organization's app or MCP policies. Slack's hosted MCP server supports internal apps and lets admins manage approvals.
3. Copy the app's **Client ID**. `/slack setup` requires it; the masked **Client Secret** prompt may be left empty for this PKCE public-client flow. Alternatively, set `OMP_SLACK_CLIENT_ID` and, if using a secret, `OMP_SLACK_CLIENT_SECRET`. Environment values take precedence over saved values.
4. Run `/slack login` and authorize your user account in the target workspace. Repeat login for each workspace you want to connect.

The manifest uses the schema fields `oauth_config.redirect_urls`, `oauth_config.pkce_enabled`, `oauth_config.scopes.user`, and `settings.token_rotation_enabled`; it contains user scopes only. See the [Slack app manifest reference](https://docs.slack.dev/reference/app-manifest/), [Slack MCP server guide](https://docs.slack.dev/ai/slack-mcp-server/), and [Slack PKCE guide](https://docs.slack.dev/authentication/using-pkce/).

**Skipping app creation (unverified):** Slack's own plugin configs ship public, secret-less client IDs: Claude Code `1601185624273.8899143856786` with callback port `3118` (matches the default here), Cursor `3660753192626.8903469228982`. Setting `OMP_SLACK_CLIENT_ID` to one of them runs the same PKCE flow under that app's identity. Whether Slack completes the exchange for a non-Claude/Cursor client, and whether that app grants every scope requested here, has not been tested; your workspace must also have approved that app. Fall back to the internal app above if login fails.

## Use

Inspect available tools and a tool's live schema with `write` to `xd://slack`:

```json
{"op":"tools"}
{"op":"schema","tool":"slack_search_public"}
{"op":"connect"}
```

Call Slack MCP tools through the same device, using their live schema for `args` and choosing the workspace explicitly when needed:

```json
{"tool":"slack_search_public","args":{...},"workspace":"acme"}
```

Do not guess argument fields. If the server rejects arguments, use its schema and preserve its error text verbatim.

Read Slack data directly with `read` (and use `grep` or `glob` on Slack URLs when useful):

```text
slack://acme/channels/
slack://acme/channels/engineering
slack://acme/threads/C123456/1712345678.123456
slack://acme/users/me
slack://acme/canvases/<canvas-id>
slack://acme/files/<file-id>
slack://acme/search?q=launch%20plan&scope=all
slack://acme/search?q=budget&type=files
```

`slack://` is read-only. Confirm with the user before sending or scheduling messages, adding reactions, or creating/editing canvases unless they explicitly requested that exact action.

## Workspaces and included prompts

Use `/slack status` to see connected workspaces, `/slack default` to choose the default, and `/slack logout` to remove a workspace authorization. URLs and tool calls can specify a workspace; an omitted selector uses the configured default when unambiguous.

Bundled skills: `slack-search`, `slack-messaging`. Bundled workflow commands are namespaced with `slack-`: `/slack-summarize-channel`, `/slack-find-discussions`, `/slack-draft-announcement`, `/slack-standup`, and `/slack-channel-digest`.

**Privacy:** User OAuth tokens and client credentials entered through `/slack setup` are stored in OMP auth storage; environment credentials remain in your environment. Access is as your Slack user under the scopes you approved; protect the relevant OMP profile or environment.

**Avoid duplicate Slack skills:** Do not also run `npx skills add slackapi/slack-skills-plugin`. Its same-named skills target raw MCP tools rather than this plugin's `xd://slack` and `slack://` surfaces.

**NOTICE:** The `slack-search` and `slack-messaging` skills and five workflow commands are adapted from Slack's `slackapi/slack-skills-plugin` (MIT; Copyright (c) 2020- Slack Technologies, LLC). See [`skills/UPSTREAM-LICENSE`](./skills/UPSTREAM-LICENSE).

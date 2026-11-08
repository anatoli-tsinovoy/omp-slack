---
description: Summarize recent activity in a Slack channel.
---

Given the channel name or ID in `$ARGUMENTS` (strip a leading `#`):

1. Use the requested workspace. If several workspaces are connected and none was named, ask the user to choose. If Slack reports that the plugin is not signed in, ask the user to run `/slack login`.
2. Read `slack://<ws>/channels/<name-or-id>` for recent history. If the name cannot be resolved, inspect `slack://<ws>/channels/`; if needed, call `slack_search_channels` through `write xd://slack` after checking its schema.
3. For messages with replies, read each relevant thread at `slack://<ws>/threads/<channel>/<ts>` so the summary includes the discussion and outcome.
4. Summarize the main topics, key decisions or action items, notable announcements, and active threads. Mention who said what when it matters.
5. Keep the result concise and scannable, with short bullets grouped by topic. If the returned history is quiet, say so and include the latest visible message time.

Use `read` for Slack URLs and `write xd://slack` only for actions the URLs do not cover. Do not send or change Slack content as part of this summary.

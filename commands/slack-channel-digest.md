---
description: Digest recent Slack activity across the requested channels.
---

Given the comma-separated channel names in `$ARGUMENTS`:

1. Split the names, trim whitespace, and remove a leading `#` from each.
2. Use the requested workspace or the configured default. If the workspace is ambiguous, ask the user to choose. If none is authorized, connect with `write xd://slack` and `{"op":"connect"}`, or ask the user to run `/slack login`.
3. For each channel, read `slack://<ws>/channels/<name-or-id>`. If a name cannot be resolved, inspect `slack://<ws>/channels/` or discover `slack_search_channels` with `write xd://slack` and its live schema.
4. Read relevant active threads at `slack://<ws>/threads/<channel>/<ts>`. Summarize notable topics, decisions, questions, and action items.
5. Present:

   ```text
   **Channel Digest — <today's date>**

   **#channel-1**
   - ...

   **#channel-2**
   - ...
   ```

   Keep each channel to 3–5 actionable or noteworthy bullets. If a channel is quiet, say so and include the latest visible message time.
6. If a channel cannot be found or read, report that for the channel and continue with the others.

Use `read` for retrieval and `write xd://slack` only for tool discovery or other operations. Do not post or change Slack content as part of a digest.

---
description: Digest recent Slack activity across the requested channels.
---

Given the comma-separated channel names in `$ARGUMENTS`:

1. Split the names, trim whitespace, and remove a leading `#` from each.
2. Use the requested workspace. If several workspaces are connected and none was named, ask the user to choose. If Slack reports that the plugin is not signed in, ask the user to run `/slack login`.
3. For each channel, find its id with `slack_search_channels` (or `slack_list_user_channels`) and read recent history with `slack_read_channel`, all through `write xd://slack` after checking each tool's schema.
4. Read relevant active threads with `slack_read_thread`. Summarize notable topics, decisions, questions, and action items.
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

Use `read` for retrieval. Do not post or change Slack content as part of a digest.

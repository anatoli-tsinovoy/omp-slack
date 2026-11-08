---
description: Build a standup update from the user's recent Slack activity.
---

1. Use the requested workspace. If several workspaces are connected and none was named, ask the user to choose. If Slack reports that the plugin is not signed in, ask the user to run `/slack login`.
2. Read the authenticated user's profile with `write xd://slack` and `{"op":"profile"}` to identify their user ID and display name.
3. Search recent messages by that user with `{"op":"search","query":"from:<@USER_ID> after:YYYY-MM-DD"}` for the previous day; add `"scope":"all"` only when the user wants broad private-channel/DM coverage.
4. Read relevant threads with the `thread` op printed next to threaded results so the user's contributions have context.
5. Build an evidence-based standup without inferring plans or blockers that the messages do not support:

   ```text
   **Standup for <display name> — <today's date>**

   **Done:**
   - ...

   **Doing:**
   - ...

   **Blockers:**
   - None / ...
   ```

6. Present the standup for review. Do not post or schedule it unless the user explicitly asked for that action; then call the matching tool through `write xd://slack` with its schema. A request to generate a standup alone does not authorize posting.

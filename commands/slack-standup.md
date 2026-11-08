---
description: Build a standup update from the user's recent Slack activity.
---

1. Use the requested workspace. If several workspaces are connected and none was named, ask the user to choose. If Slack reports that the plugin is not signed in, ask the user to run `/slack login`.
2. Read the authenticated user's profile with `slack_read_user_profile` (no user id) through `write xd://slack` to identify their user ID and display name.
3. Search recent messages by that user with `slack_search_public` using `from:<@USER_ID>` and `after:YYYY-MM-DD` for the previous day; use `slack_search_public_and_private` only when the user wants broad private-channel/DM coverage. Check each tool's schema first.
4. Read relevant threads with `slack_read_thread` so the user's contributions have context.
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

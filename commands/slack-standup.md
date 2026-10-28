---
description: Build a standup update from the user's recent Slack activity.
---

1. Use the requested workspace or the configured default. If the workspace is ambiguous, ask the user to choose. If none is authorized, connect with `write xd://slack` and `{"op":"connect"}`, or ask the user to run `/slack login`.
2. Read the authenticated user's profile with `read slack://<ws>/users/me` to identify their user ID and display name.
3. Search recent messages by that user with `read slack://<ws>/search?q=<URL-encoded-from-and-after-filters>`. Use `from:<@USER_ID>` and `after:YYYY-MM-DD` for the previous day; use `scope=all` only when the user wants broad private-channel/DM coverage.
4. Read relevant threads at `slack://<ws>/threads/<channel>/<ts>` so the user's contributions have context.
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

6. Present the standup for review. Do not post or schedule it unless the user explicitly asked for that action; use the matching `xd://slack` tool with its live schema. A request to generate a standup alone does not authorize posting.

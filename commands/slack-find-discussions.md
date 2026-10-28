---
description: Find and summarize Slack discussions about a topic.
---

Given the topic in `$ARGUMENTS`:

1. Use the requested workspace or the configured default. If the workspace is ambiguous, ask the user to choose. If none is authorized, connect with `write xd://slack` and `{"op":"connect"}`, or ask the user to run `/slack login`.
2. Search with `read slack://<ws>/search?q=<URL-encoded-topic>`. Start with a short natural-language phrase; if results are sparse, search the key terms or synonyms. Add `scope=all` only when the user wants broader private-channel/DM coverage.
3. Read the full thread for relevant threaded results at `slack://<ws>/threads/<channel>/<ts>`.
4. Present the top 5–10 discussions by relevance. For each, give the channel, starter when visible, date, brief context, and any conclusion, decision, or open question. Group related discussions across channels.
5. If nothing is found, say so and suggest broader or alternative terms.

Use search results as leads, not as complete evidence; read the source thread before summarizing. Use `write xd://slack` for tool discovery or other operations, following each tool's live schema. Do not post or change Slack content.

---
description: Draft a Slack announcement, review it with the user, and save it as a Slack draft after approval.
---

Given the topic or context in `$ARGUMENTS`:

1. Ask only the clarifying questions the user has not already answered: target channel, audience, key message or call to action, deadline/date, and appropriate tone.
2. Compose a concise announcement in standard Markdown. Lead with the main point, use short paragraphs and bullets, and end with a clear next step when appropriate.
3. Present the complete draft and destination to the user for review. Ask before saving a Slack-hosted draft; a request to draft is not permission to send.
4. After the user approves saving the draft, resolve the channel using `read slack://<ws>/channels/` or, if needed, `slack_search_channels` through `write xd://slack` after inspecting its schema.
5. Discover or inspect `slack_send_message_draft` with `write xd://slack` (`{"op":"tools"}` / `{"op":"schema","tool":"slack_send_message_draft"}`), then call it using exactly the live schema and the selected workspace. If the server rejects arguments, relay its error text verbatim.
6. Tell the user when the draft is saved in Slack. Do not send or schedule it. Sending or scheduling requires a separate explicit user request and confirmation unless the user already requested that exact action.

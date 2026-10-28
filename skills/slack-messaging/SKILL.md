---
name: slack-messaging
description: "Compose and review Slack messages, drafts, scheduled posts, reactions, and canvas changes through OMP's Slack surfaces."
---

# Slack Messaging

Use this skill when composing, drafting, scheduling, or improving Slack messages, replies, or canvas content.

## Safety and access

- Before sending or scheduling a message, adding a reaction, or creating or editing a canvas, show the exact target and proposed content/action and get the user's confirmation, unless they explicitly requested that exact action.
- A request to draft is not permission to send. Treat saving a draft in Slack as a write: show the draft and destination and get approval before saving it with `slack_send_message_draft`.
- Read existing context with `read slack://<ws>/...`; the URL protocol is read-only. Perform other operations only with `write xd://slack`.
- Discover available tools with `write xd://slack` and `{"op":"tools"}`. Inspect argument fields with `{"op":"schema","tool":"slack_send_message"}` before calling an unfamiliar tool.
- Call tools through `write xd://slack` using `{"tool":"slack_...","args":{...},"workspace":"<ws>"}`. Follow the live schema exactly; NEVER guess argument names. When arguments are rejected, report Slack's error text verbatim and correct them using the schema.
- If no workspace is authorized, connect with `{"op":"connect"}` through `xd://slack` or ask the user to run `/slack login`. Do not guess which workspace they mean.

## Message formatting

Message tools accept standard Markdown and convert it to Slack formatting. Use normal Markdown; NEVER use Slack's legacy single-character `mrkdwn` forms such as `*bold*` or `~strike~`. Keep messages concise; each text element is limited to about 5,000 characters.

| Format | Markdown |
| --- | --- |
| Bold | `**text**` |
| Italic | `_text_` or `*text*` |
| Strikethrough | `~~text~~` |
| Inline code | `` `code` `` |
| Quote | `> text` |
| Link | `[display text](url)` |
| Bulleted list | `- item` |
| Numbered list | `1. item` |

Code blocks, tables, and headings work as Markdown. Escape a literal pipe in a table cell as `\|`. Inline images usually render as links, not embedded images; use a canvas for document-style content with embedded images.

## Composition and etiquette

- Lead with the point; the first line may be all readers see in notifications.
- Aim for one to three short paragraphs. Use blank lines and bullets for scannability.
- Bold key names, dates, deadlines, and action items; keep emoji sparse.
- Match the channel's tone and audience.
- Reply in the existing thread when responding to a specific message. Read it first with `slack://<ws>/threads/<channel>/<ts>`; use the live send-tool schema for any reply fields.
- Post in a channel for a new topic or announcement. Do not start a new thread to continue an existing conversation.
- For an announcement, make the context, key information, and call to action clear.

## Scheduling, reactions, and canvases

- Use `slack_schedule_message` only after the required confirmation. Slack scheduling accepts a time at least two minutes in the future and no more than 120 days out; use the time field shown by the live schema.
- Scheduled messages cannot be edited through the API after scheduling; tell the user they must manage them in Slack.
- Use `slack_add_reaction` only after confirmation. If reading existing reactions is necessary, check whether the server exposes `slack_get_reactions` with `tools`/`schema`; NEVER assume the unconfirmed tool exists.
- Read canvases with `read slack://<ws>/canvases/<id>`. Canvas Markdown differs from message Markdown: it supports headers, tables, checklists, inline images, user/channel reference cards, callouts, and columns. Check the live `slack_create_canvas` or `slack_update_canvas` schema before writing; get confirmation before creating or changing the canvas.
- Use the server's exact error text when a tool rejects arguments; do not hide or paraphrase the failure.

---
name: slack-search
description: "Search Slack messages, files, channels, and people; gather workspace context and read histories, threads, profiles, canvases, and files."
---

# Slack Search

Use this skill when locating Slack messages, conversations, files, channels, or people, or gathering Slack context to answer a question.

## Access and workspace selection

- Use a workspace selector such as its team ID, name, or domain in every `slack://` URL and tool call. If the intended workspace is unclear, ask instead of searching another one.
- Read Slack data with `read slack://<ws>/...`. The protocol is read-only; use `write xd://slack` for every other operation.
- If no workspace is authorized, connect with `write xd://slack` and `{"op":"connect"}`, or ask the user to run `/slack login`.
- Discover available tools with `write xd://slack` and `{"op":"tools"}`. Get a tool's live argument schema with `{"op":"schema","tool":"slack_search_public"}`.
- Call tools only through `write xd://slack`, using `{"tool":"slack_...","args":{...},"workspace":"<ws>"}`. Use the live schema; NEVER guess unknown arguments. If Slack rejects arguments, report its error text verbatim and correct them from the schema.

## Read and search URLs

- `slack://<ws>/channels/` lists channels.
- `slack://<ws>/channels/<name-or-id>` reads channel history.
- `slack://<ws>/threads/<channel>/<ts>` reads a full thread.
- `slack://<ws>/users/<id>` and `slack://<ws>/users/me` read profiles.
- `slack://<ws>/canvases/<id>` reads a canvas.
- `slack://<ws>/files/<id>` reads a file.
- `slack://<ws>/search?q=<encoded-query>` searches Slack. Add `scope=all` when the user wants broader private-channel/DM coverage; results remain limited to the authenticated user's Slack access. Add `type=files` to search files.
- Use `grep` or `glob` on Slack URLs when filtering or inspecting returned content is useful.

Example: `read slack://acme/search?q=launch%20plan&scope=all`

For channel or user discovery not available through a URL, use `slack_search_channels` or `slack_search_users` through `xd://slack`, after checking the live schema.

## Search strategy

1. Start with a simple phrase or a few keywords.
2. If results are broad, add a channel, author, or date filter.
3. If results are sparse, remove filters and try synonyms or more specific terms.
4. Break complex questions into separate searches: topic, people, then channel.
5. Read source messages and threads before presenting conclusions; do not treat search snippets as full context.

### Search modifiers

- **Location:** `in:channel-name`, `in:<#C123456>`, `-in:channel-name`, `in:<@U123456>`, `in:@username`
- **People:** `from:<@U123456>`, `from:username`, `to:<@U123456>`, `to:me`, `creator:@username`
- **Content:** `is:thread`, `is:saved`, `has:pin`, `has:link`, `has:file`, `has::emoji:`, `hasmy::emoji:`
- **Dates:** `before:YYYY-MM-DD`, `after:YYYY-MM-DD`, `on:YYYY-MM-DD`, `during:month`
- **Text:** `"exact phrase"`, `-word`, `wild*` (at least three characters before `*`)

Boolean operators (`AND`, `OR`, `NOT`) and parentheses are unsupported. Spaces imply AND; repeating the same modifier can OR its values.

## File searches

Use `type=files` in the URL and Slack file filters in `q`, such as `type:pdfs`, `type:documents`, `type:images`, `type:spreadsheets`, or `type:presentations`. Standard filters such as `in:`, `from:`, and dates can narrow file searches.

Example: `read slack://acme/search?q=budget%20type%3Apdfs&type=files`

## Following up

- Read the full thread at `slack://<ws>/threads/<channel>/<ts>` for threaded results.
- Read surrounding channel history at `slack://<ws>/channels/<name-or-id>`.
- Read a profile at `slack://<ws>/users/<id>` or the authenticated user's profile at `slack://<ws>/users/me`.
- Read files and canvases at their `files/<id>` and `canvases/<id>` URLs.
- Slack search may lag behind very recent messages; check channel history for current activity.
- If a tool name or argument is uncertain, inspect `tools`/`schema`; if a tool is unavailable, state that instead of substituting a guessed call.

---
name: slack-search
description: "Search Slack messages, files, channels, and people; gather workspace context and read histories, threads, profiles, canvases, and files."
---

# Slack Search

Use this skill when locating Slack messages, conversations, files, channels, or people, or gathering Slack context to answer a question.

## Access and workspace selection

- Every Slack operation is a `write` to `xd://slack`: `{"op":"tools"}` lists the Slack app's tools, `{"op":"schema","tool":"slack_search_public"}` shows one tool's arguments, and `{"tool":"slack_search_public","args":{...}}` calls it.
- Check a tool's schema before its first call; NEVER guess argument names. If Slack rejects arguments, report its error text verbatim and correct them from the schema.
- `{"op":"workspaces"}` lists connected workspaces with their `team_id`. If several are connected, pass the intended `team_id` where the schema accepts it; if the intended workspace is unclear, ask instead of searching another one.
- If Slack reports that the plugin is not signed in, ask the user to run `/slack login`.

## Read and search tools

- `slack_search_public` searches public content; `slack_search_public_and_private` adds private channels and DMs when the user wants broader coverage. Results stay limited to the authenticated user's Slack access.
- `slack_search_channels` and `slack_search_users` find channels and people by name; `slack_list_user_channels` lists the user's channels.
- `slack_read_channel` reads channel history (by channel id); `slack_read_thread` reads a full thread (channel id + parent message `ts`).
- `slack_read_user_profile` reads a profile; with no user id it reads the authenticated user's own profile.
- `slack_read_canvas` and `slack_read_file` read canvases and files by id.

Example: `{"tool":"slack_search_public_and_private","args":{"keywords":["\"launch plan\""],"natural_language_query":"launch plan"}}` (confirm field names with `schema` first).

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

Use the search tool's file content-type argument (see its schema) and Slack file filters in the query, such as `type:pdfs`, `type:documents`, `type:images`, `type:spreadsheets`, or `type:presentations`. Standard filters such as `in:`, `from:`, and dates can narrow file searches.

## Following up

- Read the full thread with `slack_read_thread` for threaded results.
- Read surrounding history with `slack_read_channel`.
- Read profiles, files, and canvases with `slack_read_user_profile`, `slack_read_file`, and `slack_read_canvas`.
- Slack search may lag behind very recent messages; check channel history for current activity.
- If a tool name or argument is uncertain, inspect `tools`/`schema`; if a tool is unavailable, state that instead of substituting a guessed call.

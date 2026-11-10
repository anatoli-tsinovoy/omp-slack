---
name: slack-search
description: "Search Slack messages, files, channels, and people; gather workspace context and read histories, threads, profiles, canvases, and files."
---

# Slack Search

Use this skill when locating Slack messages, conversations, files, channels, or people, or gathering Slack context to answer a question.

## Access and workspace selection

- Every Slack operation is a `write` of JSON to `xd://slack`.
- The same reads are read-only `slack://` URLs for OMP's `read`, `glob`, and `grep` tools (see below).
- `{"op":"workspaces"}` lists connected workspaces. With several, pass `"workspace":"<team id or name>"` on every read; if the intended workspace is unclear, ask instead of searching another one.
- If Slack reports that the plugin is not signed in, ask the user to run `/slack login`.

## Read ops

- `{"op":"channels"}` lists your channels; add `"channel":"<prefix>"` to filter by name prefix.
- `{"op":"history","channel":"#name-or-id"}` reads channel history; add `limit`, `oldest`, or `latest` (Slack ts) to page. Channel names resolve automatically.
- `{"op":"thread","channel":"C123","ts":"1712345678.123456"}` reads a full thread. History and search results print the exact `thread` op after every message with replies; copy it.
- `{"op":"profile"}` reads your own profile; `{"op":"profile","user":"U123"}` reads someone else's.
- `{"op":"canvas","id":"F123"}` and `{"op":"file","id":"F123"}` read canvases and files.
- `{"op":"search","query":"..."}` searches public messages. Add `"scope":"all"` when the user wants private channels and DMs too; results stay limited to the authenticated user's Slack access. Add `"type":"files"` to search files.

Example: `{"op":"search","query":"\"launch plan\" in:#product after:2026-01-01","scope":"all"}`

For people or channel discovery beyond these ops, call `slack_search_users` or `slack_search_channels` with `{"tool":"...","args":{...}}` after checking `{"op":"schema","tool":"..."}`. NEVER guess arguments; if Slack rejects them, report its error text verbatim and correct them from the schema.

## Slack as files: `slack://`

- `read slack://` lists workspaces; `read slack://<workspace>/channels/` lists your channels. The workspace is a team name or ID.
- `slack://<workspace>/channels/<name or id>?limit=&oldest=&latest=` is a channel's history, `threads/<channel>/<ts>` a thread, `users/<id or me>`, `canvases/<id>`, and `files/<id>` the matching records, and `search?q=…&scope=all&type=files&limit=` a search. Messages with replies link their `slack://…/threads/…` URL; read it to follow the thread.
- `grep "<pattern>" slack://<workspace>/channels/<name>` searches the recent history you'd read. `grep` reads every channel it walks, so name the channels or use a glob like `eng-*`; for workspace-wide questions, use Slack search instead.

## Search strategy

1. Start with a simple phrase or a few keywords.
2. If results are broad, add a channel, author, or date modifier.
3. If results are sparse, remove modifiers and try synonyms or more specific terms.
4. Break complex questions into separate searches: topic, people, then channel.
5. Read source messages and threads before presenting conclusions; do not treat search snippets as full context.

### Search modifiers

Modifiers in `query` are sent as Slack search filters; the remaining words are keywords.

- **Location:** `in:channel-name`, `in:<#C123456>`, `-in:channel-name`, `in:<@U123456>`, `in:@username`
- **People:** `from:<@U123456>`, `from:username`, `to:<@U123456>`, `to:me`, `creator:@username`
- **Content:** `is:thread`, `is:saved`, `has:pin`, `has:link`, `has:file`, `has::emoji:`, `hasmy::emoji:`
- **Dates:** `before:YYYY-MM-DD`, `after:YYYY-MM-DD`, `on:YYYY-MM-DD`, `during:month`
- **Text:** `"exact phrase"`, `-word`, `wild*` (at least three characters before `*`)

Boolean operators (`AND`, `OR`, `NOT`) and parentheses are unsupported. Spaces imply AND; repeating the same modifier can OR its values.

## File searches

Use `"type":"files"` and Slack file filters in `query`, such as `type:pdfs`, `type:documents`, `type:images`, `type:spreadsheets`, or `type:presentations`. Standard modifiers such as `in:`, `from:`, and dates narrow file searches.

Example: `{"op":"search","query":"budget type:pdfs","type":"files"}`

## Following up

- Read the full thread with the `thread` op printed next to a threaded result.
- Read surrounding history with `history`.
- Read profiles, files, and canvases with `profile`, `file`, and `canvas`.
- Slack search may lag behind very recent messages; check channel history for current activity.
- If a tool name or argument is uncertain, inspect `tools`/`schema`; if a tool is unavailable, state that instead of substituting a guessed call.

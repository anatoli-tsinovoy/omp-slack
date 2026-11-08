Slack through the ChatGPT Slack app, for reads and writes. Reads (`workspace` is a team id or name, optional with one workspace; `channel` is an id, name, or `#name`):
- `{"op":"workspaces"}` lists workspaces.
- `{"op":"channels","channel":"<name-prefix>"}` lists your channels (prefix optional).
- `{"op":"history","channel":"#general","limit":20,"oldest":"<ts>","latest":"<ts>"}` reads channel history; messages with replies carry the exact `thread` op to read them.
- `{"op":"thread","channel":"C123","ts":"1712345678.123456"}` reads a thread.
- `{"op":"search","query":"launch plan from:<@U123> after:2026-01-01","scope":"all","type":"files"}` searches; modifiers (`in:`, `from:`, `to:`, `after:`, `before:`, `on:`, `during:`, `is:`, `has:`) become filters, the rest keywords (quoted phrases stay whole). `scope:"all"` adds private channels and DMs; `type:"files"` searches files.
- `{"op":"profile","user":"U123"}` (omit `user` for yourself), `{"op":"canvas","id":"F123"}`, `{"op":"file","id":"F123"}`.
Any other Slack app tool: `{"op":"tools"}` lists them, `{"op":"schema","tool":"slack_send_message"}` shows one `inputSchema`, `{"tool":"slack_send_message","args":{...}}` calls it (`op` defaults to `call`; follow the schema exactly). `{"op":"login"}` signs in with ChatGPT when Slack reports no login. Sending, scheduling, reacting, and creating or editing canvases change Slack: confirm with the user first unless they asked for that exact action.

---
name: connect-claude-desktop
description: Connect the waterloo-learn MCP server to the Claude Desktop app. Use when the user wants to register, install, set up, or wire this MCP server into Claude Desktop.
---

# Connect waterloo-learn to Claude Desktop

Registers this project's MCP server with the Claude Desktop app so the LEARN
tools (`list_courses`, `get_announcements`, `get_content`, `get_topic_file`,
`get_grades`, `get_upcoming`) appear in Claude Desktop chats. `get_topic_file`
returns lecture slides as images, so asking things like *"summarize my last
lesson"* or *"what's the diagram on slide 4?"* works without uploading the PDF.

The server is a **local stdio** server. Claude Desktop launches it as a child
process via an entry in its config file. This is different from ChatGPT desktop,
which uses its own connector UI and generally expects a remote (HTTP/SSE) server
— this skill does **not** apply to ChatGPT.

## Config file location

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

## Steps

### 1. Build the server

The config points at compiled JS in `dist/`, so it must exist and be current.

```sh
cd <project-root>
npm install            # if node_modules is missing
npx playwright install chromium   # if Chromium isn't installed yet
npm run build
```

### 2. Make sure a session exists

Tools fail with a "No valid LEARN session" message until `auth.json` exists.
This step is **manual** — it needs a human to complete WatIAM + Duo 2FA and
cannot be automated:

```sh
npm run login          # opens a headed browser; sign in + approve Duo push
```

`auth.json` saves to the project root and is gitignored. Re-run this whenever
the session expires.

### 3. Add the server entry (merge — never clobber)

The config file usually already contains other `mcpServers` and a `preferences`
block. **Read the existing file, add one key, write it back** — do not overwrite
the whole file. Use a script rather than hand-editing to preserve formatting and
avoid corrupting JSON:

```sh
node -e "
const fs = require('fs');
const p = process.env.HOME + '/Library/Application Support/Claude/claude_desktop_config.json';
const cfg = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers['waterloo-learn'] = {
  command: 'node',
  args: ['<ABSOLUTE-PATH-TO-PROJECT>/dist/index.js'],
  env: {}
};
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
console.log('Registered. mcpServers:', Object.keys(cfg.mcpServers).join(', '));
"
```

Replace `<ABSOLUTE-PATH-TO-PROJECT>` with the real absolute path. The `args`
path must be **absolute** — Claude Desktop does not run from the project
directory.

Optional `env` overrides:
- `LEARN_AUTH_FILE` — point at `auth.json` if it lives outside the project root.
- `LEARN_BASE_URL` — override the LEARN URL (defaults to `https://learn.uwaterloo.ca`).

### 4. Restart Claude Desktop

Claude Desktop only reads the config on launch. **Fully quit** (Cmd+Q on macOS,
not just closing the window) and reopen it.

### 5. Verify

In Claude Desktop, open the tools/connectors menu — `waterloo-learn` should be
listed with its 6 tools. Or just ask: *"What courses am I taking on LEARN?"* and
confirm it invokes `list_courses`.

## Troubleshooting

- **Server not listed after restart** — confirm `dist/index.js` exists
  (`npm run build`), the path in `args` is absolute and correct, and the JSON is
  valid (`node -e "JSON.parse(require('fs').readFileSync(PATH))"`).
- **Tools return "No valid LEARN session"** — run `npm run login` again.
- **Edited source but behavior is stale** — re-run `npm run build`; the config
  runs compiled JS from `dist/`, not the TypeScript source.

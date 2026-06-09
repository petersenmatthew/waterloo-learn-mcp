# waterloo-learn-mcp

MCP server exposing your [Waterloo LEARN](https://learn.uwaterloo.ca) courses to AI apps. LEARN sits behind WatIAM + Duo, so auth is split out: you log in once in a real browser, the session is saved to `auth.json`, and the server runs headless off that until it expires.

`auth.json` and `.env.local` hold secrets. Both are gitignored — treat them like passwords.

## Install

```sh
npm install
npx playwright install chromium
npm run build
npm run login          # browser opens; sign in + approve Duo. Saves auth.json
```

## Tools

| Tool | Args | Returns |
| --- | --- | --- |
| `list_courses` | — | Course names + `ou` IDs |
| `get_announcements` | `courseId` | Announcements (title, body, date, attachments) |
| `get_content` | `courseId` | Content modules/topics with URLs |
| `get_topic_file` | `courseId`, `topicId`, `pages?` | Lecture PDF/PPTX rendered as one image per slide (cap 25; `pages` like `"4"` or `"2-6"`) |
| `get_grades` | `courseId` | Grade items (grade, points, weight, feedback) |
| `get_upcoming` | `courseId`, `daysAhead?` | Due dates / events (default 30 days) |

## Connect to Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`, then restart the app:

```json
{
  "mcpServers": {
    "waterloo-learn": {
      "command": "node",
      "args": ["/absolute/path/to/waterloo-learn-mcp/dist/index.js"]
    }
  }
}
```

Local, no tunnel, no exposed session. Details: [skills/connect-claude-desktop/SKILL.md](skills/connect-claude-desktop/SKILL.md).

## Connect to ChatGPT

ChatGPT only talks to remote HTTPS servers. This exposes one over **Tailscale Funnel** (free, no VPS, stable URL):

```sh
npm run setup:chatgpt       # builds, enables Funnel, prints your connector URL
npm run autostart:chatgpt   # optional: keep server running across reboots
```

It prints a URL like `https://<device>.ts.net/mcp/<secret>`. In ChatGPT → Settings → Connectors → Developer mode → Add custom connector: **Server URL** + **No Auth** (ChatGPT has no API-key field, so the secret rides in the path). Details: [skills/connect-chatgpt/SKILL.md](skills/connect-chatgpt/SKILL.md).

The full URL is the password — anyone with it can read your LEARN data. Your laptop must be awake with the server running for ChatGPT to reach it.

## After a reboot (ChatGPT path)

`setup:chatgpt` is one-time. The connector URL, secret, Funnel config, and `auth.json` all persist. Only the server process stops on reboot:

- **Ran `autostart:chatgpt`** → nothing to do; it restarts itself on login.
- **Didn't** → `npm run start:http` to bring the server back. (No need to re-run setup.)

Tailscale must be running for Funnel to work (the macOS app auto-starts on login by default).

## Notes

- `list_courses` uses the enrollments API, falling back to homepage scraping. Other tools call D2L's REST API through the authenticated session.
- `get_topic_file` returns slides as **images** so the model can read diagrams, not just text. PDFs need nothing extra; PowerPoint topics additionally need [LibreOffice](https://www.libreoffice.org) (`brew install --cask libreoffice`) for the PPTX→PDF step. Image tool results work natively in Claude; ChatGPT's support for them is untested.
- **"No valid LEARN session"** (or tools failing after weeks) = session expired → `npm run login` again. Independent of reboots.
- Override with env vars: `LEARN_BASE_URL`, `LEARN_AUTH_FILE`, `PORT`, `LEARN_MCP_TOKEN`.

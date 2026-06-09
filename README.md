# waterloo-learn-mcp

An MCP (Model Context Protocol) server that gives desktop AI apps (ChatGPT
desktop, Claude Desktop) access to your [Waterloo LEARN](https://learn.uwaterloo.ca)
courses via Playwright.

LEARN is a D2L Brightspace instance behind WatIAM + Duo 2FA, so the server
splits auth from scraping:

1. **`npm run login`** opens a *headed* browser. You sign in manually, approve
   the Duo push, and the session cookies are saved to `auth.json`.
2. The MCP server then runs fully **headless** using that saved session — no
   2FA involved — until the session expires (then just run login again).

`auth.json` contains live session cookies. It is gitignored; treat it like a
password.

## Setup

```sh
npm install
npx playwright install chromium
npm run build
npm run login          # sign in + Duo push, saves auth.json
```

Register the server in the desktop app's MCP config at
`~/Library/Application Support/Claude/claude_desktop_config.json`
(the same format works for the ChatGPT desktop app):

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

Restart the desktop app to pick up the server.

## Tools

| Tool | Args | Returns |
| --- | --- | --- |
| `list_courses` | — | Course names + `ou` (org unit) IDs from the LEARN homepage |
| `get_announcements` | `courseId` | Instructor announcements (title, body, date, attachments) |
| `get_content` | `courseId` | Nested content modules and topics with URLs |
| `get_grades` | `courseId` | Grade items with displayed grade, points, weight, feedback |
| `get_upcoming` | `courseId`, `daysAhead?` | Calendar events / due dates (default next 30 days) |

## How it works

- `list_courses` scrapes the `d2l-my-courses` widget on `/d2l/home`
  (Playwright pierces the shadow DOM), falling back to the
  `myenrollments` API if the widget renders nothing.
- The other tools call D2L's REST API (`/d2l/api/le/...`) through the
  authenticated browser context — Brightspace accepts session cookies on those
  routes, which is far more robust than CSS selectors. `get_grades` falls back
  to scraping the My Grades page if the grades API is restricted.
- If the session has expired, every tool returns a clear error telling you to
  run `npm run login` again.

## Troubleshooting

- **"No valid LEARN session"** — run `npm run login`.
- **Tools suddenly failing after weeks of working** — the session expired;
  run `npm run login`.
- Set `LEARN_BASE_URL` / `LEARN_AUTH_FILE` env vars to override the LEARN URL
  or where the session file lives.

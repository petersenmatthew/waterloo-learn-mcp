# waterloo-learn-mcp

MCP server exposing your [Waterloo LEARN](https://learn.uwaterloo.ca) courses to AI apps. LEARN sits behind WatIAM + Duo, so auth is split out: you log in once in a real browser, the session is saved to `auth.json`, and the server runs headless off that until it expires.

`auth.json`, `oauth.json`, and `.env.local` hold secrets. They are gitignored — treat them like passwords.

## Install

```sh
npm install
npx playwright install chromium
npm run build
npm run login          # browser opens; sign in + approve Duo. Saves auth.json
```

Optional: `npm run login` can autofill your WatIAM username/password before
waiting for Duo. Add both values to `.env.local` or export them in your shell:

```sh
WATIAM_USERNAME=your-watiam-user
WATIAM_PASSWORD=your-watiam-password
```

## Tools

| Tool | Args | Returns |
| --- | --- | --- |
| `list_courses` | — | Course names + `ou` IDs |
| `get_announcements` | `courseId` | Announcements (title, body, date, attachments) |
| `get_content` | `courseId` | Content modules/topics with URLs |
| `get_topic_file` | `courseId`, `topicId`, `pages?` | Lecture PDF/PPTX rendered as one image per slide (cap 75; `pages` like `"4"` or `"2-6"`) |
| `get_grades` | `courseId` | Grade items (grade, points, weight, feedback) |
| `get_assignments` | `courseId` | Assignments with due dates, instructions, your submission status + files, released feedback |
| `get_upcoming` | `courseId`, `daysAhead?` | Due dates / events (default 30 days) |
| `get_course_outline` | `courseId` | Official course outline/syllabus text from the local cache, refreshing from Outline.uwaterloo.ca when missing |

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

## Connect to a web chat with ngrok

ChatGPT and Claude.ai are cloud-hosted, so they need a public HTTPS URL for
this MCP server. The default path is ngrok: the MCP server runs on your laptop,
and ngrok publishes it at a stable HTTPS dev domain.

First, install and sign in to ngrok:

```sh
brew install ngrok/ngrok/ngrok
ngrok config add-authtoken <your-ngrok-authtoken>
```

Get your free dev domain from the [ngrok dashboard](https://dashboard.ngrok.com/domains),
then run the one-time setup:

```sh
npm run setup:ngrok
```

When prompted, paste the domain only, for example `example.ngrok-free.app`.
The script saves it to `.env.local`, starts the local HTTP server, starts ngrok,
and prints your connector URL:

```text
https://<your-ngrok-domain>/mcp
```

Use OAuth. Leave OAuth Client ID and Client Secret blank. When the authorization
page opens, paste the connection code printed by the setup script
(`LEARN_MCP_TOKEN` from `.env.local`).

- **ChatGPT** → Settings → Connectors → **Developer mode** → Add custom connector → Server URL.
- **Claude.ai** → Settings → Connectors → **"+"** → name + URL.

OAuth clients and tokens are saved in `oauth.json` so connectors keep working after server restarts.
Treat `LEARN_MCP_TOKEN` like a password. The legacy URL
`https://<your-ngrok-domain>/mcp/<secret>` still works for clients that cannot
use OAuth.

### After a reboot with ngrok

Your ngrok domain, MCP token, OAuth clients, and LEARN session all persist.
After restarting your computer, run:

```sh
npm run start:ngrok
```

Leave that terminal running while you want ChatGPT or Claude.ai to reach LEARN.

To check the tunnel from another terminal:

```sh
curl -s -H 'ngrok-skip-browser-warning: true' https://<your-ngrok-domain>/health
curl -s -H 'ngrok-skip-browser-warning: true' https://<your-ngrok-domain>/.well-known/oauth-authorization-server
```

Expected:

- `/health` -> `ok`
- OAuth metadata -> JSON with a `registration_endpoint`

ngrok may show a browser warning during OAuth. Click through once. Command-line
checks can skip it with the `ngrok-skip-browser-warning` header shown above.

## Tailscale alternative

Tailscale Funnel also works if you prefer it. It has a nice reboot story because
Funnel persists its tunnel config; only the local HTTP server needs to be
running.

```sh
npm run setup:tailscale
npm run start:http
npm run autostart:http  # optional: start HTTP server on login
npm run stop:http       # stop HTTP autostart and free port 8787
```

Use this connector URL:

```text
https://<device>.ts.net/mcp
```

After a reboot with Tailscale:

- **Ran `autostart:http`** -> nothing to do; it restarts itself on login.
- **Didn't** -> `npm run start:http` to bring the server back.

If Claude/ChatGPT cannot fetch OAuth config or cannot connect to
`<device>.ts.net:443`, reset Tailscale Serve/Funnel:

```sh
tailscale funnel reset
tailscale serve reset
tailscale funnel --bg 8787
```

## Notes

- `list_courses` uses the enrollments API, falling back to homepage scraping. Other tools call D2L's REST API through the authenticated session.
- `get_course_outline` reads `cache/outlines/` first. Cached outlines are checked against the published revision date and automatically refetched when the instructor publishes a new revision. If a course is not cached, it checks Outline.uwaterloo.ca's enrolled-course viewer, then falls back to outline links posted in LEARN content. If neither exists, look for an uploaded outline/syllabus PDF in `get_content`.
- `get_topic_file` returns slides as **images** so the model can read diagrams, not just text. PDFs need nothing extra; PowerPoint topics additionally need [LibreOffice](https://www.libreoffice.org) (`brew install --cask libreoffice`) for the PPTX→PDF step. Works in Claude (Desktop + Claude.ai) and ChatGPT.
- **"No valid LEARN session"** (or tools failing after weeks) = session expired → `npm run login` again. Independent of reboots.
- Override with env vars: `LEARN_BASE_URL`, `LEARN_AUTH_FILE`, `LEARN_OUTLINE_CACHE_DIR`, `PORT`, `LEARN_MCP_TOKEN`, `WATIAM_USERNAME`, `WATIAM_PASSWORD`, `WATIAM_LOGIN_DOMAIN`.

---

## Disclaimer

This is an **unofficial, independent tool** built for personal academic use. It is **not affiliated with, endorsed by, or supported by** the University of Waterloo, D2L, or any related entity. "Waterloo LEARN" and related marks belong to their respective owners.

The server acts on your behalf using **your own credentials** to access **only your own** course data — it accesses nothing you couldn't already see by logging into LEARN yourself. You are responsible for using it in accordance with the University of Waterloo's acceptable-use policies and LEARN's terms of service. Don't use it to access data that isn't yours, and don't share course content in ways that violate copyright or your instructors' wishes.

LEARN's internal APIs and page structure can change without notice, which may break this tool at any time. It is provided **as-is, without warranty of any kind**. AI models can also misread or hallucinate content — **always verify grades, due dates, and other important information against LEARN directly.** Use at your own risk.

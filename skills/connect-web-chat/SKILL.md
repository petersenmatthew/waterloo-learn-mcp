---
name: connect-web-chat
description: Connect the waterloo-learn MCP server to a web chat app (ChatGPT or Claude.ai) via Tailscale Funnel. Use when the user wants to register, install, or wire this MCP server into ChatGPT or Claude.ai, or asks why LEARN tools don't show up there. For the local Claude Desktop app, use connect-claude-desktop instead.
---

# Connect waterloo-learn to a web chat (ChatGPT or Claude.ai)

ChatGPT and Claude.ai are **cloud-hosted** chat apps. They reach your MCP
server **remotely over HTTPS** from the vendor's servers — they can't run a
local stdio server and don't read a config file. So this server has to be
exposed at a public HTTPS URL and added as a **custom connector** in each app's
UI.

> This is the remote path. The **Claude Desktop** app is different — it runs the
> server locally from a config file with no tunnel. For that, use the
> `connect-claude-desktop` skill instead.

The **same URL works for both ChatGPT and Claude.ai** — set up the tunnel once,
then add the URL in whichever app(s) you use.

We use **Tailscale Funnel** for the URL because it's free, needs **no VPS and no
reserved domain**, and gives a **stable** public address
(`https://<device>.<tailnet>.ts.net`) that survives reboots. The MCP server runs
on the user's own laptop; Tailscale's infrastructure provides the public edge.

## Auth: OAuth for web apps, path secret as a legacy fallback

Web chat apps increasingly expect remote MCP servers to support OAuth discovery,
dynamic client registration, and bearer tokens. This server implements a small
personal OAuth flow at the public Funnel origin:

- MCP endpoint: `https://<device>.ts.net/mcp`
- Protected resource metadata: `/.well-known/oauth-protected-resource/mcp`
- Authorization server metadata: `/.well-known/oauth-authorization-server`
- Dynamic registration: `/register`
- Browser authorization: `/authorize`
- Token exchange: `/token`

During browser authorization, the page asks for the connection code from
`.env.local` (`LEARN_MCP_TOKEN`). That keeps dynamic registration from becoming
an open public authorization endpoint.

The old URL style `https://<device>.ts.net/mcp/<token>` still works as a legacy
fallback for clients that cannot do OAuth, and the server also accepts
`Authorization: Bearer <token>` or `X-Api-Key: <token>` on `/mcp`.

> ⚠️ **Treat the connection code like a password.** Anyone who has it can
> authorize access to the user's LEARN data. Don't paste it into shared chats or
> commit it. The secret lives in `.env.local` (gitignored).

> ℹ️ **The laptop must be on.** The chat app can only reach LEARN while the
> user's machine is awake and the server + Funnel are running. Inherent to the
> server living on the user's laptop while the chat app is remote.

## The easy path — one command

```sh
cd <project-root>
npm install
npm run setup:tailscale
```

`scripts/tailscale-setup.sh` does everything: generates the secret, builds, runs the
LEARN login if needed (manual Duo), brings Tailscale up, enables Funnel, then
prints your public Funnel origin plus the connection code, and starts the
server.

### Add the connector — ChatGPT (one time, UI — can't be scripted)

1. **Settings → Connectors → Advanced → turn on Developer mode.**
2. **Add custom connector** → **Connection: Server URL** → paste the URL the
   script printed, using the OAuth MCP path (`https://<device>.ts.net/mcp`).
3. Choose OAuth if prompted. Leave manual Client ID/Secret blank so the app can
   use dynamic registration.
4. When the authorization page opens, paste `LEARN_MCP_TOKEN` from `.env.local`.
5. Check **"I understand and want to continue"** → **Create**.
6. Enable **waterloo-learn** from the tools menu in a chat and ask e.g.
   *"What courses am I taking on LEARN?"*

### Add the connector — Claude.ai (one time, UI — no Developer mode needed)

1. **Settings → Connectors** (also labelled **Customize → Connectors**).
2. Click **"+"** / **Add custom connector**.
3. Enter a **name** (`waterloo-learn`) and paste the OAuth MCP URL
   (`https://<device>.ts.net/mcp`).
4. Leave **Advanced settings** (OAuth Client ID/Secret) **blank** so Claude.ai
   can use dynamic registration. Click **Add**.
5. When the authorization page opens, paste `LEARN_MCP_TOKEN` from `.env.local`.
6. Enable **waterloo-learn** in a chat and ask e.g.
   *"What courses am I taking on LEARN?"*

> Claude.ai's free plan allows **one** custom connector. ChatGPT and Claude.ai
> are separate products, so adding the same URL to both is fine.

### Keep it running across reboots (optional)

```sh
npm run autostart:http
```

Installs a LaunchAgent so the server auto-starts on login and stays alive.
Tailscale Funnel already persists its own config, so this is the only extra
piece for a hands-off setup.

## First-time Tailscale requirements

1. Install it — `brew install tailscale` or https://tailscale.com/download
   (the macOS App Store app works too). No VPS to run.
2. The script runs `tailscale up`; sign in with any provider (free).
3. **Enable Funnel for the tailnet** — a one-time toggle in the Tailscale admin
   console (enable HTTPS + the Funnel node attribute). If it isn't enabled,
   `tailscale funnel` fails and prints a link to enable it; the setup script
   surfaces that link and tells you to re-run.

## Verify before touching the chat app

```sh
curl -s https://<device>.ts.net/health                       # → ok
curl -i -s -X POST https://<device>.ts.net/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"debug","version":"0"}}}' | grep -i 'www-authenticate'
curl -s https://<device>.ts.net/.well-known/oauth-authorization-server | grep registration_endpoint
curl -s -X POST https://<device>.ts.net/mcp/<token> \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | grep -o '"name":"[a-z_]*"'
```

The unauthenticated `/mcp` check should return a `WWW-Authenticate` header with
OAuth protected-resource metadata. The legacy secret-path `tools/list` check
should return the tool names.

## Troubleshooting

- **`tailscale funnel` fails** — Funnel/HTTPS isn't enabled for the tailnet;
  open the link Tailscale prints, enable it, re-run `npm run setup:tailscale`.
- **App can't connect / 401** — confirm `/health` returns `ok` from outside,
  and that `/.well-known/oauth-authorization-server` returns JSON with
  `registration_endpoint`.
- **Claude.ai says it couldn't register with the sign-in service** — make sure
  the connector URL is `https://<device>.ts.net/mcp` and that manual OAuth
  Client ID/Secret fields are blank. That lets Claude.ai use dynamic client
  registration.
- **Claude.ai: "you've reached your connector limit"** — the free plan allows
  one custom connector; remove an existing one or upgrade.
- **Tools return "No valid LEARN session"** — run `npm run login` again.
- **Want it hands-off after reboot** — `npm run autostart:http`.

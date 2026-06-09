---
name: connect-chatgpt
description: Connect the waterloo-learn MCP server to ChatGPT via Tailscale Funnel. Use when the user wants to register, install, or wire this MCP server into ChatGPT, or asks why LEARN tools don't show up in ChatGPT.
---

# Connect waterloo-learn to ChatGPT

ChatGPT only talks to **remote MCP servers over HTTPS** — it can't run a local
stdio server and doesn't read a config file. So this server has to be exposed at
a public HTTPS URL and added as a custom connector in ChatGPT's Developer mode.

We use **Tailscale Funnel** for the URL because it's free, needs **no VPS and no
reserved domain**, and gives a **stable** public address
(`https://<device>.<tailnet>.ts.net`) that survives reboots. The MCP server runs
on the user's own laptop; Tailscale's infrastructure provides the public edge.

## Auth: secret-in-URL, because ChatGPT has no API-key option

ChatGPT's custom-connector **Authentication** dropdown offers only **OAuth**,
**No Auth**, and **Mixed** — there is **no API-key / bearer field**. Implementing
OAuth is heavy overkill for a personal tool, and plain "No Auth" on a public URL
would expose the user's LEARN session to anyone who finds it.

So the token rides in the **URL path** instead: the connector URL is
`https://<device>.ts.net/mcp/<token>` and ChatGPT is set to **No Auth**. The
server only responds when the path contains the correct secret, so the full URL
*is* the credential — token-equivalent security with zero OAuth complexity.

> ⚠️ **Treat the full URL like a password.** Anyone who has it can read that
> user's LEARN data. Don't paste it into shared chats or commit it. The secret
> lives in `.env.local` (gitignored).

> ℹ️ **The laptop must be on.** ChatGPT can only reach LEARN while the user's
> machine is awake and the server + Funnel are running. Inherent to ChatGPT
> being remote.

## The easy path — one command

```sh
cd <project-root>
npm install
npm run setup:chatgpt
```

`scripts/chatgpt-setup.sh` does everything: generates the secret, builds, runs
the LEARN login if needed (manual Duo), brings Tailscale up, enables Funnel, then
prints your **connector URL** (with the secret in the path) and starts the
server.

Then, one time in ChatGPT (UI — can't be scripted):

1. **Settings → Connectors → Advanced → turn on Developer mode.**
2. **Add custom connector** → **Connection: Server URL** → paste the URL the
   script printed (`https://<device>.ts.net/mcp/<token>`).
3. **Authentication: No Auth.**
4. Check **"I understand and want to continue"** → **Create**.
5. Enable **waterloo-learn** from the tools menu in a chat and ask e.g.
   *"What courses am I taking on LEARN?"*

### Keep it running across reboots (optional)

```sh
npm run autostart:chatgpt
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

## Verify before touching ChatGPT

```sh
curl -s https://<device>.ts.net/health                       # → ok
curl -s -X POST https://<device>.ts.net/mcp/<token> \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | grep -o '"name":"[a-z_]*"'
```

Five tool names = good. Note there's **no auth header** — the secret is the path
segment. (The server also accepts `Authorization: Bearer <token>` or
`X-Api-Key: <token>` on the plain `/mcp` path for non-ChatGPT clients.)

## Troubleshooting

- **`tailscale funnel` fails** — Funnel/HTTPS isn't enabled for the tailnet;
  open the link Tailscale prints, enable it, re-run `npm run setup:chatgpt`.
- **ChatGPT can't connect / 401** — wrong or missing secret in the path, or the
  server isn't running / laptop asleep. Confirm `/health` returns `ok` from
  outside, and that the connector URL ends in `/mcp/<the-exact-token>`.
- **Don't pick OAuth** in ChatGPT — this server doesn't implement it; the connect
  will hang on OAuth discovery. Use **No Auth**.
- **Tools return "No valid LEARN session"** — run `npm run login` again.
- **Want it hands-off after reboot** — `npm run autostart:chatgpt`.

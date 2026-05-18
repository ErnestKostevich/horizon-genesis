# Horizon — server deployment guide

This doc walks through running Horizon on a Linux VPS (Ubuntu/Debian) so
it's reachable like Hermes Agent's server mode: a mobile PWA, a cron
job, or your laptop can drive the same agent over HTTP+SSE.

For local dev / single-machine use you don't need any of this — just
run `node bin/horizon.js` or `npm run cli` from the repo root. This is
for the "running on a real server" path.

## Prerequisites

- Linux server with sudo access (Ubuntu 22.04+, Debian 12+, similar)
- A domain name (optional, but recommended — `horizon.example.com`)
- Node 22 LTS
- Optional but recommended: Docker (for the isolated executor backend)

## 1. Install Node 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential
node --version  # → v22.x.x
```

## 2. Clone + install

```bash
sudo useradd -m -s /bin/bash horizon
sudo su - horizon
git clone https://github.com/ErnestKostevich/horizon-genesis ~/horizon
cd ~/horizon
git checkout main   # or claude/cli-tui-serve before it's merged
npm ci --omit=dev   # ~30s
```

`--omit=dev` skips Electron and electron-builder (~500 MB) — the CLI
doesn't need them. Total install footprint after this is ~200 MB.

## 3. Provision keys + settings

You have two ways to put API keys on the server:

### Option A — copy from your local machine

The CLI on your laptop uses the same `horizon-keys.json` the GUI does.
Copy that one file (encrypted on disk; decryption is host-bound so this
**won't** work unless we also bypass the encryption key step — see
Option B). Use Option B for new servers.

### Option B — `horizon connect` directly on the server

```bash
node bin/horizon.js connect telegram --token 123456:ABC...   # if you want Telegram
node bin/horizon.js connect discord  --token <bot-token>     # Discord
node bin/horizon.js connect slack    --token xoxb-...
node bin/horizon.js connect notion   --token secret_...
```

To set provider keys (Claude / OpenAI / Gemini etc.), the easiest path
is to write them via Node REPL:

```bash
node -e "
const { initStores } = require('./src/main/runtime/store-shim');
const { keysStore } = initStores();
keysStore.set('k_gemini', 'AIza...');
keysStore.set('k_claude', 'sk-ant-...');
console.log('ok, wrote', keysStore.path);
"
```

Then pick the active provider:

```bash
node bin/horizon.js model gemini --model gemini-2.5-flash
node bin/horizon.js version    # verify
```

## 4. Pick an auth token

`horizon serve` requires a bearer token. Pick a strong one and store it
in an env file:

```bash
sudo mkdir -p /etc/horizon
sudo tee /etc/horizon/env >/dev/null <<EOF
HORIZON_TOKEN=$(openssl rand -hex 32)
HORIZON_PORT=18789
HORIZON_HOST=127.0.0.1
EOF
sudo chmod 640 /etc/horizon/env
sudo chown root:horizon /etc/horizon/env
```

Bind to `127.0.0.1` and front with nginx + TLS (next step). Binding
straight to `0.0.0.0` is fine for testing but exposes the API over
plaintext HTTP, which is fine ONLY when you fully trust the network.

## 5. systemd unit

```bash
sudo tee /etc/systemd/system/horizon.service >/dev/null <<'EOF'
[Unit]
Description=Horizon AI headless agent
After=network.target

[Service]
Type=simple
User=horizon
WorkingDirectory=/home/horizon/horizon
EnvironmentFile=/etc/horizon/env
ExecStart=/usr/bin/node bin/horizon-serve.js
Restart=on-failure
RestartSec=5

# Tighten the sandbox (allow Docker if you use the docker executor mode)
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/horizon/.config/horizon-ai
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now horizon
sudo systemctl status horizon
```

Logs:

```bash
sudo journalctl -u horizon -f
```

## 6. nginx + Let's Encrypt (TLS)

```bash
sudo apt-get install -y nginx python3-certbot-nginx

sudo tee /etc/nginx/sites-available/horizon >/dev/null <<'EOF'
server {
    listen 80;
    server_name horizon.example.com;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # SSE needs these — disable proxy buffering and read timeouts
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        # WebSocket upgrade headers (future-proofing)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF
sudo ln -s /etc/nginx/sites-available/horizon /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d horizon.example.com
```

Now `https://horizon.example.com/api/health` should answer with `{ok:true,ts:...}`.

## 7. Firewall

```bash
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Block direct access to 18789 — only nginx (loopback) talks to it.

## 8. Verify

```bash
TOKEN=$(grep HORIZON_TOKEN /etc/horizon/env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" https://horizon.example.com/api/health
curl -s -H "Authorization: Bearer $TOKEN" https://horizon.example.com/api/version | jq

curl -sN -H "Authorization: Bearer $TOKEN" \
        -H "Accept: text/event-stream" \
        -H "Content-Type: application/json" \
        -d '{"task":"скажи привет одним словом","provider":"gemini"}' \
        https://horizon.example.com/api/agent
```

## 9. Mobile / PWA client

Until the official Horizon PWA ships (`mobile/` folder, Phase 6 in
`docs/cli-plan.md`), any HTTP client with bearer support works. Make a
quick page:

```html
<!doctype html>
<button onclick="run()">run agent</button>
<pre id="out"></pre>
<script>
const TOKEN = prompt('paste bearer token');
async function run() {
  const r = await fetch('https://horizon.example.com/api/agent', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + TOKEN,
      'Accept': 'text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ task: 'summarise my unread emails', provider: 'gemini' }),
  });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      document.getElementById('out').textContent += chunk + '\n---\n';
    }
  }
}
</script>
```

## 10. Live messaging bots

By default the headless server does NOT start the Telegram / Discord
listener loops. To enable them at boot, edit
`/etc/systemd/system/horizon.service` and change:

```
ExecStart=/usr/bin/node bin/horizon-serve.js --enable-tg --enable-discord
```

then `sudo systemctl daemon-reload && sudo systemctl restart horizon`.

The bots will run as the `horizon` user and reuse the same provider key
the HTTP API uses.

## 11. Cron-driven agent jobs

```cron
# Every weekday morning, summarise yesterday's git commits
0 9 * * 1-5  HORIZON_FAST=1 /usr/bin/node /home/horizon/horizon/bin/horizon.js \
              agent "summarise commits to main since yesterday; post to #standup" \
              --auto-approve --quiet >>/var/log/horizon-cron.log 2>&1
```

`HORIZON_FAST=1` skips the typing animation in the banner. `--quiet`
suppresses everything except the final answer. `--auto-approve` lets
the agent run shell/file tools without an interactive prompt.

## 12. Updates

When new commits land on `main`:

```bash
sudo su - horizon
cd ~/horizon
git pull
npm ci --omit=dev
exit
sudo systemctl restart horizon
```

## 13. Backup what matters

The "memory" of your Horizon installation is in **two** places:

- `/home/horizon/.config/horizon-ai/horizon_memory.json` — episodic memory, facts, conversations, user profile
- `/home/horizon/.config/horizon-ai/horizon-settings.json` — provider / persona / model preferences
- `/home/horizon/.config/horizon-ai/horizon-keys.json` — encrypted API keys (only useful on this same host — the encryption key is derived from the host's identity)

Daily snapshot:

```bash
sudo cp -r /home/horizon/.config/horizon-ai /var/backups/horizon-$(date +%F)
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/api/health` returns 401 | wrong bearer token | grep HORIZON_TOKEN /etc/horizon/env |
| SSE stalls after first event | nginx buffering | confirm `proxy_buffering off` in the location block |
| Executor returns `docker not found` | docker missing or not in PATH for the systemd user | `sudo apt install docker.io && sudo usermod -aG docker horizon` then re-login |
| `horizon agent` runs but never reflects | `--no-reflect` in the cron line or reflection epilogue disabled | drop `--no-reflect` |
| Memory not updating across runs | running as different user vs the one that owns ~/.config/horizon-ai | check `whoami` matches systemd `User=` |

# Spotify Control — Horizon plugin

Official demo plugin for **Horizon Genesis** by **Ernest Kostevich**.
Reference implementation of third-party OAuth inside a Horizon plugin.

## What it does

Controls the user's own Spotify account from the Horizon agent:

- `play` / `pause` / `next` / `previous`
- `set_volume { percent }`
- `list_devices` / `transfer_playback { device_id }`
- `current_track` / `search { query }`
- `connect` / `disconnect` / `status`

## OAuth model

**Authorization Code + PKCE** — the correct flow for a desktop public client.

- No `client_secret` in the plugin. It cannot be kept secret on a user machine.
- No Basic auth header. "Base64" is just the encoding of `base64(client_id:client_secret)` used
  by the Client Credentials / confidential Authorization Code flows. PKCE uses neither.
- Loopback redirect: `http://127.0.0.1:8765/callback` (auto-falls back to 8766–8770).

### Flow

```
verifier  = random(32) URL-safe
challenge = base64url(sha256(verifier))

open in browser:
  https://accounts.spotify.com/authorize
    ?response_type=code
    &client_id=<CLIENT_ID>
    &scope=user-read-playback-state user-modify-playback-state user-read-currently-playing streaming
    &redirect_uri=http://127.0.0.1:8765/callback
    &state=<nonce>
    &code_challenge=<challenge>
    &code_challenge_method=S256

<-- loopback receives ?code=...&state=...

POST https://accounts.spotify.com/api/token
Content-Type: application/x-www-form-urlencoded
grant_type=authorization_code
&code=<code>
&redirect_uri=http://127.0.0.1:8765/callback
&client_id=<CLIENT_ID>
&code_verifier=<verifier>

--> { access_token, refresh_token, expires_in, scope }
```

### Refresh

Same endpoint. No Basic header.

```
POST https://accounts.spotify.com/api/token
grant_type=refresh_token
&refresh_token=<stored refresh_token>
&client_id=<CLIENT_ID>
```

If the response contains a new `refresh_token`, persist it.

## Storage

Tokens are stored in `electron-store` under `spotify-tokens`, encrypted via
`safeStorage.encryptString` (macOS Keychain / Windows DPAPI / libsecret on Linux).

## Settings

The user pastes their Client ID once. That's it.

> Create a Spotify app at https://developer.spotify.com/dashboard, add
> `http://127.0.0.1:8765/callback` as a redirect URI, copy the Client ID.

## Install (developer)

```bash
cp -r horizon-plugin-spotify ~/.horizon/plugins/spotify-control
# or install via horizon:// share URL inside the Horizon app
```

## Edge cases handled

- 204 → treated as success for idempotent commands.
- 401 → wipe tokens, surface RECONNECT.
- 403 → surface FORBIDDEN (likely Premium-required).
- 404 → NO_ACTIVE_DEVICE (list_devices → transfer_playback → retry).
- 429 → RATE_LIMITED with Retry-After.
- Port collision → try 8765…8770.
- Rotated refresh_token → persisted.
- Linux without libsecret → tokens live for the session only.

## License

MIT © Ernest Kostevich

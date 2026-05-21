# Horizon AI -- Scoop Bucket

This directory contains the canonical Scoop manifest for the Horizon AI
CLI. The actual bucket repo lives at:

> https://github.com/ErnestKostevich/horizon-scoop-bucket

## Layout

```
horizon.json     # the Scoop app manifest
```

## Publishing workflow

The horizon-genesis monorepo is the source of truth. When a new CLI
release is cut:

1. The release workflow uploads `horizon-win-x64.exe` to the
   `cli-v<version>` GitHub release.
2. Run `node dist-tools/update-hashes.js` against the new release tag.
   The script computes SHA256 for the Windows binary and rewrites the
   `hash` + `version` fields in `horizon.json`.
3. Copy `horizon.json` into the `ErnestKostevich/horizon-scoop-bucket`
   repo on the `main` branch and push.

Scoop's built-in `checkver` and `autoupdate` blocks make subsequent
patch releases self-updating -- once the bucket is in place, the
maintainer mostly only has to bump the SHA. (Or, if a release publishes
a `.sha256` sidecar file, `autoupdate.hash.url` resolves it
automatically and even the SHA bump is hands-off.)

## User install

```powershell
# One-time -- add the bucket
scoop bucket add horizon https://github.com/ErnestKostevich/horizon-scoop-bucket

# Install
scoop install horizon

# First-run setup (interactive: pick provider, paste key)
horizon setup
```

## Maintainer notes

- The bin entry `["horizon-win-x64.exe", "horizon"]` is what makes
  `horizon` available as a shim regardless of the underlying file name.
  Don't rename `horizon-win-x64.exe` upstream without updating the
  manifest.
- `checkver` regex `cli-v([\\d.]+)` matches release tags like
  `cli-v0.0.2`. If we ever switch tag conventions, update both this
  regex and `update-hashes.js`.
- `autoupdate.hash.url` points to a sidecar `.sha256` file. If you
  don't publish that, drop the `hash.url` line and `update-hashes.js`
  will keep the manifest current the old-fashioned way.

# restreamer

HLS restreaming daemon for tvheadend hosts, controlled by
[tvh-controller](../tvh_controller). One daemon per tvheadend location
replaces the legacy per-channel `restreamer@<name>.service` units: it
supervises `source → tsreadex → ffmpeg` pipelines producing browser-playable
HLS into `<serveDir>/<name>/` (served by nginx), persists its desired state
locally, and keeps running across controller outages and its own restarts.
The controller only allocates work by pushing desired-state documents.

The repo also contains the **switcher**, a second deployable (`src/switcher/`,
`deploy/switcher.Dockerfile`, `deploy/k8s/`) that splices redundant encodes
into one stable viewer URL — see its own entry point and docs.

License: AGPL-3.0-or-later.

## Configuration

Lookup order: `$RESTREAMER_CONFIG` → `./config.yaml` →
`/etc/restreamer/config.yaml`. Every key is optional (defaults = current
production values); see `config.example.yaml` for the commented version.

| Key | Default | Meaning |
|---|---|---|
| `listen.host` / `listen.port` | `0.0.0.0` / `5580` | HTTP API bind (unauthenticated — LAN/VPN only, see SECURITY note in `deploy/restreamer.service`) |
| `serveDir` | `/media` | HLS output root; each session writes `<serveDir>/<name>/` |
| `stateFile` | `/var/lib/restreamer/desired.json` | atomic persistence of the accepted desired doc |
| `tvhBaseUrl` | `http://127.0.0.1:9981` | local tvheadend; sessions stream `/stream/channel/<uuid>` |
| `defaultWeight` | `100` | tvh subscription weight when a session doesn't set one |
| `ffmpegPath` / `tsreadexPath` | `ffmpeg` / `tsreadex` | child binaries |
| `capabilities` | `[qsv, opencl]` | advertised in `/v1/status`, matched against template `requiredCaps` |
| `logLines` | `500` | per-session stderr ring-buffer size |
| `stallTimeoutSec` | `30` | no ffmpeg `-progress` update for this long ⇒ restart (`stall`) |
| `playlistStallSec` | `null` | playlist PDT lag threshold; `null` = `3 × hls_time + 15` per session |
| `memoryLimitMb` | `2048` | ffmpeg+tsreadex RSS ceiling ⇒ proactive restart (`oom-guard`); `null` = off |
| `stopGraceSec` | `10` | graceful stop: abort source → wait → SIGTERM → SIGKILL +5s |
| `cleanupOnRemove` | `true` | delete `<serveDir>/<name>/` when a session leaves the desired doc |

## HTTP API (wire contract v1)

Canonical schemas: `src/contract/v1.ts` (vendored by tvh-controller). Every
doc/status carries `apiVersion: 1`; unknown versions are rejected. No auth —
LAN-isolated by contract. Errors are uniform `{error, details?}` JSON.

| Endpoint | Purpose |
|---|---|
| `GET /v1/status` | daemon version/uptime, capabilities, templates, `desiredRevision`, per-session `SessionStatus` |
| `GET /v1/desired` | persisted desired doc read-back (404 if never set) |
| `PUT /v1/desired` | **full replacement**; validates every session (schema + dry-run argv build) all-or-nothing; 400 on any failure |
| `POST /v1/sessions/:name/restart` | kill + respawn, backoff reset |
| `GET /v1/sessions/:name/log?lines=N` | stderr ring-buffer tail |
| `GET /v1/healthz` | liveness |

## Development

```sh
pnpm install
pnpm dev          # tsx watch src/main.ts (needs a ./config.yaml)
pnpm build        # tsc -b → dist/
pnpm typecheck
pnpm test         # vitest — hermetic, no QSV hardware or real binaries needed
```

The e2e test (`test/e2e.test.ts`) runs the real supervisor and API against
fake binaries: `fixtures/fake-ffmpeg.mjs` / `fake-tsreadex.mjs` spawned via
`node`, so it also passes on Windows dev machines. The `fixtures/*.sh`
scripts are the POSIX counterparts for Linux CI / manual smoke runs; the
vitest suite deliberately uses only the `.mjs` ones.

## Installation (Debian package)

CI builds a self-contained amd64 `.deb` of the **daemon only** (the switcher
is not packaged — it ships as a container image via
`deploy/switcher.Dockerfile` / `deploy/k8s/`):

- every tag `vX.Y.Z` → attached to that GitHub release;
- every push to `main` → attached to the rolling `main-latest` prerelease,
  versioned `X.Y.Z~git<run>.<sha>` (sorts below the next real release, so
  tagged debs upgrade over rolling ones).

```sh
sudo dpkg -i restreamer_<version>_amd64.deb
sudo $EDITOR /etc/restreamer/config.yaml
sudo systemctl enable --now restreamer
```

What the deb ships:

- `/usr/lib/restreamer/` — `dist/`, production `node_modules`,
  `package.json`, and a **bundled Node.js runtime** (`runtime/bin/node`) —
  no Node.js, pnpm, or other prerequisites on the host (`ffmpeg` and
  `tsreadex` are *not* bundled; install them separately).
- `/lib/systemd/system/restreamer.service`, running as the `restreamer`
  system user (created on install) with
  `RESTREAMER_CONFIG=/etc/restreamer/config.yaml`.
- `/etc/restreamer/config.yaml` — a dpkg **conffile** seeded from
  `config.example.yaml`: your edits are preserved across upgrades (dpkg
  prompts on conflict). Upgrades restart the service if it was running;
  `apt purge` removes `/var/lib/restreamer` state but never serveDir
  contents.

serveDir (default `/media`) must exist and be writable by the `restreamer`
user — grant permissions, or override `User=`/`Group=` with
`systemctl edit restreamer` (read the SECURITY note in the unit before
changing the bind address).

GPU access: QSV/OpenCL encoding opens `/dev/dri/renderD*`. postinst adds the
`restreamer` user to the `render` (and `video`) groups automatically; if
ffmpeg logs `Device creation failed` / `No device available for decoder`
(AVERROR_EXTERNAL at QSV init), check `id restreamer` includes `render`, or —
if you overrode `User=` — add `SupplementaryGroups=render video` via
`systemctl edit restreamer` and restart.

To build the deb yourself on Linux:
`pnpm install --frozen-lockfile && bash scripts/build-deb.sh` →
`out/restreamer_<version>_amd64.deb`.

## Deployment (systemd, manual)

1. Install Node.js ≥ 22 on the host (`/usr/bin/node`).
2. Build and copy to `/opt/restreamer`: `package.json`, `dist/`, and
   production `node_modules` (`pnpm install --prod`).
3. Create `/etc/restreamer/config.yaml` from `config.example.yaml`.
4. Install `deploy/restreamer.service` to
   `/etc/systemd/system/restreamer.service`, edit `User`/`Group`, and read
   its SECURITY comment before choosing the bind address.
5. `systemctl daemon-reload && systemctl enable --now restreamer`

## Switcher deployment (Kubernetes)

CI publishes the switcher container image to GHCR as
`ghcr.io/<owner>/restreamer-switcher` (built from
`deploy/switcher.Dockerfile`, pushed only after the shared test suite and an
on-runner `/v1/healthz` smoke test pass; linux/amd64 only for now):

| ref | image tags |
|---|---|
| tag `vX.Y.Z` | `:X.Y.Z`, `:latest` |
| push to `main` | `:main`, `:main-<shortsha>` |
| `workflow_dispatch` on a non-main ref | `:dev-<shortsha>` |

Deploy runbook:

1. Edit `deploy/k8s/switcher.yaml`: the Deployment `image:` (your GHCR owner
   + a released version), the Ingress `host:` (must equal this switcher's
   `publicUrl` in tvh-controller's `restreamer.switchers` block), and the
   ConfigMap if you need non-default config. If the GHCR package stays
   private (the default), add the `imagePullSecrets` — see the comment in
   the manifest.
2. `kubectl apply -f deploy/k8s/switcher.yaml`
3. Verify: `kubectl port-forward svc/restreamer-switcher 8080:80`, then
   `curl -fsS http://127.0.0.1:8080/v1/healthz`.
4. Point tvh-controller at it: a `restreamer.switchers` entry whose `url` is
   the in-cluster Service URL (`http://restreamer-switcher.<namespace>.svc`)
   and whose `publicUrl` is the Ingress host. The controller pushes the
   desired doc from there; only `/hls` may be exposed publicly (the `/v1`
   API is unauthenticated by contract — see the manifest's SECURITY note).

## Migration from the per-channel systemd units

Viewer URLs never change: a session named `<name>` writes to the same
`<serveDir>/<name>/` the legacy `restreamer@<name>` unit used. The daemon
starts with an empty desired doc, so installing it is a no-op until sessions
are pushed. Per host, per channel:

1. Install and start the daemon (above). `GET /v1/status` must answer with
   `sessions: []`.
2. Stop the legacy unit for one channel:
   `systemctl disable --now restreamer@<name>`.
3. PUT the equivalent session (tvh-controller does this once integrated;
   until then, by hand — this is the same final contract format). Example for
   the legacy `at-x` unit (`MODE=ivtc`, `PID=333`):

   ```sh
   curl -sS -X PUT http://<host>:5580/v1/desired \
     -H 'content-type: application/json' --data @- <<'EOF'
   {
     "apiVersion": 1,
     "revision": "manual-1",
     "sessions": [
       {
         "name": "at-x",
         "source": { "channelUuid": "<AT-X channel uuid from tvheadend>" },
         "tsreadex": { "programNumber": 333 },
         "pipeline": {
           "template": "arib-hls",
           "templateVersion": 1,
           "video": { "mode": "ivtc" },
           "audio": [ {}, {} ]
         }
       }
     ]
   }
   EOF
   ```

   Note: `PUT /v1/desired` is a **full replacement** — when migrating the
   second channel on a host, PUT a doc containing *all* of that host's
   sessions, not just the new one.
4. Verify before moving on:
   - `GET /v1/status` shows the session `running`, with `progress` updating
     and low `playlistLagSec`;
   - `<serveDir>/<name>/thumb.jpg` mtime is advancing;
   - `<serveDir>/<name>/health` is fresh (rewritten every 5 s while running);
   - playback of `<serveDir>/<name>/playlist.m3u8` works.
   The ffmpeg HLS muxer runs with `append_list+discont_start`, so the
   cutover (and any later daemon restart) appears to players as a playlist
   discontinuity — a glitch, not an outage.
5. Repeat per channel; when the host is empty, remove the old
   `restreamer@.service`, `restreamer.sh`, and profile.d config.

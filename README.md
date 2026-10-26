# Aviator Tracker

An installable Progressive Web App (PWA) that runs on **Android, iPhone/iPad, Windows, macOS, Linux and ChromeOS** from one codebase, backed by a small Node.js + PostgreSQL server for **Google sign-in**, **one-phone-per-account**, **$10/month subscriptions through Paynow** and **tracker sync**.

Log when a target multiplier appears, tap **Calculate** for a next round prediction, and the app scores every prediction so you can see its real accuracy over time.

---

## 1. Run it locally (Docker)

The app ships as a Docker container; `docker-compose.yml` runs it with its own PostgreSQL.

1. Copy `.env.example` to `.env` and fill in `POSTGRES_PASSWORD`, `SESSION_SECRET`, `GOOGLE_CLIENT_ID` and the Paynow values (see section 3).
2. Start everything:

   ```bash
   docker compose up --build -d      # app on http://localhost:5173, Postgres on localhost:5433
   docker compose logs -f app        # follow the server log
   docker compose down               # stop (data stays in the pgdata volume)
   ```

3. Open **http://localhost:5173**. Migrations run automatically on start.

For quick front-end edits without rebuilding, keep the `db` container running and start the app on the host with `npm install && npm run dev` (Node 20.12+); `.env`'s `DATABASE_URL` already points at `localhost:5433`.

Google sign-in only works on origins listed in the Cloud Console, so use `localhost` on the computer. To test on a phone, or to receive Paynow's webhook, use an HTTPS tunnel (ngrok or Cloudflare Tunnel) and add the tunnel URL to `PUBLIC_BASE_URL` and the Google origins.

### Tests

```bash
docker compose exec db createdb -U aviator aviator_test     # once
TEST_DATABASE_URL="postgres://aviator:<POSTGRES_PASSWORD>@localhost:5433/aviator_test?sslmode=disable" npm test
```

The test database is **wiped on every run**. Google and Paynow are stubbed; the tests cover sign-in, the one-device rule, copied cookies, phone moves, admin reset, every payment flow, webhook/poll double delivery, tampered hashes, amount mismatches, early-renewal stacking, rate limits, background jobs and tracker sync.

---

## 2. Project structure

```
aviator-tracker/
├── public/                    ← the PWA (served by the Node server)
│   ├── index.html             app shell, splash, sign-in gate, dialogs
│   ├── sw.js                  service worker: offline + updates (never caches /api or Google)
│   ├── css/styles.css         all styling (Aviator-inspired dark theme)
│   └── js/
│       ├── main.js            entry point: wiring, gating, banner, service worker
│       ├── math.js            Aviator logic: probabilities, colour tiers
│       ├── trackers.js        tracker state + actions (hit, round, calculate…)
│       ├── render.js          builds the tracker cards
│       ├── format.js          number/time formatting, toast messages
│       ├── store.js           local copy in localStorage (offline cache)
│       ├── sync.js            server sync for subscribers
│       ├── install.js         install button for every OS/browser
│       ├── device.js          non-extractable device key in IndexedDB
│       ├── api.js             fetch wrapper; signs every request with the device key
│       ├── session.js         Google sign-in, refusal screen, phone move, silent resume
│       └── subscribe.js       subscription screen and payment states
├── server/
│   ├── app.js                 Express: helmet/CSP, static files, /api, errors
│   ├── config.js              environment variables
│   ├── db.js                  pg pool, transactions, migration runner
│   ├── migrations/            SQL migrations (001_init.sql = full schema + Monthly plan)
│   ├── auth.js                sessions, device-key checks, Google token verification
│   ├── paynow.js              hashing, signed requests, status mapping, crediting
│   ├── jobs.js                payment polling, expiry, renewal reminders (node-cron)
│   └── routes/                account.js, payments.js, trackers.js
├── scripts/reset-device.js    owner tool: release an account's phone
├── test/api.test.js           end-to-end API tests
├── server.js                  entry point (loads .env, migrates, starts jobs + server)
├── Dockerfile                 production image (Node 22 Alpine, non-root)
├── docker-compose.yml         local stack: app + PostgreSQL
├── deploy/                    VPS: production compose, .env template, Caddy/Nginx configs
├── .github/workflows/deploy.yml  CI: test → build → push to GHCR → optional SSH deploy
├── render.yaml                Render blueprint (Docker web service + Postgres)
└── .env.example
```

---

## 3. Setup and deployment

### Google sign-in

1. At <https://console.cloud.google.com> create a project.
2. **OAuth consent screen**: app name, support email, logo, public privacy policy URL; scopes `openid`, `email`, `profile` only. Add test users while in *Testing*; switch to **In production** before launch.
3. **Credentials → OAuth client ID → Web application**. Authorized JavaScript origins: `http://localhost:5173` and your production `https://` domain. Put the Client ID in `GOOGLE_CLIENT_ID`.

### Paynow

Set `PAYNOW_INTEGRATION_ID`, `PAYNOW_INTEGRATION_KEY`, `PAYNOW_MODE=test` and `PAYNOW_TEST_AUTHEMAIL` (the merchant login email). In test mode use Paynow's EcoCash test numbers from the mobile money docs, and "TESTING: Faked Success" for redirect payments. `/api/paynow/result` must be reachable over public HTTPS. Polling credits payments even if the webhook never arrives.

Visa/Mastercard shows as *Coming soon* until you set `PAYNOW_CARDS_ENABLED=true` (after merchant verification).

### Hosting: Vultr VPS via GitHub Container Registry

Every push to `main` runs the tests, builds the Docker image and pushes it to **`ghcr.io/<owner>/<repo>`** (`.github/workflows/deploy.yml`). Tags: `latest`, `sha-<commit>`, and `vX.Y.Z` for git tags like `v2.0.1`. The app runs next to the VPS's existing app: it listens on `127.0.0.1:5173` only, its Postgres is not published, and the existing reverse proxy serves it on 443.

**One-time setup on the VPS (139.84.239.203)**

1. Copy the `deploy/` folder to `/opt/aviator-tracker` (`docker-compose.yml`, `.env.production.example`).
2. `cp .env.production.example .env` and fill in `APP_IMAGE` (lowercase owner/repo), `POSTGRES_PASSWORD`, `SESSION_SECRET` and `PAYNOW_INTEGRATION_KEY`. `chmod 600 .env`.
3. If the GHCR package is private: create a GitHub token with `read:packages`, then `echo <token> | docker login ghcr.io -u <github-user> --password-stdin`.
4. `docker compose up -d`, then `curl -s 127.0.0.1:5173/api/plans` should list the Monthly plan.
5. Reverse proxy: add `deploy/Caddyfile.example` to the Caddyfile and `sudo systemctl reload caddy`, **or** install `deploy/nginx.conf.example` and run Certbot. If the existing proxy itself runs in Docker, `127.0.0.1` means its own container: put it on the same Docker network and proxy to `app:5173`, or use the host's Docker bridge IP.
6. Google Cloud Console: add `https://aviatorspribe.org` to the OAuth client's Authorized JavaScript origins.

**Updates**: push to `main`. With the repo secrets `VPS_HOST`, `VPS_USER` and `VPS_SSH_KEY` (optional `VPS_PORT`, `VPS_APP_DIR`) set, the workflow SSHes in and runs `docker compose pull app && docker compose up -d`; otherwise run those two commands on the VPS yourself. Roll back by setting `APP_IMAGE` to an older `:sha-…` or `:v…` tag and running `docker compose up -d`.

**Backups**: `docker compose exec db pg_dump -U aviator aviator_tracker | gzip > backup-$(date +%F).sql.gz` (schedule with cron).

`render.yaml` remains as an alternative host. Netlify, Vercel and GitHub Pages only serve static files and can't host this app.

### Logo

`public/img/logo.png` and `public/icons/*` come from a **temporary** logo for local testing only. The wordmark is misspelt ("Aiator") and the red plane resembles Spribe's Aviator artwork. Replace it before going live: regenerate the icons from the new artwork (512 px icons use the full logo; 192 px and smaller use the mark without text; maskable icons keep the art inside the central 80%).

### Owner tools

Release a locked account's phone (genuine lost/changed phone after the 30-day move limit):

```bash
npm run reset-device -- someone@gmail.com
```

or, signed in as an address listed in `ADMIN_EMAILS`: `POST /api/admin/users/<email or id>/reset-device`.

### Defaults chosen for the open questions

| Question | Current default | Where to change |
|---|---|---|
| Free vs paid features | **Calculate** (predictions) and server sync need a subscription; adding trackers, logging hits/rounds, undo, delete and the scoreboard stay free | `PAID_ACTIONS` in `public/js/main.js` |
| Tracker sync | Synced to the server for subscribers; local-only otherwise. Existing local data is uploaded on the first synced sign-in | `public/js/sync.js` |
| Paynow fees | Absorbed (tiles show *Free*) | `FEE_LABEL` |
| Product name / domain | Unchanged (*Aviator Tracker*) | manifest, `index.html` |

## 4. Installing on each platform

| Platform | Browser | How |
|---|---|---|
| Android | Chrome, Edge, Samsung Internet, Opera | Tap **Install app** in the top bar (or the browser's install banner) |
| Android | Firefox | Menu ⋮ → **Install** |
| iPhone / iPad | Safari (also Chrome/Edge on iOS 16.4+) | Tap **Install app** for steps: Share → **Add to Home Screen** |
| Windows / Linux / ChromeOS | Chrome, Edge | Tap **Install app**, or the install icon in the address bar |
| macOS | Chrome, Edge | Tap **Install app** |
| macOS | Safari 17+ | **File → Add to Dock** (the button shows this) |
| Desktop | Firefox | Not supported by Firefox; the app still works in the tab |

Once installed, it opens in its own window with the splash screen and works offline for the tracker. On iPhone/iPad, Safari and the installed app count as two different phones, so the app asks people to install first and sign in from the home-screen icon.

---

## 5. Releasing updates

1. Edit your files. Database changes go in a new `server/migrations/NNN_name.sql`.
2. Open `public/sw.js` and bump `VERSION` (e.g. `v2.0.0` → `v2.0.1`).
3. Deploy again.

Installed copies show an **Update available → Reload** message the next time they open online.

---

## 6. How the maths works

Each round reaches multiplier *x* with probability ≈ **0.97 ÷ x** (`js/math.js`), independent of every previous round.

- **Chance per round**: 0.97 ÷ x
- **Chance within n rounds**: 1 − (1 − p)ⁿ
- **Median gap**: rounds within which half of all gaps fall

The **Next round prediction** repeats the gap between your last two hits. When the next hit is logged, the prediction is scored as a hit if it lands within ±20% of that gap (by rounds if you counted them, otherwise by time). The accuracy score on each card is the honest record of how well that works.

Multiplier colours match the game's round history: **blue** below 2x, **purple** 2x–9.99x, **pink** 10x and above.

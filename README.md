# 💰 Parts Price Puller

Self-hosted wholesale price matrix for SOS Phone Repairs, at
**[pricing.thvjq.com.au](https://pricing.thvjq.com.au)**.

Pulls **logged-in wholesale prices** from [CrazyParts](https://crazyparts.com.au) into a
matrix — iPhone 6→16, Samsung S8→S25 + A-series, across 10 part types (LCD/OLED by grade,
refurb, SP, batteries, cameras, charging port, back glass) — then shows each store its own
**retail** price from per-part, per-device-family rules.

No Google, no Apps Script, no sheet. Everything runs on your own box.

---

## How it fits together

| Piece | What it does | Runs on |
|---|---|---|
| `web/` | The site: matrix, store selector, calculator editor, JSON API, login | Docker (Willard / TrueNAS) |
| `scraper/` | Headless Playwright — the unattended weekly pull | Docker, same stack |
| `tampermonkey/` | On-demand pulls + 📌 Setup Mode pinning, using **your** logged-in browser session | Tampermonkey |
| `config/*.yml` | Devices, parts, grades, schedule, store seeds — **edited in git, live on the site** | GitHub |
| `data/prices.db` | Prices, pins, per-store calculators — **never in git** | Docker volume |

That split is the whole design:

- **git owns the shape** — which devices are rows, which parts are columns, what gets searched.
- **the volume owns the numbers** — every price, pin and calculator edit.

So `git pull` can never overwrite live pricing, and a store's markup can never be
clobbered by a deploy.

---

## Live config editing

Same deploy pattern as **thvjq.com.au**: the container fetches and hard-resets the
checkout, and a GitHub push webhook makes it instant.

Edit `config/devices.yml` (or `parts.yml`, `settings.yml`, `stores.yml`) **on GitHub**,
commit, and the running site picks it up — within seconds via the webhook, or within
`GIT_SYNC_INTERVAL` (default 120s) on the fallback poll if you skip it.

**Webhook setup** — repo → Settings → Webhooks → Add webhook:

| Field | Value |
|---|---|
| Payload URL | `https://pricing.thvjq.com.au/hooks/pricing` |
| Content type | `application/json` |
| Secret | the same string as `WEBHOOK_SECRET` |
| Events | just the push event |

GitHub pings it immediately — expect a green ✔ with `pong`. Unlike thvjq.com.au this
needs **no second hostname**: the app serves its own hook on the site's domain, and an
unsigned request is rejected with 401.

- Impatient, or no webhook? **Status → Pull config from git now**.
- Broke the YAML? The site keeps serving the last good copy and shows a red banner with
  the parse error instead of falling over.
- ⚠ The checkout the container watches is a **mirror of `origin/main`** — it hard-resets.
  Don't keep uncommitted edits in it. (Set `GIT_SYNC=0` if you want a frozen config.)

App code changes still need a rebuild: `git pull && docker compose up -d --build`.

---

## Deploy

### TrueNAS SCALE (Willard) — the real deployment

Use [`deploy/truenas-scale.yaml`](deploy/truenas-scale.yaml) — same shape as the
THVjQ-Website app: named volumes, no host paths, no build step (the Custom App installer
can't build), one port behind the tunnel.

1. **Apps → Discover Apps → ⋮ → Install via YAML** → paste the file.
2. Edit every `⚠` line: `SITE_PASSWORD`, `INGEST_KEY` (same value in **both** services),
   `WEBHOOK_SECRET`, and the CrazyParts login.
3. Install. First boot clones this repo into the `ppp_repo` volume by itself — no
   datasets to prepare, nothing to copy up front.
4. **Cloudflare** → point `pricing.thvjq.com.au` at
   `http://<truenas-ip>:8084`.
5. **GitHub webhook** → `https://pricing.thvjq.com.au/hooks/pricing`
   (see [Live config editing](#live-config-editing)).

⚠ Back up the **`ppp_data`** volume — it holds every price, pin and store calculator, and
none of it is recoverable from git.

Updating: config YAML edits are live. For app updates, **Apps → parts-price-puller → ⋮ →
Pull image → Restart** (GitHub Actions rebuilds both images on every push to `main`).

### Any other Docker host

```bash
git clone https://github.com/THVjQ/parts-price-puller.git
cd parts-price-puller
cp .env.example .env && nano .env      # password, ingest key, CP login
docker compose up -d --build
```

Update, forever after:

```bash
git pull && docker compose up -d --build
```

---

## Using the site

**Login** — one shared account: **`SOSPhonerepairs`** / `SITE_PASSWORD` (the username is
matched case-insensitively). It's a deterrent, not real security, so keep the site off
the public internet or put Cloudflare Access in front with `AUTH_MODE=cf-access`.

Your store, grade and view are remembered **on the server**, not in the browser — sign in
on a different device and the site comes back the way you left it.

| Control | What it does |
|---|---|
| **Family rail** (right side) | One tab per device family — iPhone, Samsung S / A / Z, Google Pixel, iPad. Click to switch; the badge is that family's device count |
| **Store** | Applies that store's calculator and reveals the retail figures |
| **Grade** | AMP / BQ7 / SP / … — relabels and re-prices the LCD + OLED columns |
| **Show** | Wholesale · Retail · Both |
| **Filter** | Live device search — jumps to whichever family has the match |
| **Calculator** | This store's per-part, per-family pricing rules — with a live preview |
| **Status** | Config/git health, counts, recent activity, force a config pull |

Each family shows only its own columns. **iPad** is deliberately trimmed to **Digitiser +
LCD** (it's the `parts: [DIGI, LCD]` line on the iPad group in `config/devices.yml`); to
give any family its own column set, add the same `parts:` list to its group.

**Left-click** any cell for its source, matched product title, product link, timestamp,
which rule priced it, what the other supplier quoted, and the change since the last pull.
Cells tint **green** when the price dropped and **red** when it rose; an amber dot means
the cell is pinned; a red bar means the price was entered by hand.

Bookmarkable: `?store=lismore&view=both&grade=AMP&q=iphone%2013` — handy for sending a
store straight to their own retail column. Add `#calc` to open the calculator too.

### Manual prices — right-click → Edit

Right-click a cell, then click **✏ Edit price**. Two deliberate steps, so a price can
never be nudged by a stray click. Type the cost, see the retail figure update live, Save.

A manual price **outranks every supplier price and no pull will ever overwrite it** — the
scraper and the userscript keep writing their own numbers underneath (you can still see
them in the cell popover under "Also"), but the cell shows yours until you right-click →
**↩ Clear manual price**, which drops it back to the live cheapest price.

The same menu is where you **📌 Unpin this cell** (amber dot = pinned). Setup Mode can
re-point a pin but never remove one, and there's no Pins tab any more — this is it. The
last pulled price stays in the cell; it just stops being refreshed.

### The calculator

```
retail = cost × ×%  +  $              …and over the threshold:
retail = cost × then×%  +  then $
```

`×%` carries GST — **110 = cost +10% GST**, 130 = GST plus 20% on the part. `+ $` is the
labour/fitting component. So "cost × 110% + $90, but over $250 it's cost × 110% + $150"
is exactly four boxes.

Rules are set **per part and per device family** — LCD, OLED, Battery, Charging Port …
each priced differently for iPhone vs Samsung A vs Samsung S (add `google` to
`devices.yml` and a Google tab appears on its own). Blank boxes **inherit**, so you set
the base rule once and only override what differs:

```
*|*            base — every part, every device
iphone|*       every iPhone part
*|LCD          LCD everywhere
iphone|LCD     iPhone LCD — wins
```

The greyed number in an empty box is what it's inheriting; type over it to override, clear
it to inherit again. The right-hand column shows what a $60 part would sell for, live.

Seeds come from `config/stores.yml`; the moment you press **Save**, that store's
calculator belongs to the database and git stops touching it — and it follows your login
to any device. **Reset to git defaults** hands it back.

---

## Tampermonkey — pinning and on-demand pulls

**[▶ Install / update userscript](https://raw.githubusercontent.com/THVjQ/parts-price-puller/main/tampermonkey/parts-price-puller.user.js)**
(auto-updates via `@updateURL`).

First run: open CrazyParts logged in → 💰 panel (bottom-left) → **⚙ Settings** → the site
URL (`https://pricing.thvjq.com.au`) and the **ingest key** (`INGEST_KEY`
from `.env`). Both live in Tampermonkey storage, so updates never wipe them.

### Setup Mode — pin exact products

Keyword search picks the wrong listing too often, so each cell is bound to **one exact
product**:

1. 💰 panel → **📌 Setup Mode: OFF** → **ON**.
2. Browse CrazyParts. Every product tile gets a **📌 Pin** button.
3. Click it → pick the **Device** (row) and **Part** (column), then the exact
   product/variant, → **Pin this product**. The price lands in that cell immediately.

**▶ Pull pinned prices** then re-fetches every pin by its stable product/variant **id**
and writes the current price — the same physical item every run, no fuzzy matching.
Unpinned cells are left alone.

The **Grade** dropdown in the panel decides which per-grade column new pins land in
(LCD/OLED only; everything else ignores grade).

### Scheduled pulls

The `scraper` container logs in by itself and re-prices every pin on the schedule in
`config/settings.yml` (default Sunday 12am), which it re-reads every 10 minutes — change
the day/hour in git and the next run follows. Set `PULL_UNPINNED=1` if you also want the
old fuzzy search to fill in cells that have no pin.

Test it now: `RUN_NOW=1` in `.env`, restart, `docker compose logs -f scraper`.

---

## Migrating off the sheet

1. **Export** the old sheet: File → Download → CSV, for the **Prices** and **Pins** tabs.
   Drop them in `import/` (gitignored).
2. **Import**:

   ```bash
   docker compose exec web node tools/import-sheet-csv.js \
       --prices /repo/import/Prices.csv --pins /repo/import/Pins.csv --dry-run
   ```

   Check the report (it lists any device name that doesn't match `config/devices.yml`),
   then re-run without `--dry-run`. Add `--manual` to import every price as a
   hand-entered value that pulls will never overwrite.

   Devices and parts don't need importing — `config/devices.yml` and `config/parts.yml`
   already carry the sheet's full list and search templates.
3. **Set each store's real margins**: pick the store → Calculator → Save. Or put them in
   `config/stores.yml` before first boot and they seed straight in.
4. **Verify**: one manual TM pull and one scheduled scraper run both land in the matrix
   (Status → Recent activity shows both).
5. **Retire the sheet.**

---

## API

Machine callers authenticate with `X-Key: <INGEST_KEY>`; browsers use the session cookie.

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/prices?grade=&store=` | key or session | The matrix |
| `POST /api/ingest` | key | Push a batch of prices |
| `GET /api/config` | key or session | Devices, parts, queries, pins, schedule — for the scraper/TM |
| `GET/POST/DELETE /api/pins` | key or session | Setup Mode pins |
| `GET /api/stores`, `PUT/DELETE /api/stores/:id/calculator` | session (writes) | Per-store calculators |
| `POST /api/manual` | session | Set/clear a hand-entered price (`price: null` clears) |
| `GET/PUT /api/prefs` | session | Remembered store / grade / view |
| `POST /hooks/pricing` | HMAC signature | GitHub push webhook → instant config deploy |
| `POST /api/git/pull` | key or session | Pull config from git right now |
| `GET /api/status`, `GET /api/logs` | session | Health, git state, activity |
| `GET /api/health` | none | Liveness only — no data |

---

## Notes and limits

- **The Parts Home is parked.** Its entry in `config/settings.yml` is commented out and
  no TPH code ships. The matrix still picks the cheapest across whatever sources are
  enabled, so bringing it back later is one uncommented line plus a scraper.
- `CP_SEARCH_ACTION` in both scrapers is tied to CrazyParts' current frontend build and
  changes when they redeploy. Symptom: everything comes back `NO MATCH`. Fix: DevTools →
  Network → the search POST to `/` → copy the `Next-Action` header into the `EDIT ME`
  block of `scraper/scraper.js` and the userscript.
- Supplier logins never leave the box: the userscript uses your browser session, the
  container reads `.env` (gitignored).
- Rate-limited (default 900 ms between searches, in `settings.yml`) — be a polite customer.
- Price history is kept for `retention.priceHistoryDays` (default 400) so the change
  colouring and `/api/history` have something to compare against.

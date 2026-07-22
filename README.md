# 💰 Parts Price Puller

Self-hosted wholesale price matrix for SOS Phone Repairs, at
**[pricing.sosphonerepairs.thvjq.com.au](https://pricing.sosphonerepairs.thvjq.com.au)**.

Pulls **logged-in wholesale prices** from [CrazyParts](https://crazyparts.com.au) into a
matrix — iPhone 6→16, Samsung S8→S25 + A-series, across 9 part types (LCD/OLED by grade,
refurb, SP, batteries, cameras, back glass) — then shows each store its own **retail**
price from that store's markup / labour / rounding rules.

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

Edit `config/devices.yml` (or `parts.yml`, `settings.yml`, `stores.yml`) **on GitHub**,
commit, and the running site picks it up within `GIT_SYNC_INTERVAL` seconds (default 60).
No redeploy, no SSH, no restart. The web container re-runs `git fetch && git reset --hard
origin/main` on a timer and reloads the YAML when the files change.

- Impatient? **Status → Pull config from git now**.
- Broke the YAML? The site keeps serving the last good copy and shows a red banner with
  the parse error instead of falling over.
- ⚠ The checkout the container watches is a **mirror of `origin/main`** — it hard-resets.
  Don't keep uncommitted edits in it. (Set `GIT_SYNC=0` if you want a frozen config.)

App code changes still need a rebuild: `git pull && docker compose up -d --build`.

---

## Deploy

### TrueNAS SCALE (Willard) — the real deployment

Use [`deploy/truenas-scale.yaml`](deploy/truenas-scale.yaml). It uses prebuilt ghcr.io
images because the TrueNAS Custom App installer cannot build.

1. **Datasets** → create `parts-price-puller`, and under it `repo` and `data`.
   Back up `data` — it holds every price and every store calculator.
2. **Apps → Discover Apps → ⋮ → Install via YAML** → paste the file.
3. Edit every `⚠` line: pool name in the two volume paths, `SITE_PASSWORD`, `INGEST_KEY`
   (the same value in both services), and the CrazyParts login.
4. Install. First boot clones this repo into `/repo` by itself — nothing to copy up front.
5. **Cloudflare** → point `pricing.sosphonerepairs.thvjq.com.au` at
   `http://<truenas-ip>:8788`, same pattern as sosmessenger. Or uncomment the
   `cloudflared` service and run it as a tunnel with no open port at all.

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

**Login** — one shared staff password (`SITE_PASSWORD`). Wholesale pricing is never
public. If you'd rather use Cloudflare Access, set `AUTH_MODE=cf-access` and let Access
do the auth in front.

| Control | What it does |
|---|---|
| **Store** | Applies that store's calculator and reveals the retail figures |
| **Grade** | AMP / BQ7 / SP / … — relabels and re-prices the LCD + OLED columns |
| **Show** | Wholesale · Retail · Both |
| **Filter** | Live device search |
| **Calculator** | This store's markup, labour, GST and rounding — with a live preview |
| **Status** | Config/git health, counts, recent activity, force a config pull |

Click any cell for its source, matched product title, product link, timestamp, what the
other supplier quoted, and the change since the last pull. Cells tint **green** when the
price dropped and **red** when it rose; an amber dot means the cell is pinned; a red bar
means the price was entered by hand and no pull will overwrite it.

Bookmarkable: `?store=lismore&view=both&grade=AMP&q=iphone%2013` — handy for sending a
store straight to their own retail column. Add `#calc` to open the calculator too.

### The calculator

```
retail = round( wholesale × (1 + markup%) + labour )   [+ GST]
```

`markup` is either flat or cost-tiered (cheap parts carry a much bigger multiplier than
a $300 service pack — that's what the tier table is for). Rounding does nearest/up/down
to any step, with an optional `.99` / `.95` ending.

Seeds come from `config/stores.yml`; the moment you press **Save**, that store's
calculator belongs to the database and git stops touching it. **Reset to git defaults**
hands it back.

---

## Tampermonkey — pinning and on-demand pulls

**[▶ Install / update userscript](https://raw.githubusercontent.com/THVjQ/parts-price-puller/main/tampermonkey/parts-price-puller.user.js)**
(auto-updates via `@updateURL`).

First run: open CrazyParts logged in → 💰 panel (bottom-left) → **⚙ Settings** → the site
URL (`https://pricing.sosphonerepairs.thvjq.com.au`) and the **ingest key** (`INGEST_KEY`
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
| `POST /api/git/pull` | key or session | Pull config from git right now (webhook-friendly) |
| `GET /api/status`, `GET /api/logs` | session | Health, git state, activity |
| `GET /api/health` | none | Liveness only — no data |

---

## Notes and limits

- **The Parts Home** is listed in `settings.yml` but has **no scraper yet** (`enabled:
  false`). The matrix already picks the cheapest across sources, so when a TPH scraper
  lands it just starts appearing. Prices imported or pushed under `TPH` display today.
- `CP_SEARCH_ACTION` in both scrapers is tied to CrazyParts' current frontend build and
  changes when they redeploy. Symptom: everything comes back `NO MATCH`. Fix: DevTools →
  Network → the search POST to `/` → copy the `Next-Action` header into the `EDIT ME`
  block of `scraper/scraper.js` and the userscript.
- Supplier logins never leave the box: the userscript uses your browser session, the
  container reads `.env` (gitignored).
- Rate-limited (default 900 ms between searches, in `settings.yml`) — be a polite customer.
- Price history is kept for `retention.priceHistoryDays` (default 400) so the change
  colouring and `/api/history` have something to compare against.

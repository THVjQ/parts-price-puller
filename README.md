# 💰 Parts Price Puller

Pulls **logged-in wholesale prices** from [CrazyParts](https://crazyparts.com.au) and [The Parts Home](https://thepartshome.com.au) into a Google Sheet price matrix — iPhone 6→16 + Samsung S8→S25 + A-series, across 9 part types (LCD/OLED by grade, refurb, SP, batteries, cameras, back glass). Grade switching (AMP/BQ7/SP/…), fully editable device list + search queries, and a weekly scheduled pull (default Sunday 12am, changeable in the sheet).

## Components

| Piece | What | Where |
|---|---|---|
| `apps-script/Code.gs` | The Sheet brain — builds the grid, edit menus, web API | Google Apps Script |
| `tampermonkey/parts-price-puller.user.js` | On-demand pulls using **your browser's logged-in session** | Tampermonkey |
| `scraper/` | Headless Playwright container — the real unattended weekly pull | Docker (any box/NAS) |

## Install

### 1. Google Sheet (required, first)

1. New Google Sheet → **Extensions → Apps Script** → paste [`apps-script/Code.gs`](apps-script/Code.gs) → save
2. Run `setupSheets()` once from the editor toolbar (authorise when asked)
3. **Project Settings → Script properties** → add property `KEY` = any long random string
4. **Deploy → New deployment → Web app** → *Execute as: Me*, *Access: Anyone* → copy the `/exec` URL

You now have tabs: **Prices** (the matrix), **Devices** (add/remove/disable devices), **Config** (grade, schedule day/hour, rate limit, per-part search query templates + must/exclude keywords), **Log**. A **💰 Price Puller** menu appears in the sheet for add-device / rebuild / clear.

### 2. Tampermonkey (one click)

**[▶ Install userscript](https://raw.githubusercontent.com/THVjQ/parts-price-puller/main/tampermonkey/parts-price-puller.user.js)** — Tampermonkey picks it up automatically, and **auto-updates** whenever this repo's version bumps (`@updateURL` points here).

First run: open either parts site (logged in), click the 💰 panel bottom-right → **⚙ Settings** → paste your `/exec` URL and `KEY`. Settings are stored in Tampermonkey storage, so script updates never wipe them.

Then **▶ Pull all prices** — walks every enabled device × part query on the current site (~12 min at default rate limit) and writes straight into the sheet. Grade dropdown pushes changes back to the sheet. If a site tab is open at the scheduled time, it auto-runs.

### 3. Scheduled scraper (optional — true Sunday 12am automation)

Tampermonkey can't run with the browser closed. This container logs in by itself and reads the schedule **live from the sheet**, so changing day/hour in Config just works — no restart.

```bash
git clone https://github.com/THVjQ/parts-price-puller.git
cd parts-price-puller/scraper
./install.sh          # creates .env — edit it (URL, KEY, both site logins)
nano .env
./install.sh          # pulls prebuilt image (or builds locally) and starts
docker logs -f parts-price-puller
```

Test immediately: set `RUN_NOW=1` in `.env`, `docker compose up -d`, watch logs, remove it after.

## Updates

- **Userscript:** automatic via Tampermonkey (`@updateURL` → this repo, checked on TM's schedule; force-check via TM dashboard → Utilities)
- **Scraper:** `./update.sh` (git pull + pull/rebuild image + restart, `.env` untouched) — or run [Watchtower](https://containrrr.dev/watchtower/) and it tracks `ghcr.io/thvjq/parts-price-puller:latest` automatically, which GitHub Actions rebuilds on every push to `scraper/`
- **Apps Script:** re-paste `Code.gs` on changes. Your data lives in the sheet tabs, not the script — `setupSheets()` never overwrites existing Devices/Config/Prices rows

## Customising

- **Devices** tab: name / search term / aliases (`;` separated, e.g. `SE 2020;SE2`) / enabled tickbox → 💰 menu → *Rebuild Prices grid*
- **Grade**: Config B2 dropdown or the TM panel — relabels LCD/OLED columns, all future pulls use it in queries
- **Queries**: Config rows 10+ — full control of search template (`{device}`/`{grade}` placeholders), must-match and exclude keywords per part type
- **Schedule**: Config B3/B4 — picked up live by both TM and the container
- **Selectors**: `EDIT ME` block at the top of both scrapers. Defaults assume standard WooCommerce; if everything comes back `NO MATCH`, inspect a product tile on the site and adjust `item`/`title`/`price`. Failed queries are written into the cell note so you can see exactly what was searched

## How matching works

Search each site's product search → title must contain every device token (with a suffix guard so "iPhone 12" won't match "12 Pro Max") → must hit ≥1 must-keyword, zero exclude-keywords → cheapest survivor wins. Matched title + URL + timestamp land in the cell note. No match writes `—`.

## Notes

- Your supplier logins never leave your machine: TM uses your existing session; the container keeps them in your local `.env` (gitignored)
- Rate-limited (default 900 ms/search, sheet-configurable) — be a polite customer
- For personal/shop use with accounts you own; respect each site's terms

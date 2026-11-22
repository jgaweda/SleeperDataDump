# Sleeper League Exporter

A static web app that downloads a Sleeper fantasy football league's full history into one zip file. It covers trades, waiver and free agent transactions, rosters, matchups, drafts, playoff brackets, and league settings and scoring rules. All prior seasons are included.

It runs entirely in the browser against the public, read-only [Sleeper API](https://docs.sleeper.com/). It needs no login, server, or build step.

## Use it

1. Open the app (see **Run locally** or **Deploy** below).
2. Enter your Sleeper username. The app searches every season from 2017 on and groups renewed leagues together, so a five-year dynasty shows up once.
3. Pick a league. You can filter by season.
4. Click **Download league data**. You get a zip, plus an on-screen summary of champions, rivalries, and your all-time record.

Deep links: `index.html?username=<name>` or `index.html?league=<league_id>`.

## Run locally

```bash
npm start
```

Then open http://localhost:8080. Opening `index.html` directly from disk also works, because the app uses classic scripts and has no module loading.

## Headless export (Node 18+)

```bash
node scripts/export-node.mjs <league_id> [sleeper_username] [out_dir] [--no-history]
```

The script uses the same modules as the browser app. This makes it suitable for a scheduled job that snapshots the league every week.

## What's in the zip

```
<league>_sleeper_export_<date>/
  README.md, manifest.json         index of seasons, counts, files, schema version
  history/                         all seasons combined, analysis-ready CSV
    managers.csv                   all-time record, points, titles, trades per manager
    standings.csv                  final standings + playoff finish per season
    matchups.csv                   one row per team per completed game (regular / playoff / consolation)
    head_to_head.csv               every manager pair: games, wins, points, playoff meetings, last result
    transactions.csv               every transaction, any status
    transaction_items.csv          one row per asset moved (player, pick, FAAB)
    trades.csv, trade_sides.csv    completed trades: summary and per-team sent/received
    draft_picks.csv                every draft selection
    roster_players.csv             each roster's players per season
    traded_pick_ownership.csv      current owner of every traded pick
  seasons/<year>/
    league.json, scoring_settings.json, rules.md
    users.json, rosters.json, traded_picks.json
    transactions/week_XX.json, matchups/week_XX.json
    drafts/<draft_id>/{draft,picks,traded_picks}.json
    playoffs/{winners,losers}_bracket.json
  my_team/                         the same data filtered to your team, plus rivals and trade partners
  players/players_referenced.json  name/position/team for every referenced player
```

The raw API responses are kept exactly as Sleeper returned them. The CSVs are derived from them.

## League constitution (house rules)

`js/house-rules.js` holds the written constitution plus a machine-readable version of it. When **Apply league constitution** is checked, the export adds `house_rules/`:

| File | What it does |
| --- | --- |
| `constitution.md` | The written rules, verbatim |
| `constitution_check.md` / `.csv` | Every checkable rule compared with Sleeper's settings: PASS, MISMATCH, CONFLICT (the rules contradict themselves), or INFO |
| `house_standings.csv` | Ranking by win %, PF, Max PF, then PA. Playoff seeds are the top 5 by record plus 1 points wildcard, compared with the bracket Sleeper actually ran |
| `draft_order.csv` | Rookie draft order: non-playoff teams by lowest Max PF, then playoff teams by finish (champion last). Compared with the draft that actually followed |
| `lineup_issues.csv`, `lineup_summary.csv` | Empty starting slots per week (invalid), zero-point starters (review), and whether the 2-invalid-week abandonment threshold was reached |
| `dues_obligations.csv` | For each owner who traded away future picks, the season their dues must be paid through and the amount due upfront |

To apply the constitution automatically for a league, add any of its season league IDs to `leagueIds` in `js/house-rules.js`. Otherwise the checkbox setting is remembered per league in the browser. Headless: add `--house-rules` to `scripts/export-node.mjs`.

Sleeper's own Max PF already counts taxi players' points. It matched optimal lineups computed with taxi players included, so the taxi rule needs no extra calculation.

## Architecture

| File | Responsibility |
| --- | --- |
| `js/sleeper-api.js` | API client: throttled to about 850 requests per minute (Sleeper's limit is 1000), bounded concurrency, retry with backoff |
| `js/collector.js` | Walks `previous_league_id` to find every season and pulls each endpoint. Returns raw data only |
| `js/transform.js` | Builds normalized tables keyed by manager `user_id`, which is stable across seasons, and renders `rules.md` |
| `js/zip-writer.js` | Lays out the zip, manifest, and README |
| `js/house-rules.js`, `js/house-rules-engine.js` | League constitution text and structured rules, and the engine that applies and checks them |
| `js/player-cache.js` | 24-hour IndexedDB cache for `/players/nfl` (about 15 MB), per Sleeper's once-per-day guidance |
| `js/app.js` | UI. All league data is rendered with `textContent` |

Collection, transformation, and output are separate layers on purpose. The planned rivalry and weekly analysis app can reuse `collector.js` and `transform.js` without changes and add a new presentation layer on top of the same tables.

A typical export uses about 45 API requests per season. A 2-season, 12-team league takes about 8 seconds.

## Tests

```bash
npm test
```

These are offline unit tests for the transform layer and the house-rules engine. They cover trades that include picks and FAAB, waiver bids, failed claims, playoff and consolation classification, head-to-head totals, champion detection, and in-season week cutoffs.

## Deploy (GitHub Pages)

`.github/workflows/pages.yml` runs the tests and publishes the static site on every push to `main`. To turn it on, go to **Settings > Pages > Source** and choose **GitHub Actions**.

## Known limits

- Sleeper's public API only covers what the league exposes. It does not include chat, polls, or trade offers that were never accepted.
- Player team and position come from the current player directory, not from when a transaction happened. Draft picks keep the team at the time of the draft.
- `regular_season_rank` sorts by wins, then losses, then points for. Sleeper's own tiebreakers may differ.

JSZip 3.10.1 is vendored in `vendor/` under the MIT license.

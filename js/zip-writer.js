/*
 * Zip writer: lays out the raw dataset and the derived model as a folder tree
 * inside a single zip archive.
 *
 * Requires JSZip (vendor/jszip.min.js in the browser, passed in for Node).
 */
(function (root) {
  "use strict";

  const NS = (root.SleeperDump = root.SleeperDump || {});

  /**
   * @param {object} dataset  output of collectLeague
   * @param {object} model    output of buildModel
   * @param {function} JSZip
   * @returns {{zip: JSZip, folderName: string, fileName: string, manifest: object}}
   */
  function buildZip(dataset, model, JSZip) {
    const toCsv = NS.toCsv;
    const latest = dataset.seasons[0];
    const slug = slugify(latest.league.name);
    const day = dataset.exportedAt.slice(0, 10);
    const folderName = `${slug}_sleeper_export_${day}`;
    const zip = new JSZip();
    const top = zip.folder(folderName);
    const files = [];
    const add = (path, content) => {
      top.file(path, content);
      files.push(path);
    };
    const json = (v) => JSON.stringify(v, null, 2);
    const pad = (n) => String(n).padStart(2, "0");

    // --- league history (all seasons combined) -------------------------------
    const t = model.tables;
    add("history/managers.csv", toCsv(t.managers));
    add("history/managers.json", json(t.managers));
    add("history/standings.csv", toCsv(t.standings));
    add("history/matchups.csv", toCsv(t.matchups));
    add("history/head_to_head.csv", toCsv(t.headToHead));
    add("history/transactions.csv", toCsv(t.transactions));
    add("history/transaction_items.csv", toCsv(t.transactionItems));
    add("history/trades.csv", toCsv(t.trades));
    add("history/trade_sides.csv", toCsv(t.tradeSides));
    add("history/draft_picks.csv", toCsv(t.draftPicks));
    add("history/roster_players.csv", toCsv(t.rosterPlayers));
    add("history/traded_pick_ownership.csv", toCsv(t.futurePickOwnership));

    // --- per-season raw data ------------------------------------------------
    for (const s of dataset.seasons) {
      const base = `seasons/${s.season}`;
      add(`${base}/league.json`, json(s.league));
      add(`${base}/rules.md`, model.rules[s.season]);
      add(`${base}/scoring_settings.json`, json(s.league.scoring_settings || {}));
      add(`${base}/users.json`, json(s.users));
      add(`${base}/rosters.json`, json(s.rosters));
      add(`${base}/traded_picks.json`, json(s.tradedPicks));
      add(`${base}/playoffs/winners_bracket.json`, json(s.winnersBracket));
      add(`${base}/playoffs/losers_bracket.json`, json(s.losersBracket));
      const allTx = [];
      for (const [w, list] of Object.entries(s.transactionsByWeek)) {
        add(`${base}/transactions/week_${pad(w)}.json`, json(list));
        allTx.push(...list);
      }
      add(`${base}/transactions/all_transactions.json`, json(allTx));
      for (const [w, list] of Object.entries(s.matchupsByWeek)) {
        add(`${base}/matchups/week_${pad(w)}.json`, json(list));
      }
      for (const d of s.drafts) {
        const db = `${base}/drafts/${d.draft.draft_id}`;
        add(`${db}/draft.json`, json(d.draft));
        add(`${db}/picks.json`, json(d.picks));
        add(`${db}/traded_picks.json`, json(d.tradedPicks));
      }
    }

    // --- my team -----------------------------------------------------------
    const my = model.myTeam;
    if (my && my.found) {
      add("my_team/summary.json", json({ manager_id: my.managerId, display_name: my.displayName, ...my.summary }));
      add("my_team/seasons.csv", toCsv(my.seasons));
      add("my_team/rivals.csv", toCsv(my.rivals));
      add("my_team/matchups.csv", toCsv(my.matchups));
      add("my_team/transaction_items.csv", toCsv(my.transactionItems));
      add("my_team/trade_sides.csv", toCsv(my.tradeSides));
      add("my_team/current_roster.csv", toCsv(my.currentRoster));
      add("my_team/draft_picks.csv", toCsv(my.draftPicks));
    }

    // --- house rules (league constitution) ----------------------------------
    const house = model.house;
    if (house) {
      add("house_rules/constitution.md", house.text);
      add("house_rules/constitution_check.md", NS.houseChecksMarkdown(house, latest.league.name, latest.season));
      add("house_rules/constitution_check.csv", toCsv(house.checks));
      add("house_rules/house_rules.json", json({ version: house.version, rules: house.rules }));
      add("house_rules/house_standings.csv", toCsv(house.standings));
      add("house_rules/draft_order.csv", toCsv(house.draftOrder));
      add("house_rules/lineup_issues.csv", toCsv(house.lineupIssues));
      add("house_rules/lineup_summary.csv", toCsv(house.lineupSummary));
      add("house_rules/dues_obligations.csv", toCsv(house.duesObligations));
    }

    // --- players & meta ----------------------------------------------------
    add("players/players_referenced.json", json(model.playersReferenced));
    if (dataset.playersFull) add("players/players_nfl_full.json", JSON.stringify(dataset.playersFull));
    add("nfl_state.json", json(dataset.nflState));

    const manifest = {
      schema_version: model.schemaVersion,
      generator: "Sleeper League Data Export",
      exported_at: dataset.exportedAt,
      league_name: latest.league.name,
      root_league_id: dataset.rootLeagueId,
      username: dataset.username,
      user_id: dataset.userId,
      seasons: dataset.seasons.map((s) => ({
        season: s.season,
        league_id: s.leagueId,
        status: s.league.status,
        teams: s.rosters.length,
        last_completed_week: s.lastCompletedWeek,
        transactions: Object.values(s.transactionsByWeek).reduce((a, l) => a + l.length, 0),
        matchup_weeks: Object.keys(s.matchupsByWeek).length,
        drafts: s.drafts.length,
      })),
      counts: {
        managers: t.managers.length,
        matchup_rows: t.matchups.length,
        transactions: t.transactions.length,
        completed_trades: t.trades.length,
        draft_picks: t.draftPicks.length,
        players_referenced: Object.keys(model.playersReferenced).length,
      },
      house_rules: house
        ? {
            version: house.version,
            checks: house.checks.reduce((a, c) => ((a[c.status] = (a[c.status] || 0) + 1), a), {}),
          }
        : null,
      api_requests: dataset.requestCount,
      files: [...files, "README.md", "manifest.json"].sort(),
    };
    top.file("manifest.json", json(manifest));
    top.file("README.md", readme(manifest, my, !!house));

    return { zip, folderName, fileName: `${folderName}.zip`, manifest };
  }

  function readme(m, my, hasHouse) {
    const seasons = m.seasons.map((s) => s.season).join(", ");
    return `# ${m.league_name}: Sleeper data export

Exported ${m.exported_at} from the public Sleeper API (${m.api_requests} requests).
Seasons included: ${seasons}. Schema version ${m.schema_version}.
${my && my.found ? `\n"My team" views are built for **${my.displayName}** (user_id \`${my.managerId}\`).\n` : ""}
## Layout

| Path | Contents |
| --- | --- |
| \`history/managers.csv\` | One row per manager (Sleeper user) across all seasons: record, points, titles, trades |
| \`history/standings.csv\` | Final regular-season standings per season, plus playoff finish |
| \`history/matchups.csv\` | One row per team per completed game. \`game_type\` = regular, playoff, consolation |
| \`history/head_to_head.csv\` | All-time record for every manager pair. The base for rivalry analysis |
| \`history/transactions.csv\` | Every transaction (trades, waivers, free agent moves, commissioner moves), any status |
| \`history/transaction_items.csv\` | One row per asset moved (player, pick, FAAB) in completed transactions |
| \`history/trades.csv\` | One row per completed trade with a readable summary |
| \`history/trade_sides.csv\` | One row per team per trade: what each side sent and received |
| \`history/draft_picks.csv\` | Every draft selection across seasons |
| \`history/roster_players.csv\` | Each roster's players per season (end of season, or current for the active season) |
| \`history/traded_pick_ownership.csv\` | Who currently owns each traded draft pick |
| \`seasons/<year>/rules.md\` | Readable league settings: format, roster, waivers, trades, playoffs, scoring |
| \`seasons/<year>/league.json\` | Raw league object including \`settings\`, \`scoring_settings\`, \`roster_positions\` |
| \`seasons/<year>/transactions/week_XX.json\` | Raw transactions by week |
| \`seasons/<year>/matchups/week_XX.json\` | Raw matchups by week, including per-player points and starters |
| \`seasons/<year>/drafts/<draft_id>/\` | Raw draft settings, picks, and traded picks |
| \`seasons/<year>/playoffs/\` | Winners and losers brackets |
| \`my_team/\` | The same data filtered to your team, plus rivals and trade partners |${hasHouse ? `
| \`house_rules/constitution.md\` | The written league constitution |
| \`house_rules/constitution_check.md\` | Each written rule compared with Sleeper's actual settings |
| \`house_rules/house_standings.csv\` | Standings with the house tiebreakers and 5 + 1 points-wildcard seeding, compared with Sleeper's bracket |
| \`house_rules/draft_order.csv\` | Rookie draft order by house formula, compared with the draft that actually ran |
| \`house_rules/lineup_issues.csv\`, \`lineup_summary.csv\` | Empty starting slots and zero-point starters, with abandonment threshold flags |
| \`house_rules/dues_obligations.csv\` | Dues each owner must prepay because of future picks they traded away |` : ""}
| \`players/players_referenced.json\` | Name, position, and team for every player referenced in this export |
| \`manifest.json\` | Machine-readable index of seasons, counts, and files |

## Notes

- Managers are keyed by Sleeper \`user_id\`, which is stable across seasons. \`roster_id\` is only stable within a season.
- Results only count weeks whose scores are final (\`last_completed_week\` in the manifest).
- \`regular_season_rank\` is ordered by wins, then losses, then points for. Sleeper's own tiebreakers may differ.
- Player team and position reflect the player directory at export time, not at the time of the transaction.
  Draft picks keep \`nfl_team_at_draft\` from Sleeper's pick metadata.
- Amounts in \`waiver_bid\` and \`faab_amount\` are FAAB dollars.
`;
  }

  function slugify(s) {
    return (
      String(s || "league")
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase()
        .slice(0, 50) || "league"
    );
  }

  NS.buildZip = buildZip;
})(typeof globalThis !== "undefined" ? globalThis : this);

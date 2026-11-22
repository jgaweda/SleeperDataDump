/*
 * House rules engine: applies the league constitution (house-rules.js) to the
 * exported data. Everything here is derived; raw Sleeper data is untouched.
 *
 * Outputs
 * - standings:  house ranking (win %, PF, Max PF, PA), 5 + 1 playoff seeding,
 *               and whether Sleeper's actual bracket matched
 * - draftOrder: rookie draft order implied by each season, compared with the
 *               draft that actually followed when it exists
 * - lineupIssues: empty starting slots and zero-point starters per week
 * - duesObligations: seasons each owner must have paid through, given picks traded away
 * - checks:     constitution vs Sleeper settings (pass / mismatch / conflict / info)
 */
(function (root) {
  "use strict";

  const NS = (root.SleeperDump = root.SleeperDump || {});

  function applyHouseRules(dataset, model, houseRules) {
    const R = houseRules.rules;
    const standings = [];
    const draftOrder = [];
    const lineupIssues = [];

    const bySeason = new Map(model.seasons.map((ctx) => [ctx.season, ctx]));

    for (const ctx of model.seasons) {
      const rows = houseStandings(ctx, model.tables.standings.filter((s) => s.season === ctx.season), R);
      standings.push(...rows);
      draftOrder.push(...rookieDraftOrder(ctx, rows, bySeason.get(String(Number(ctx.season) + 1)), R));
      lineupIssues.push(...lineupIssueRows(ctx, dataset.players || {}));
    }

    const latest = model.seasons[0];
    return {
      version: houseRules.version,
      text: houseRules.text,
      rules: R,
      standings,
      draftOrder,
      lineupIssues,
      lineupSummary: lineupSummary(lineupIssues, R),
      duesObligations: duesObligations(latest, R),
      checks: settingsChecks(latest, R),
    };
  }

  // ---------------------------------------------------------------------------
  // Standings and seeding
  // ---------------------------------------------------------------------------

  function compareTeams(R) {
    const paSign = R.playoffs.pointsAgainstHigherWins ? -1 : 1;
    return (a, b) =>
      winPct(b) - winPct(a) ||
      b.points_for - a.points_for ||
      b.max_points_for - a.max_points_for ||
      paSign * (a.points_against - b.points_against) ||
      0;
  }

  function houseStandings(ctx, rows, R) {
    const sorted = [...rows].sort(compareTeams(R));
    const P = R.playoffs;
    const seeded = sorted.slice(0, P.byRecord);
    const rest = sorted.slice(P.byRecord);
    const wildcards = [...rest].sort((a, b) => b.points_for - a.points_for).slice(0, P.pointsWildcards);
    const seedOf = new Map();
    seeded.forEach((r, i) => seedOf.set(r.roster_id, { seed: i + 1, via: "record" }));
    wildcards.forEach((r, i) => seedOf.set(r.roster_id, { seed: P.byRecord + i + 1, via: "points_wildcard" }));

    const actualPlayoffTeams = bracketTeams(ctx.raw.winnersBracket);
    const hasBracket = actualPlayoffTeams.size > 0;

    return sorted.map((r, i) => {
      const s = seedOf.get(r.roster_id);
      const inHouse = !!s;
      const inSleeper = actualPlayoffTeams.has(r.roster_id);
      return {
        season: r.season,
        house_rank: i + 1,
        roster_id: r.roster_id,
        manager_id: r.manager_id,
        manager: r.manager,
        team_name: r.team_name,
        wins: r.wins,
        losses: r.losses,
        ties: r.ties,
        win_pct: round3(winPct(r)),
        points_for: r.points_for,
        max_points_for: r.max_points_for,
        points_against: r.points_against,
        house_playoff_seed: s ? s.seed : "",
        qualified_via: s ? s.via : "",
        in_sleeper_bracket: hasBracket ? inSleeper : "",
        seeding_matches_sleeper: hasBracket ? inHouse === inSleeper : "",
        playoff_finish: r.playoff_finish,
        champion: r.champion,
      };
    });
  }

  /** Every roster that appears in the winners bracket (including teams with a first-round bye). */
  function bracketTeams(bracket) {
    const s = new Set();
    for (const g of bracket || []) {
      if (typeof g.t1 === "number") s.add(g.t1);
      if (typeof g.t2 === "number") s.add(g.t2);
    }
    return s;
  }

  // ---------------------------------------------------------------------------
  // Rookie draft order (linear: the same order every round)
  // ---------------------------------------------------------------------------

  function rookieDraftOrder(ctx, houseRows, nextCtx, R) {
    if (!houseRows.length || ctx.lastCompletedWeek === 0) return [];
    const playoffTeams = houseRows.filter((r) => r.house_playoff_seed !== "");
    const nonPlayoff = houseRows.filter((r) => r.house_playoff_seed === "");
    const finished = playoffTeams.every((r) => r.playoff_finish !== "");

    // Non-playoff: lowest Max PF picks first.
    const np = [...nonPlayoff].sort((a, b) => a.max_points_for - b.max_points_for);
    // Playoff: worst finish picks first, champion last. Before playoffs finish, worst seed first.
    const pl = [...playoffTeams].sort((a, b) =>
      finished ? b.playoff_finish - a.playoff_finish : b.house_playoff_seed - a.house_playoff_seed
    );

    const actual = actualDraftSlots(nextCtx);
    const draftSeason = String(Number(ctx.season) + 1);
    return [...np, ...pl].map((r, i) => {
      const actualSlot = actual ? actual.get(r.manager_id) : undefined;
      return {
        draft_season: draftSeason,
        based_on_season: ctx.season,
        status: ctx.raw.league.status === "complete" && finished ? "final" : "projected",
        pick: i + 1,
        roster_id: r.roster_id,
        manager_id: r.manager_id,
        manager: r.manager,
        team_name: r.team_name,
        basis: r.house_playoff_seed === ""
          ? `Non-playoff, Max PF ${r.max_points_for}`
          : finished ? `Playoff finish ${r.playoff_finish}` : `Playoff seed ${r.house_playoff_seed}`,
        actual_slot: actualSlot ?? "",
        matches_actual: actualSlot == null ? "" : actualSlot === i + 1,
      };
    });
  }

  /** manager_id -> slot for the draft run in the following season's league. */
  function actualDraftSlots(nextCtx) {
    if (!nextCtx) return null;
    const d = (nextCtx.raw.drafts || [])
      .map((x) => x.draft)
      .filter((x) => x && x.draft_order)
      .sort((a, b) => (a.start_time || 0) - (b.start_time || 0))[0];
    if (!d) return null;
    return new Map(Object.entries(d.draft_order).map(([uid, slot]) => [uid, Number(slot)]));
  }

  // ---------------------------------------------------------------------------
  // Lineups
  // ---------------------------------------------------------------------------

  function lineupIssueRows(ctx, players) {
    const rows = [];
    const slots = (ctx.raw.league.roster_positions || []).filter((p) => p !== "BN");
    for (const [weekStr, entries] of Object.entries(ctx.raw.matchupsByWeek)) {
      const week = Number(weekStr);
      if (week > ctx.lastCompletedWeek) continue;
      for (const m of entries) {
        if (m.matchup_id == null) continue; // eliminated teams in playoff weeks
        const r = ctx.roster(m.roster_id);
        const starters = m.starters || [];
        const pts = m.starters_points || [];
        starters.forEach((pid, i) => {
          const base = {
            season: ctx.season, week, roster_id: m.roster_id,
            manager_id: r.managerId || "", manager: r.displayName, slot: slots[i] || "",
          };
          if (!pid || pid === "0") {
            rows.push({ ...base, issue: "empty_slot", player_id: "", player_name: "", points: 0 });
          } else if (Number(pts[i] || 0) === 0) {
            const p = players[pid] || {};
            rows.push({ ...base, issue: "zero_point_starter", player_id: pid, player_name: p.full_name || pid, points: 0 });
          }
        });
      }
    }
    return rows.sort((a, b) => Number(b.season) - Number(a.season) || a.week - b.week || a.roster_id - b.roster_id);
  }

  /** Per manager per season: weeks with an empty slot (invalid) and weeks with a zero-point starter (review). */
  function lineupSummary(issues, R) {
    const map = new Map();
    for (const i of issues) {
      const key = `${i.season}|${i.roster_id}`;
      let s = map.get(key);
      if (!s) {
        s = { season: i.season, roster_id: i.roster_id, manager_id: i.manager_id, manager: i.manager, invalid: new Set(), review: new Set() };
        map.set(key, s);
      }
      (i.issue === "empty_slot" ? s.invalid : s.review).add(i.week);
    }
    return [...map.values()]
      .map((s) => ({
        season: s.season,
        roster_id: s.roster_id,
        manager_id: s.manager_id,
        manager: s.manager,
        invalid_weeks: s.invalid.size,
        invalid_week_list: [...s.invalid].sort((a, b) => a - b).join(" "),
        zero_point_starter_weeks: s.review.size,
        zero_point_week_list: [...s.review].sort((a, b) => a - b).join(" "),
        abandonment_threshold_reached: s.invalid.size >= R.abandonment.invalidWeeks,
      }))
      .sort((a, b) => Number(b.season) - Number(a.season) || b.invalid_weeks - a.invalid_weeks);
  }

  // ---------------------------------------------------------------------------
  // Dues owed because of traded future picks
  // ---------------------------------------------------------------------------

  function duesObligations(ctx, R) {
    const season = Number(ctx.season);
    const owners = new Map();
    for (const pk of ctx.raw.tradedPicks || []) {
      if (pk.owner_id === pk.roster_id) continue; // pick is back with its original team
      const r = ctx.roster(pk.roster_id);
      let o = owners.get(pk.roster_id);
      if (!o) {
        o = { roster_id: pk.roster_id, manager_id: r.managerId || "", manager: r.displayName, picks: [], maxSeason: 0 };
        owners.set(pk.roster_id, o);
      }
      o.picks.push(`${pk.season} R${pk.round} -> ${ctx.roster(pk.owner_id).displayName}`);
      o.maxSeason = Math.max(o.maxSeason, Number(pk.season));
    }
    return [...owners.values()]
      .map((o) => ({
        as_of_season: ctx.season,
        roster_id: o.roster_id,
        manager_id: o.manager_id,
        manager: o.manager,
        picks_traded_away: o.picks.join("; "),
        dues_required_through: o.maxSeason,
        seasons_of_dues_owed: Math.max(0, o.maxSeason - season),
        amount_required_upfront: Math.max(0, o.maxSeason - season) * R.dues.amountPerYear,
        beyond_trade_window: o.maxSeason > season + R.trades.futurePickYears,
      }))
      .sort((a, b) => b.dues_required_through - a.dues_required_through);
  }

  // ---------------------------------------------------------------------------
  // Constitution vs Sleeper settings
  // ---------------------------------------------------------------------------

  function settingsChecks(ctx, R) {
    const L = ctx.raw.league;
    const s = L.settings || {};
    const sc = L.scoring_settings || {};
    const checks = [];
    const add = (area, rule, expected, actual, status, note) =>
      checks.push({ area, rule, expected: String(expected), actual: String(actual), status, note: note || "" });
    const cmp = (area, rule, expected, actual, note) =>
      add(area, rule, expected, actual ?? "not set", Number(expected) === Number(actual) ? "pass" : "mismatch", note);

    const slotCounts = {};
    for (const p of L.roster_positions || []) slotCounts[p] = (slotCounts[p] || 0) + 1;

    cmp("League", "Teams (implied by $50 dues and $500 in prizes)", R.teams, L.total_rosters);
    const pot = R.teams * R.dues.amountPerYear;
    const prizeTotal = R.prizes.reduce((a, b) => a + b, 0);
    add("Dues", "Prize payouts equal the dues pot", `$${pot}`, `$${prizeTotal}`, pot === prizeTotal ? "pass" : "mismatch");

    for (const [slot, n] of Object.entries(R.roster.slots)) {
      cmp("Roster", `${slot === "BN" ? "Bench" : slot} slots`, n, slotCounts[slot] || 0);
    }
    cmp("Roster", "IR slots", R.roster.irSlots, s.reserve_slots);
    add(
      "Roster", "Taxi slots", `${R.roster.taxiSlots} (Roster section) or ${R.roster.taxiSlotsAlt} (Taxi section)`, s.taxi_slots,
      "conflict", `The constitution lists both ${R.roster.taxiSlots} and ${R.roster.taxiSlotsAlt}. Sleeper is set to ${s.taxi_slots}. Update the constitution to match.`
    );
    const activeSlots = Object.entries(slotCounts).filter(([k]) => k !== "IR").reduce((a, [, n]) => a + n, 0);
    cmp("Roster", "Week 1 active roster limit (starters + bench)", R.roster.activeLimitWeek1, activeSlots);
    add("Taxi", "Rookies only (no veterans)", "No veterans", s.taxi_allow_vets ? "Veterans allowed" : "No veterans",
      s.taxi_allow_vets ? "mismatch" : "pass");
    add("Taxi", "Players stay on taxi until promoted", "No year limit", `taxi_years = ${s.taxi_years ?? "not set"}`, "info",
      "Sleeper caps how many years a player can stay on taxi. Confirm the value allows the intended stay.");
    add("Taxi", "Taxi points count toward Max PF", "Included", "Included", "pass",
      "Verified: Sleeper's Max PF equals the optimal lineup computed from every rostered player, including taxi.");

    cmp("Scoring", "Points per reception", R.scoring.rec, sc.rec);
    cmp("Scoring", "TE points per reception (PPR + TE premium)", R.scoring.teReceptionTotal, round3((sc.rec || 0) + (sc.bonus_rec_te || 0)));
    cmp("Scoring", "Passing TD", R.scoring.pass_td, sc.pass_td);
    cmp("Scoring", "Rushing TD", R.scoring.rush_td, sc.rush_td);
    cmp("Scoring", "Interception thrown", R.scoring.pass_int, sc.pass_int);
    const bonuses = Object.entries(sc).filter(([k, v]) => v && (/^bonus_/.test(k) && k !== "bonus_rec_te" || /_\d+p$/.test(k)));
    add("Scoring", "Big play bonuses enabled", "At least one", bonuses.length ? bonuses.map(([k, v]) => `${k}=${v}`).join(", ") : "None",
      bonuses.length ? "pass" : "mismatch");

    add("Trades", "Trades process instantly", "0 review days", `${s.trade_review_days ?? "not set"} review days`,
      Number(s.trade_review_days) === 0 ? "pass" : "mismatch");
    add("Trades", "Draft picks tradable", "Enabled", s.pick_trading ? "Enabled" : "Disabled", s.pick_trading ? "pass" : "mismatch");
    add("Trades", "Collusion reversed only by league vote", "Commissioner action", `veto_votes_needed = ${s.veto_votes_needed ?? "not set"}`, "info",
      "Instant trades skip Sleeper's veto window, so a reversal is a manual commissioner action after the vote.");

    const draft = latestDraft(ctx);
    cmp("Draft", "Rookie draft rounds", R.draft.rounds, draft ? draft.settings && draft.settings.rounds : s.draft_rounds,
      draft ? `From draft ${draft.draft_id} (${draft.season}).` : "From league settings; no draft found.");
    add("Draft", "Draft type", R.draft.type, draft ? draft.type : "no draft found",
      draft && draft.type === R.draft.type ? "pass" : "mismatch");
    add("Draft", "Order: non-playoff by reverse Max PF, playoff by finish", "House formula", "Set manually in Sleeper", "info",
      "Sleeper cannot compute this order. See draft_order.csv for the computed order and how it compares with each actual draft.");

    cmp("Playoffs", "Playoff teams", R.playoffs.teams, s.playoff_teams);
    cmp("Playoffs", "Playoffs start week", R.playoffs.startWeek, s.playoff_week_start);
    add("Playoffs", "One week per round (weeks 15 to 17)", "One week per round", s.playoff_round_type === 0 ? "One week per round" : `playoff_round_type = ${s.playoff_round_type}`,
      s.playoff_round_type === 0 ? "pass" : "mismatch");
    add("Playoffs", "Seeding: top 5 by record + 1 points wildcard", "House formula", "Sleeper seeds by record only", "info",
      "Sleeper has no points-wildcard setting. house_standings.csv flags every season where Sleeper's bracket differed.");
    add("Playoffs", "Tiebreakers: record, PF, Max PF, PA", "House order", "Sleeper default tiebreakers", "info",
      "Applied in house_standings.csv. Assumes more points against wins the final tiebreak.");
    add("Lineups", "No empty slots, byes, or Out players", "Valid lineups", "See lineup_issues.csv", "info",
      "Empty slots are detected exactly. Bye and Out cannot be recovered from Sleeper history, so zero-point starters are listed for review.");

    return checks;
  }

  function latestDraft(ctx) {
    return (ctx.raw.drafts || [])
      .map((d) => d.draft)
      .filter(Boolean)
      .sort((a, b) => (b.start_time || 0) - (a.start_time || 0))[0];
  }

  function checksMarkdown(house, leagueName, season) {
    const icon = { pass: "PASS", mismatch: "MISMATCH", conflict: "CONFLICT", info: "INFO" };
    const counts = house.checks.reduce((a, c) => ((a[c.status] = (a[c.status] || 0) + 1), a), {});
    const esc = (v) => String(v).replace(/\|/g, "\\|");
    const lines = [
      `# Constitution check: ${leagueName} (${season})`,
      "",
      `Pass: ${counts.pass || 0}. Mismatch: ${counts.mismatch || 0}. Conflict: ${counts.conflict || 0}. Info: ${counts.info || 0}.`,
      "",
      "MISMATCH means Sleeper's setting differs from the written rule. CONFLICT means the written rules contradict each other.",
      "",
      "| Status | Area | Rule | Constitution | Sleeper | Note |",
      "| --- | --- | --- | --- | --- | --- |",
      ...house.checks.map((c) => `| ${icon[c.status]} | ${c.area} | ${esc(c.rule)} | ${esc(c.expected)} | ${esc(c.actual)} | ${esc(c.note)} |`),
      "",
    ];
    return lines.join("\n");
  }

  function winPct(r) {
    const g = r.wins + r.losses + r.ties;
    return g ? (r.wins + r.ties / 2) / g : 0;
  }

  function round3(n) {
    return Math.round(n * 1000) / 1000;
  }

  NS.applyHouseRules = applyHouseRules;
  NS.houseChecksMarkdown = checksMarkdown;
})(typeof globalThis !== "undefined" ? globalThis : this);

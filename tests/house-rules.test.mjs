// Offline tests for house-rules-engine.js.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const f of ["collector.js", "transform.js", "house-rules.js", "house-rules-engine.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, "js", f), "utf8"), { filename: f });
}
const SD = globalThis.SleeperDump;

// Four teams. House rules scaled down: 1 seed by record + 1 points wildcard.
function setup() {
  const users = ["A", "B", "C", "D"].map((n) => ({ user_id: `u${n}`, display_name: n, metadata: {} }));
  const rec = { 1: [3, 1, 300, 330, 280], 2: [3, 1, 300, 320, 250], 3: [2, 2, 400, 450, 300], 4: [0, 4, 200, 260, 310] };
  const rosters = [1, 2, 3, 4].map((rid) => {
    const [w, l, pf, ppts, pa] = rec[rid];
    return { roster_id: rid, owner_id: `u${"ABCD"[rid - 1]}`, players: [], settings: { wins: w, losses: l, ties: 0, fpts: pf, ppts, fpts_against: pa } };
  });
  const league = {
    league_id: "L1", name: "House", season: "2025", status: "complete", total_rosters: 4,
    roster_positions: ["QB", "RB", "FLEX", "BN"], scoring_settings: { rec: 1, bonus_rec_te: 0.5, pass_td: 4, rush_td: 6, pass_int: -1, bonus_rec_yd_100: 1 },
    settings: { playoff_teams: 2, playoff_week_start: 3, playoff_round_type: 0, trade_review_days: 0, pick_trading: 1, taxi_slots: 5, reserve_slots: 3, last_scored_leg: 3 },
  };
  const season = {
    season: "2025", leagueId: "L1", league, users, rosters, drafts: [],
    tradedPicks: [
      { season: "2027", round: 1, roster_id: 4, previous_owner_id: 4, owner_id: 1 },
      { season: "2026", round: 2, roster_id: 4, previous_owner_id: 4, owner_id: 2 },
      { season: "2026", round: 1, roster_id: 2, previous_owner_id: 3, owner_id: 2 }, // back with original owner
    ],
    winnersBracket: [{ m: 1, r: 1, t1: 1, t2: 2, w: 2, l: 1, p: 1 }],
    losersBracket: [],
    transactionsByWeek: {},
    matchupsByWeek: {
      1: [
        { roster_id: 1, matchup_id: 1, points: 100, starters: ["q1", "0", "f1"], starters_points: [20, 0, 10] },
        { roster_id: 2, matchup_id: 1, points: 90, starters: ["q2", "r2", "f2"], starters_points: [0, 15, 12] },
      ],
    },
    lastCompletedWeek: 3,
  };
  const dataset = { exportedAt: "2026-01-01T00:00:00Z", rootLeagueId: "L1", players: { q2: { full_name: "QB Two" } }, seasons: [season] };
  const model = SD.buildModel(dataset);
  const rules = JSON.parse(JSON.stringify(SD.HOUSE_RULES));
  rules.rules.playoffs.byRecord = 1;
  rules.rules.playoffs.pointsWildcards = 1;
  rules.rules.playoffs.teams = 2;
  return SD.applyHouseRules(dataset, model, rules);
}

test("seeding: top by record with PF tiebreak, then points wildcard", () => {
  const h = setup();
  const s = Object.fromEntries(h.standings.map((r) => [r.manager, r]));
  // A and B are both 3-1 and tied on PF; Max PF (330 vs 320) breaks it for A.
  assert.equal(s.A.house_playoff_seed, 1);
  assert.equal(s.A.qualified_via, "record");
  // C is 2-2 but has the most PF among the rest, so takes the wildcard over B.
  assert.equal(s.C.house_playoff_seed, 2);
  assert.equal(s.C.qualified_via, "points_wildcard");
  assert.equal(s.B.house_playoff_seed, "");
  // Sleeper's bracket had A and B, so B and C disagree with the house formula.
  assert.equal(s.B.seeding_matches_sleeper, false);
  assert.equal(s.C.seeding_matches_sleeper, false);
});

test("rookie draft: non-playoff by lowest Max PF, then playoff by finish", () => {
  const h = setup();
  const order = h.draftOrder.map((d) => d.manager);
  // Non-playoff: D (Max PF 260) then B (320). House playoff team C never played
  // in Sleeper's bracket, so it has no finish and playoff teams fall back to worst seed first.
  assert.deepEqual(order, ["D", "B", "C", "A"]);
  assert.equal(h.draftOrder[0].status, "projected");
  assert.equal(h.draftOrder[0].draft_season, "2026");
});

test("lineups: empty slots are invalid, zero-point starters are flagged for review", () => {
  const h = setup();
  const empty = h.lineupIssues.find((i) => i.issue === "empty_slot");
  assert.equal(empty.manager, "A");
  assert.equal(empty.slot, "RB");
  const zero = h.lineupIssues.find((i) => i.issue === "zero_point_starter");
  assert.equal(zero.player_name, "QB Two");
  const a = h.lineupSummary.find((s) => s.manager === "A");
  assert.equal(a.invalid_weeks, 1);
  assert.equal(a.abandonment_threshold_reached, false);
});

test("dues: owners must prepay through the latest pick they traded away", () => {
  const h = setup();
  assert.equal(h.duesObligations.length, 1);
  const d = h.duesObligations[0];
  assert.equal(d.manager, "D");
  assert.equal(d.dues_required_through, 2027);
  assert.equal(d.amount_required_upfront, 100);
  assert.equal(d.beyond_trade_window, false);
});

test("settings check flags mismatches and the taxi conflict", () => {
  const h = setup();
  const by = (rule) => h.checks.find((c) => c.rule.startsWith(rule));
  assert.equal(by("TE points per reception").status, "pass");
  assert.equal(by("Interception thrown").status, "pass");
  assert.equal(by("Trades process instantly").status, "pass");
  assert.equal(by("Taxi slots").status, "conflict");
  assert.equal(by("Teams").status, "mismatch");
  assert.equal(by("Bench slots").status, "mismatch");
  const md = SD.houseChecksMarkdown(h, "House", "2025");
  assert.match(md, /CONFLICT \| Roster \| Taxi slots/);
});

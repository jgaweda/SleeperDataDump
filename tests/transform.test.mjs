// Offline tests for transform.js using a synthetic two-team season.
// Run: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const f of ["collector.js", "transform.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, "js", f), "utf8"), { filename: f });
}
const SD = globalThis.SleeperDump;

function fixture() {
  const league = {
    league_id: "L1", name: "Test League", season: "2025", status: "complete", total_rosters: 4,
    previous_league_id: null, roster_positions: ["QB", "RB", "BN"],
    scoring_settings: { rec: 1, pass_td: 4 },
    settings: { type: 2, waiver_type: 2, waiver_budget: 100, playoff_week_start: 3, playoff_teams: 2, last_scored_leg: 3, trade_deadline: 99 },
  };
  const users = [
    { user_id: "uA", display_name: "Alice", metadata: { team_name: "A Team" } },
    { user_id: "uB", display_name: "Bob", metadata: {} },
    { user_id: "uC", display_name: "Cara", metadata: {} },
    { user_id: "uD", display_name: "Dan", metadata: {} },
  ];
  const rosters = [1, 2, 3, 4].map((rid, i) => ({
    roster_id: rid, owner_id: users[i].user_id, players: ["p1"].slice(0, rid === 1 ? 1 : 0), starters: ["p1"],
    settings: { wins: 4 - rid, losses: rid - 1, ties: 0, fpts: 100 * (5 - rid), fpts_decimal: 50 },
  }));
  const mu = (week, pairs) => pairs.flatMap(([mid, a, pa, b, pb]) => [
    { roster_id: a, matchup_id: mid, points: pa }, { roster_id: b, matchup_id: mid, points: pb }]);
  const trade = {
    transaction_id: "T1", type: "trade", status: "complete", created: 1700000000000, creator: "uA",
    roster_ids: [1, 2], adds: { p1: 2, p2: 1 }, drops: { p1: 1, p2: 2 },
    draft_picks: [{ season: "2026", round: 1, roster_id: 1, previous_owner_id: 1, owner_id: 2 }],
    waiver_budget: [{ sender: 2, receiver: 1, amount: 15 }], settings: null, metadata: null,
  };
  const waiver = {
    transaction_id: "W1", type: "waiver", status: "complete", created: 1700000001000, creator: "uC",
    roster_ids: [3], adds: { p3: 3 }, drops: null, draft_picks: [], waiver_budget: [], settings: { waiver_bid: 22 },
  };
  const failed = { ...waiver, transaction_id: "W2", status: "failed" };
  return {
    exportedAt: "2025-12-01T00:00:00.000Z", rootLeagueId: "L1", userId: "uA",
    players: { p1: { full_name: "Player One", position: "RB", team: "PHI" }, p2: { full_name: "Player Two", position: "WR" }, p3: { full_name: "Player Three", position: "TE" } },
    seasons: [{
      season: "2025", leagueId: "L1", league, users, rosters, tradedPicks: [], drafts: [],
      winnersBracket: [{ m: 1, r: 1, t1: 1, t2: 2, w: 1, l: 2, p: 1 }],
      losersBracket: [{ m: 1, r: 1, t1: 3, t2: 4, w: 3, l: 4, p: 1 }],
      transactionsByWeek: { 1: [trade, waiver, failed] },
      matchupsByWeek: {
        1: mu(1, [[1, 1, 110, 2, 90], [2, 3, 80, 4, 80]]),
        2: mu(2, [[1, 1, 70, 3, 75], [2, 2, 100, 4, 60]]),
        3: mu(3, [[1, 1, 120, 2, 100], [2, 3, 90, 4, 85]]),
        4: mu(4, [[1, 1, 999, 2, 0]]), // beyond last completed week: must be ignored
      },
      lastCompletedWeek: 3,
    }],
  };
}

test("trade with players, pick, and FAAB produces correct asset movements", () => {
  const m = SD.buildModel(fixture());
  const items = m.tables.transactionItems.filter((i) => i.transaction_id === "T1");
  const p1 = items.find((i) => i.player_id === "p1");
  assert.equal(p1.from_manager, "Alice");
  assert.equal(p1.to_manager, "Bob");
  const pick = items.find((i) => i.asset_type === "pick");
  assert.equal(pick.asset_name, "2026 Round 1 (orig. Alice)");
  assert.equal(pick.to_manager, "Bob");
  const faab = items.find((i) => i.asset_type === "faab");
  assert.equal(faab.faab_amount, 15);
  assert.equal(faab.from_manager, "Bob");
  assert.equal(faab.to_manager, "Alice");

  const sides = m.tables.tradeSides.filter((s) => s.transaction_id === "T1");
  const alice = sides.find((s) => s.manager === "Alice");
  assert.match(alice.received_players, /Player Two/);
  assert.match(alice.sent_players, /Player One/);
  assert.match(alice.sent_picks, /2026 Round 1/);
  assert.equal(alice.received_faab, 15);
  assert.equal(m.tables.trades.length, 1);
});

test("failed transactions are listed but move no assets; waiver bids are kept", () => {
  const m = SD.buildModel(fixture());
  assert.equal(m.tables.transactions.length, 3);
  assert.ok(!m.tables.transactionItems.some((i) => i.transaction_id === "W2"));
  const w = m.tables.transactionItems.find((i) => i.transaction_id === "W1");
  assert.equal(w.waiver_bid, 22);
  assert.equal(w.from_manager, "Free agency / waivers");
});

test("matchups respect last completed week and classify playoff games", () => {
  const m = SD.buildModel(fixture());
  assert.ok(!m.tables.matchups.some((r) => r.week === 4));
  const wk3 = m.tables.matchups.filter((r) => r.week === 3);
  assert.equal(wk3.find((r) => r.roster_id === 1).game_type, "playoff");
  assert.equal(wk3.find((r) => r.roster_id === 3).game_type, "consolation");
  const tie = m.tables.matchups.find((r) => r.week === 1 && r.roster_id === 3);
  assert.equal(tie.result, "T");
});

test("head-to-head counts each game once and standings mark the champion", () => {
  const m = SD.buildModel(fixture());
  const ab = m.tables.headToHead.find((h) => [h.manager_a, h.manager_b].sort().join() === "Alice,Bob");
  assert.equal(ab.games, 2);
  assert.equal(ab.playoff_games, 1);
  const champ = m.tables.standings.find((s) => s.champion);
  assert.equal(champ.manager, "Alice");
  assert.equal(champ.points_for, 400.5);
  assert.equal(m.myTeam.summary.championships, 1);
  assert.equal(m.myTeam.summary.most_frequent_trade_partners[0].manager, "Bob");
});

test("rules markdown and CSV escaping", () => {
  const m = SD.buildModel(fixture());
  const md = m.rules["2025"];
  assert.match(md, /League type \| Dynasty/);
  assert.match(md, /FAAB budget \| \$100/);
  assert.match(md, /Trade deadline \| None/);
  assert.equal(SD.toCsv([{ a: 'x,"y"', b: 1 }]), 'a,b\n"x,""y""",1\n');
});

test("lastCompletedWeek handles in-season and pre-draft leagues", () => {
  const nfl = { season: "2026", league_season: "2026", season_type: "regular", week: 11 };
  assert.equal(SD.lastCompletedWeek({ season: "2026", status: "in_season", settings: { last_scored_leg: 11 } }, nfl), 10);
  assert.equal(SD.lastCompletedWeek({ season: "2026", status: "pre_draft", settings: {} }, nfl), 0);
  assert.equal(SD.lastCompletedWeek({ season: "2025", status: "complete", settings: { last_scored_leg: 17 } }, nfl), 17);
});

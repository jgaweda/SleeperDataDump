/*
 * League constitution ("house rules").
 *
 * `text` is the written constitution, included verbatim in every export that
 * applies house rules. `rules` is the machine-readable version the engine uses
 * to compute house standings, playoff seeds, rookie draft order, lineup
 * violations, dues obligations, and to check Sleeper's settings for drift.
 *
 * To pin these rules to a league so they apply automatically, add its
 * league_id (any season) to `leagueIds`.
 */
(function (root) {
  "use strict";

  const NS = (root.SleeperDump = root.SleeperDump || {});

  NS.HOUSE_RULES = {
    version: "2026.1",
    leagueIds: [],

    text: `# League Constitution

## Dues
- $50 per year, paid one year in advance, before the rookie draft. Unpaid teams risk replacement.

## Roster and scoring
- Starters: 1 QB, 2 RB, 2 WR, 1 TE, 3 FLEX, 1 SUPERFLEX. 15 bench, 5 taxi, 3 IR.
- Scoring: 1 PPR, 1.5 per TE reception, 4 pt passing TD, 6 pt rushing TD, -1 per interception, big play bonuses (see Sleeper).
- Rosters expand in the offseason and must be cut to 25 before Week 1.

## Lineups
- Lineups must be valid: no empty slots, no players on bye, no players ruled Out.
- Repeated failure results in removal.

## Trades
- Trades process instantly. Only obvious collusion is reversed, by league vote.
- Draft picks are tradable up to 2 years out. An owner trading a future pick must have dues paid through that pick's year.

## Taxi squad
- 6 slots, rookies only. Players stay on taxi until promoted.
- Taxi points count toward Max PF.

## Abandonment
- 2 invalid weeks: the league takes control of the team and starts a search for a new owner.
- While under league control, Sleeper projections set the lineup.

## Rookie draft
- 5 rounds, linear.
- Non-playoff teams pick in reverse order of Max PF. Playoff teams pick in order of finish.

## Playoffs
- 6 teams: the top 5 by record plus the highest points-for among the rest.
- Weeks 15 to 17.
- Tiebreakers, in order: record, points for, Max PF, points against.
- Prizes: $450 / $50.

## Trophy
- At the start of each season the previous champion ships the trophy to the new champion, who adds a new plaque.
`,

    rules: {
      teams: 10, // implied by $50 dues x teams = $500 prize pool
      dues: { amountPerYear: 50, paidYearsInAdvance: 1, deadline: "before rookie draft" },
      prizes: [450, 50],
      roster: {
        slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 3, SUPER_FLEX: 1, BN: 15 },
        taxiSlots: 5, // the Taxi section says 6; checked and reported as a conflict
        taxiSlotsAlt: 6,
        irSlots: 3,
        activeLimitWeek1: 25,
      },
      scoring: { rec: 1, teReceptionTotal: 1.5, pass_td: 4, rush_td: 6, pass_int: -1, bigPlayBonuses: true },
      trades: { instant: true, futurePickYears: 2 },
      taxi: { rookiesOnly: true, countsTowardMaxPF: true },
      abandonment: { invalidWeeks: 2 },
      draft: { rounds: 5, type: "linear", nonPlayoffOrder: "reverse_max_pf", playoffOrder: "finish" },
      playoffs: {
        teams: 6,
        byRecord: 5,
        pointsWildcards: 1,
        startWeek: 15,
        endWeek: 17,
        // Order applied after win percentage. PA direction is an assumption:
        // more points against (the unluckier team) wins the tiebreak.
        tiebreakers: ["points_for", "max_points_for", "points_against"],
        pointsAgainstHigherWins: true,
      },
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

/*
 * Transform: turns the raw collected dataset into analysis-ready tables.
 *
 * Design notes
 * - Managers are keyed by Sleeper user_id, which is stable across seasons.
 *   roster_id is only stable inside one season, so every table carries both.
 * - Only weeks <= season.lastCompletedWeek count toward results so an
 *   in-progress week never skews records or head-to-head numbers.
 * - These tables are the foundation for the future rivalry / weekly analysis
 *   app; keep column names stable and bump SCHEMA_VERSION on breaking changes.
 */
(function (root) {
  "use strict";

  const NS = (root.SleeperDump = root.SleeperDump || {});
  const SCHEMA_VERSION = "1.0.0";

  // ---------------------------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------------------------

  function buildModel(dataset) {
    const players = dataset.players || {};
    const referencedPlayers = new Set();
    const ref = (id) => {
      if (id) referencedPlayers.add(String(id));
      return id;
    };

    const seasons = dataset.seasons.map((s) => buildSeasonContext(s));
    const managers = buildManagers(seasons);

    const tables = {
      standings: [],
      matchups: [],
      transactions: [],
      transactionItems: [],
      trades: [],
      tradeSides: [],
      draftPicks: [],
      rosterPlayers: [],
      futurePickOwnership: [],
    };

    for (const ctx of seasons) {
      const placements = playoffPlacements(ctx.raw.winnersBracket);
      tables.standings.push(...standingsRows(ctx, placements));
      tables.matchups.push(...matchupRows(ctx));
      const tx = transactionRows(ctx, players, ref);
      tables.transactions.push(...tx.transactions);
      tables.transactionItems.push(...tx.items);
      tables.trades.push(...tx.trades);
      tables.tradeSides.push(...tx.tradeSides);
      tables.draftPicks.push(...draftPickRows(ctx, players, ref));
      tables.rosterPlayers.push(...rosterPlayerRows(ctx, players, ref));
      tables.futurePickOwnership.push(...pickOwnershipRows(ctx));
    }

    // Matchups also reference starters / bench players; keep them resolvable.
    for (const ctx of seasons) {
      for (const wk of Object.values(ctx.raw.matchupsByWeek)) {
        for (const m of wk) (m.players || []).forEach(ref);
      }
    }

    tables.headToHead = headToHeadRows(tables.matchups, managers);
    tables.managers = managerRows(managers, tables);

    const playersReferenced = {};
    for (const id of referencedPlayers) if (players[id]) playersReferenced[id] = players[id];

    const myTeam = dataset.userId ? buildMyTeam(dataset.userId, managers, tables, seasons) : null;

    return {
      schemaVersion: SCHEMA_VERSION,
      seasons,
      managers,
      tables,
      playersReferenced,
      myTeam,
      rules: Object.fromEntries(seasons.map((ctx) => [ctx.season, rulesMarkdown(ctx)])),
    };
  }

  // ---------------------------------------------------------------------------
  // Season context: roster_id -> manager lookups
  // ---------------------------------------------------------------------------

  function buildSeasonContext(raw) {
    const league = raw.league;
    const settings = league.settings || {};
    const usersById = new Map(raw.users.map((u) => [u.user_id, u]));
    const rosters = new Map();
    for (const r of raw.rosters) {
      const owner = r.owner_id ? usersById.get(r.owner_id) : null;
      const displayName = owner ? owner.display_name : r.owner_id ? `User ${r.owner_id}` : `Orphan roster ${r.roster_id}`;
      const teamName = (owner && owner.metadata && owner.metadata.team_name) || displayName;
      rosters.set(r.roster_id, {
        rosterId: r.roster_id,
        managerId: r.owner_id || null,
        coOwnerIds: r.co_owners || [],
        displayName,
        teamName,
        avatar: owner ? owner.avatar : null,
        raw: r,
      });
    }
    return {
      season: raw.season,
      leagueId: raw.leagueId,
      leagueName: league.name,
      settings,
      playoffWeekStart: Number(settings.playoff_week_start || 0),
      lastCompletedWeek: raw.lastCompletedWeek,
      rosters,
      usersById,
      raw,
      roster(rid) {
        return (
          rosters.get(Number(rid)) || {
            rosterId: rid,
            managerId: null,
            displayName: rid == null ? "" : `Roster ${rid}`,
            teamName: rid == null ? "" : `Roster ${rid}`,
          }
        );
      },
    };
  }

  function buildManagers(seasons) {
    const managers = new Map();
    // seasons are newest first, so the first name we see is the current one.
    for (const ctx of seasons) {
      for (const r of ctx.rosters.values()) {
        if (!r.managerId) continue;
        let m = managers.get(r.managerId);
        if (!m) {
          m = { managerId: r.managerId, displayName: r.displayName, avatar: r.avatar, seasons: [], teamNames: {} };
          managers.set(r.managerId, m);
        }
        m.seasons.push(ctx.season);
        m.teamNames[ctx.season] = r.teamName;
      }
    }
    return managers;
  }

  // ---------------------------------------------------------------------------
  // Standings & playoffs
  // ---------------------------------------------------------------------------

  /** Map roster_id -> final placement from the winners bracket placement games (p = 1, 3, 5...). */
  function playoffPlacements(bracket) {
    const out = new Map();
    for (const g of bracket || []) {
      if (!g.p || g.w == null) continue;
      out.set(g.w, g.p);
      if (g.l != null) out.set(g.l, g.p + 1);
    }
    return out;
  }

  function standingsRows(ctx, placements) {
    const rows = [...ctx.rosters.values()].map((r) => {
      const s = r.raw.settings || {};
      return {
        season: ctx.season,
        league_id: ctx.leagueId,
        roster_id: r.rosterId,
        manager_id: r.managerId || "",
        manager: r.displayName,
        team_name: r.teamName,
        wins: s.wins || 0,
        losses: s.losses || 0,
        ties: s.ties || 0,
        points_for: pts(s.fpts, s.fpts_decimal),
        points_against: pts(s.fpts_against, s.fpts_against_decimal),
        max_points_for: pts(s.ppts, s.ppts_decimal),
        waiver_budget_used: s.waiver_budget_used || 0,
        total_moves: s.total_moves || 0,
        record_string: (r.raw.metadata && r.raw.metadata.record) || "",
        regular_season_rank: 0,
        playoff_finish: placements.get(r.rosterId) || "",
        champion: placements.get(r.rosterId) === 1,
      };
    });
    rows.sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.points_for - a.points_for);
    rows.forEach((r, i) => (r.regular_season_rank = i + 1));
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Matchups (one row per team per game)
  // ---------------------------------------------------------------------------

  function matchupRows(ctx) {
    const rows = [];
    const winnerPairs = bracketPairs(ctx.raw.winnersBracket);
    const loserPairs = bracketPairs(ctx.raw.losersBracket);

    for (const [weekStr, entries] of Object.entries(ctx.raw.matchupsByWeek)) {
      const week = Number(weekStr);
      if (week > ctx.lastCompletedWeek) continue;
      const groups = new Map();
      for (const e of entries) {
        if (e.matchup_id == null) continue;
        if (!groups.has(e.matchup_id)) groups.set(e.matchup_id, []);
        groups.get(e.matchup_id).push(e);
      }
      for (const [matchupId, teams] of groups) {
        if (teams.length !== 2) continue;
        const [a, b] = teams;
        const key = pairKey(a.roster_id, b.roster_id);
        let gameType = "regular";
        if (ctx.playoffWeekStart && week >= ctx.playoffWeekStart) {
          gameType = winnerPairs.has(key) ? "playoff" : loserPairs.has(key) ? "consolation" : "playoff_week_other";
        }
        for (const [me, opp] of [[a, b], [b, a]]) {
          const mr = ctx.roster(me.roster_id);
          const or = ctx.roster(opp.roster_id);
          const p = score(me);
          const op = score(opp);
          rows.push({
            season: ctx.season,
            week,
            game_type: gameType,
            matchup_id: matchupId,
            roster_id: me.roster_id,
            manager_id: mr.managerId || "",
            manager: mr.displayName,
            team_name: mr.teamName,
            points: p,
            opponent_roster_id: opp.roster_id,
            opponent_manager_id: or.managerId || "",
            opponent_manager: or.displayName,
            opponent_team_name: or.teamName,
            opponent_points: op,
            margin: round2(p - op),
            result: p > op ? "W" : p < op ? "L" : "T",
          });
        }
      }
    }
    rows.sort((x, y) => Number(y.season) - Number(x.season) || x.week - y.week || x.matchup_id - y.matchup_id);
    return rows;
  }

  function bracketPairs(bracket) {
    const s = new Set();
    for (const g of bracket || []) if (g.t1 != null && g.t2 != null) s.add(pairKey(g.t1, g.t2));
    return s;
  }

  // ---------------------------------------------------------------------------
  // Head to head (rivalries backbone): one row per manager pair, all seasons
  // ---------------------------------------------------------------------------

  function headToHeadRows(matchups, managers) {
    const pairs = new Map();
    for (const m of matchups) {
      if (!m.manager_id || !m.opponent_manager_id) continue;
      if (m.manager_id > m.opponent_manager_id) continue; // count each game once
      const key = `${m.manager_id}|${m.opponent_manager_id}`;
      let p = pairs.get(key);
      if (!p) {
        p = {
          manager_a_id: m.manager_id,
          manager_a: nameOf(managers, m.manager_id, m.manager),
          manager_b_id: m.opponent_manager_id,
          manager_b: nameOf(managers, m.opponent_manager_id, m.opponent_manager),
          games: 0, a_wins: 0, b_wins: 0, ties: 0,
          a_points: 0, b_points: 0,
          regular_season_games: 0, playoff_games: 0,
          a_playoff_wins: 0, b_playoff_wins: 0,
          biggest_a_win_margin: 0, biggest_b_win_margin: 0,
          last_meeting: "", last_winner: "",
          _last: -1,
        };
        pairs.set(key, p);
      }
      p.games++;
      p.a_points += m.points;
      p.b_points += m.opponent_points;
      if (m.result === "W") p.a_wins++;
      else if (m.result === "L") p.b_wins++;
      else p.ties++;
      if (m.game_type === "regular") p.regular_season_games++;
      if (m.game_type === "playoff") {
        p.playoff_games++;
        if (m.result === "W") p.a_playoff_wins++;
        if (m.result === "L") p.b_playoff_wins++;
      }
      if (m.margin > p.biggest_a_win_margin) p.biggest_a_win_margin = m.margin;
      if (-m.margin > p.biggest_b_win_margin) p.biggest_b_win_margin = -m.margin;
      const order = Number(m.season) * 100 + m.week;
      if (order > p._last) {
        p._last = order;
        p.last_meeting = `${m.season} W${m.week}`;
        p.last_winner = m.result === "W" ? p.manager_a : m.result === "L" ? p.manager_b : "Tie";
      }
    }
    return [...pairs.values()]
      .map((p) => {
        delete p._last;
        p.a_points = round2(p.a_points);
        p.b_points = round2(p.b_points);
        p.avg_margin_abs = p.games ? round2(Math.abs(p.a_points - p.b_points) / p.games) : 0;
        return p;
      })
      .sort((x, y) => y.games - x.games || x.avg_margin_abs - y.avg_margin_abs);
  }

  // ---------------------------------------------------------------------------
  // Transactions, trades, waiver / FA moves
  // ---------------------------------------------------------------------------

  function transactionRows(ctx, players, ref) {
    const transactions = [];
    const items = [];
    const trades = [];
    const tradeSides = [];

    const all = [];
    for (const [week, list] of Object.entries(ctx.raw.transactionsByWeek)) {
      for (const t of list) all.push({ week: Number(week), t });
    }
    all.sort((a, b) => (a.t.created || 0) - (b.t.created || 0));

    for (const { week, t } of all) {
      const date = t.created ? new Date(t.created).toISOString() : "";
      const adds = t.adds || {};
      const drops = t.drops || {};
      const picks = t.draft_picks || [];
      const faab = t.waiver_budget || [];
      const bid = t.settings && t.settings.waiver_bid != null ? t.settings.waiver_bid : "";
      const creator = t.creator ? ctx.usersById.get(t.creator) : null;
      const base = {
        season: ctx.season,
        week,
        transaction_id: t.transaction_id,
        date_utc: date,
        type: t.type,
        status: t.status,
      };

      transactions.push({
        ...base,
        creator: creator ? creator.display_name : t.creator || "",
        rosters_involved: (t.roster_ids || []).map((r) => ctx.roster(r).displayName).join(" | "),
        adds: Object.entries(adds).map(([p, r]) => `${playerLabel(players, ref(p))} -> ${ctx.roster(r).displayName}`).join("; "),
        drops: Object.entries(drops).map(([p, r]) => `${playerLabel(players, ref(p))} <- ${ctx.roster(r).displayName}`).join("; "),
        draft_picks: picks.map((pk) => `${pickLabel(ctx, pk)} -> ${ctx.roster(pk.owner_id).displayName}`).join("; "),
        faab_transfers: faab.map((f) => `$${f.amount} ${ctx.roster(f.sender).displayName} -> ${ctx.roster(f.receiver).displayName}`).join("; "),
        waiver_bid: bid,
        notes: (t.metadata && t.metadata.notes) || "",
      });

      // Asset-level movements only for transactions that actually happened.
      if (t.status !== "complete") continue;

      const itemBase = { ...base, waiver_bid: bid };
      for (const [pid, toRid] of Object.entries(adds)) {
        const fromRid = drops[pid] != null && drops[pid] !== toRid ? drops[pid] : null;
        items.push(assetItem(ctx, players, itemBase, "player", pid, fromRid, toRid));
      }
      for (const [pid, fromRid] of Object.entries(drops)) {
        if (adds[pid] != null) continue; // already captured as a move
        items.push(assetItem(ctx, players, itemBase, "player", pid, fromRid, null));
      }
      for (const pk of picks) {
        const it = assetItem(ctx, players, itemBase, "pick", "", pk.previous_owner_id, pk.owner_id);
        it.asset_name = pickLabel(ctx, pk);
        it.pick_season = pk.season;
        it.pick_round = pk.round;
        it.pick_original_roster_id = pk.roster_id;
        it.pick_original_manager = ctx.roster(pk.roster_id).displayName;
        items.push(it);
      }
      for (const f of faab) {
        const it = assetItem(ctx, players, itemBase, "faab", "", f.sender, f.receiver);
        it.asset_name = `$${f.amount} FAAB`;
        it.faab_amount = f.amount;
        items.push(it);
      }

      if (t.type === "trade") {
        const sides = (t.roster_ids || []).map((rid) => {
          const r = ctx.roster(rid);
          const got = (pred) => Object.entries(adds).filter(([, to]) => pred(to)).map(([p]) => playerLabel(players, p));
          const gave = Object.entries(drops).filter(([p, from]) => from === rid && adds[p] !== rid).map(([p]) => playerLabel(players, p));
          const picksIn = picks.filter((pk) => pk.owner_id === rid).map((pk) => pickLabel(ctx, pk));
          const picksOut = picks.filter((pk) => pk.previous_owner_id === rid).map((pk) => pickLabel(ctx, pk));
          const faabIn = faab.filter((f) => f.receiver === rid).reduce((s, f) => s + f.amount, 0);
          const faabOut = faab.filter((f) => f.sender === rid).reduce((s, f) => s + f.amount, 0);
          const partners = (t.roster_ids || []).filter((x) => x !== rid).map((x) => ctx.roster(x).displayName);
          return {
            season: ctx.season,
            week,
            transaction_id: t.transaction_id,
            date_utc: date,
            roster_id: rid,
            manager_id: r.managerId || "",
            manager: r.displayName,
            team_name: r.teamName,
            trade_partners: partners.join(" | "),
            received_players: got((to) => to === rid).join("; "),
            received_picks: picksIn.join("; "),
            received_faab: faabIn,
            sent_players: gave.join("; "),
            sent_picks: picksOut.join("; "),
            sent_faab: faabOut,
          };
        });
        tradeSides.push(...sides);
        trades.push({
          season: ctx.season,
          week,
          transaction_id: t.transaction_id,
          date_utc: date,
          teams: sides.map((s) => s.manager).join(" | "),
          summary: sides
            .map((s) => {
              const parts = [s.received_players, s.received_picks, s.received_faab ? `$${s.received_faab} FAAB` : ""].filter(Boolean);
              return `${s.manager} receives: ${parts.join("; ") || "nothing"}`;
            })
            .join(" || "),
        });
      }
    }
    return { transactions, items, trades, tradeSides };
  }

  function assetItem(ctx, players, base, assetType, pid, fromRid, toRid) {
    const p = pid ? players[pid] || {} : {};
    const from = fromRid != null ? ctx.roster(fromRid) : null;
    const to = toRid != null ? ctx.roster(toRid) : null;
    return {
      ...base,
      asset_type: assetType,
      player_id: pid || "",
      asset_name: pid ? p.full_name || pid : "",
      position: p.position || "",
      nfl_team_current: p.team || "",
      from_roster_id: fromRid ?? "",
      from_manager_id: (from && from.managerId) || "",
      from_manager: from ? from.displayName : assetType === "player" ? "Free agency / waivers" : "",
      to_roster_id: toRid ?? "",
      to_manager_id: (to && to.managerId) || "",
      to_manager: to ? to.displayName : assetType === "player" ? "Released" : "",
      pick_season: "",
      pick_round: "",
      pick_original_roster_id: "",
      pick_original_manager: "",
      faab_amount: "",
    };
  }

  // ---------------------------------------------------------------------------
  // Drafts, rosters, traded picks
  // ---------------------------------------------------------------------------

  function draftPickRows(ctx, players, ref) {
    const rows = [];
    for (const d of ctx.raw.drafts) {
      for (const pk of d.picks) {
        const p = players[ref(pk.player_id)] || {};
        const md = pk.metadata || {};
        const r = ctx.roster(pk.roster_id);
        rows.push({
          season: ctx.season,
          draft_id: d.draft.draft_id,
          draft_type: d.draft.type,
          draft_status: d.draft.status,
          round: pk.round,
          pick_no: pk.pick_no,
          draft_slot: pk.draft_slot,
          roster_id: pk.roster_id,
          manager_id: r.managerId || pk.picked_by || "",
          manager: r.displayName,
          player_id: pk.player_id,
          player_name: p.full_name || [md.first_name, md.last_name].filter(Boolean).join(" "),
          position: md.position || p.position || "",
          nfl_team_at_draft: md.team || "",
          is_keeper: pk.is_keeper ? true : "",
          auction_amount: md.amount || "",
        });
      }
    }
    return rows;
  }

  function rosterPlayerRows(ctx, players, ref) {
    const rows = [];
    for (const r of ctx.rosters.values()) {
      const raw = r.raw;
      const starters = new Set(raw.starters || []);
      const reserve = new Set(raw.reserve || []);
      const taxi = new Set(raw.taxi || []);
      const keepers = new Set(raw.keepers || []);
      for (const pid of raw.players || []) {
        const p = players[ref(pid)] || {};
        rows.push({
          season: ctx.season,
          roster_id: r.rosterId,
          manager_id: r.managerId || "",
          manager: r.displayName,
          team_name: r.teamName,
          player_id: pid,
          player_name: p.full_name || pid,
          position: p.position || "",
          nfl_team_current: p.team || "",
          slot: starters.has(pid) ? "starter" : reserve.has(pid) ? "injured_reserve" : taxi.has(pid) ? "taxi" : "bench",
          keeper: keepers.has(pid) ? true : "",
        });
      }
    }
    return rows;
  }

  /** Current ownership of traded draft picks (future and past seasons). */
  function pickOwnershipRows(ctx) {
    return (ctx.raw.tradedPicks || []).map((pk) => ({
      as_of_season: ctx.season,
      pick_season: pk.season,
      round: pk.round,
      original_roster_id: pk.roster_id,
      original_manager: ctx.roster(pk.roster_id).displayName,
      previous_owner_roster_id: pk.previous_owner_id,
      previous_owner: ctx.roster(pk.previous_owner_id).displayName,
      current_owner_roster_id: pk.owner_id,
      current_owner: ctx.roster(pk.owner_id).displayName,
    }));
  }

  // ---------------------------------------------------------------------------
  // Managers (all-time) and "my team"
  // ---------------------------------------------------------------------------

  function managerRows(managers, tables) {
    const rows = [];
    for (const m of managers.values()) {
      const st = tables.standings.filter((s) => s.manager_id === m.managerId);
      const playoffs = tables.matchups.filter((x) => x.manager_id === m.managerId && x.game_type === "playoff");
      const sum = (k) => round2(st.reduce((a, s) => a + (Number(s[k]) || 0), 0));
      rows.push({
        manager_id: m.managerId,
        display_name: m.displayName,
        seasons_played: m.seasons.length,
        seasons: [...m.seasons].sort().join(" "),
        current_team_name: m.teamNames[m.seasons[0]] || "",
        team_name_history: [...new Set(Object.values(m.teamNames))].join(" | "),
        wins: sum("wins"),
        losses: sum("losses"),
        ties: sum("ties"),
        points_for: sum("points_for"),
        points_against: sum("points_against"),
        championships: st.filter((s) => s.champion).length,
        championship_seasons: st.filter((s) => s.champion).map((s) => s.season).join(" "),
        playoff_appearances: new Set(playoffs.map((x) => x.season)).size,
        playoff_wins: playoffs.filter((x) => x.result === "W").length,
        playoff_losses: playoffs.filter((x) => x.result === "L").length,
        trades: new Set(tables.tradeSides.filter((t) => t.manager_id === m.managerId).map((t) => t.transaction_id)).size,
        avatar_url: m.avatar ? `https://sleepercdn.com/avatars/${m.avatar}` : "",
      });
    }
    return rows.sort((a, b) => b.championships - a.championships || b.wins - a.wins);
  }

  function buildMyTeam(userId, managers, tables, seasons) {
    const me = managers.get(userId);
    const isMe = (id) => id === userId;
    const mySeasons = tables.standings.filter((s) => isMe(s.manager_id));
    // Co-owned rosters still count as "my team".
    for (const ctx of seasons) {
      for (const r of ctx.rosters.values()) {
        if (r.coOwnerIds.includes(userId) && !mySeasons.some((s) => s.season === ctx.season)) {
          const row = tables.standings.find((s) => s.season === ctx.season && s.roster_id === r.rosterId);
          if (row) mySeasons.push(row);
        }
      }
    }
    const myRoster = new Map(mySeasons.map((s) => [s.season, s.roster_id]));
    const mine = (season, rid) => myRoster.get(season) === Number(rid) && rid !== "";

    const rivals = tables.headToHead
      .filter((h) => isMe(h.manager_a_id) || isMe(h.manager_b_id))
      .map((h) => {
        const a = isMe(h.manager_a_id);
        return {
          opponent_id: a ? h.manager_b_id : h.manager_a_id,
          opponent: a ? h.manager_b : h.manager_a,
          games: h.games,
          wins: a ? h.a_wins : h.b_wins,
          losses: a ? h.b_wins : h.a_wins,
          ties: h.ties,
          points_for: a ? h.a_points : h.b_points,
          points_against: a ? h.b_points : h.a_points,
          playoff_games: h.playoff_games,
          last_meeting: h.last_meeting,
          last_winner: h.last_winner,
        };
      });

    const tradeIds = new Set(
      tables.tradeSides.filter((t) => mine(t.season, t.roster_id)).map((t) => t.transaction_id)
    );
    const partnerCounts = {};
    for (const t of tables.tradeSides) {
      if (tradeIds.has(t.transaction_id) && !mine(t.season, t.roster_id)) {
        partnerCounts[t.manager] = (partnerCounts[t.manager] || 0) + 1;
      }
    }

    const sum = (k) => round2(mySeasons.reduce((a, s) => a + (Number(s[k]) || 0), 0));
    const latest = [...mySeasons].sort((a, b) => Number(b.season) - Number(a.season))[0];

    return {
      managerId: userId,
      displayName: me ? me.displayName : "",
      found: mySeasons.length > 0,
      summary: {
        seasons: mySeasons.length,
        wins: sum("wins"),
        losses: sum("losses"),
        ties: sum("ties"),
        points_for: sum("points_for"),
        points_against: sum("points_against"),
        championships: mySeasons.filter((s) => s.champion).length,
        trades: tradeIds.size,
        most_frequent_trade_partners: Object.entries(partnerCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([manager, trades]) => ({ manager, trades })),
      },
      seasons: mySeasons.sort((a, b) => Number(b.season) - Number(a.season)),
      rivals,
      matchups: tables.matchups.filter((m) => mine(m.season, m.roster_id)),
      transactionItems: tables.transactionItems.filter(
        (t) => mine(t.season, t.from_roster_id) || mine(t.season, t.to_roster_id)
      ),
      tradeSides: tables.tradeSides.filter((t) => tradeIds.has(t.transaction_id)),
      currentRoster: latest
        ? tables.rosterPlayers.filter((p) => p.season === latest.season && p.roster_id === latest.roster_id)
        : [],
      draftPicks: tables.draftPicks.filter((d) => mine(d.season, d.roster_id)),
    };
  }

  // ---------------------------------------------------------------------------
  // Human readable league rules
  // ---------------------------------------------------------------------------

  const LEAGUE_TYPES = { 0: "Redraft", 1: "Keeper", 2: "Dynasty" };
  const WAIVER_TYPES = { 0: "Rolling waivers", 1: "Reverse standings", 2: "FAAB bidding" };
  const PLAYOFF_ROUND_TYPES = { 0: "One week per round", 1: "Two-week championship", 2: "Two weeks per round" };
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  const SCORING_LABELS = {
    pass_yd: "Passing yards (per yard)", pass_td: "Passing TD", pass_int: "Interception thrown",
    pass_2pt: "Passing 2-pt conversion", pass_cmp: "Pass completion", pass_inc: "Incomplete pass",
    pass_att: "Pass attempt", pass_sack: "Sacked", pass_fd: "Passing first down",
    pass_int_td: "Pick six thrown", pass_td_40p: "40+ yd passing TD bonus", pass_td_50p: "50+ yd passing TD bonus",
    bonus_pass_yd_300: "300-399 passing yards bonus", bonus_pass_yd_400: "400+ passing yards bonus",
    rush_yd: "Rushing yards (per yard)", rush_td: "Rushing TD", rush_2pt: "Rushing 2-pt conversion",
    rush_att: "Rush attempt", rush_fd: "Rushing first down", rush_td_40p: "40+ yd rushing TD bonus",
    bonus_rush_yd_100: "100-199 rushing yards bonus", bonus_rush_yd_200: "200+ rushing yards bonus",
    rec: "Reception (PPR)", rec_yd: "Receiving yards (per yard)", rec_td: "Receiving TD",
    rec_2pt: "Receiving 2-pt conversion", rec_fd: "Receiving first down", rec_td_40p: "40+ yd receiving TD bonus",
    bonus_rec_te: "TE reception bonus (TE premium)", bonus_rec_rb: "RB reception bonus", bonus_rec_wr: "WR reception bonus",
    bonus_rec_yd_100: "100-199 receiving yards bonus", bonus_rec_yd_200: "200+ receiving yards bonus",
    fum: "Fumble", fum_lost: "Fumble lost", fum_rec_td: "Fumble recovery TD",
    fgm: "FG made", fgm_0_19: "FG made 0-19", fgm_20_29: "FG made 20-29", fgm_30_39: "FG made 30-39",
    fgm_40_49: "FG made 40-49", fgm_50p: "FG made 50+", fgm_50_59: "FG made 50-59", fgm_60p: "FG made 60+",
    fgm_yds: "FG made (per yard)", fgmiss: "FG missed", fgmiss_0_19: "FG missed 0-19", fgmiss_20_29: "FG missed 20-29",
    fgmiss_30_39: "FG missed 30-39", fgmiss_40_49: "FG missed 40-49", fgmiss_50p: "FG missed 50+",
    xpm: "Extra point made", xpmiss: "Extra point missed",
    def_td: "Defense TD", st_td: "Special teams TD", def_st_td: "DEF/ST TD", def_st_ff: "DEF/ST forced fumble",
    def_st_fum_rec: "DEF/ST fumble recovery", st_ff: "Special teams forced fumble", st_fum_rec: "Special teams fumble recovery",
    sack: "Sack", int: "Interception", fum_rec: "Fumble recovery", ff: "Forced fumble", safe: "Safety",
    blk_kick: "Blocked kick", def_2pt: "Defensive 2-pt return",
    pts_allow_0: "Points allowed 0", pts_allow_1_6: "Points allowed 1-6", pts_allow_7_13: "Points allowed 7-13",
    pts_allow_14_20: "Points allowed 14-20", pts_allow_21_27: "Points allowed 21-27",
    pts_allow_28_34: "Points allowed 28-34", pts_allow_35p: "Points allowed 35+",
    yds_allow_0_100: "Yards allowed 0-99", yds_allow_100_199: "Yards allowed 100-199",
    yds_allow_200_299: "Yards allowed 200-299", yds_allow_300_349: "Yards allowed 300-349",
    yds_allow_350_399: "Yards allowed 350-399", yds_allow_400_449: "Yards allowed 400-449",
    yds_allow_450_499: "Yards allowed 450-499", yds_allow_500_549: "Yards allowed 500-549", yds_allow_550p: "Yards allowed 550+",
    tkl: "Tackle", tkl_solo: "Solo tackle", tkl_ast: "Assisted tackle", tkl_loss: "Tackle for loss",
    qb_hit: "QB hit", pass_def: "Pass defended", idp_tkl: "IDP tackle", idp_sack: "IDP sack", idp_int: "IDP interception",
    kr_yd: "Kick return yards", pr_yd: "Punt return yards",
  };

  function rulesMarkdown(ctx) {
    const L = ctx.raw.league;
    const s = ctx.settings;
    const yes = (v) => (v ? "Yes" : "No");
    const lines = [];
    lines.push(`# ${L.name}: ${L.season} league rules and settings`, "");
    lines.push(`League ID: \`${L.league_id}\`  `);
    if (L.previous_league_id && L.previous_league_id !== "0") lines.push(`Previous season league ID: \`${L.previous_league_id}\`  `);
    lines.push(`Status: ${L.status}  `, "");

    lines.push("## Format", "");
    lines.push(table(["Setting", "Value"], [
      ["League type", LEAGUE_TYPES[s.type] || s.type],
      ["Teams", L.total_rosters || s.num_teams],
      ["Scoring type", (L.metadata && L.metadata.scoring_type) || inferScoring(L.scoring_settings)],
      ["Best ball", yes(s.best_ball)],
      ["Extra game vs league median", yes(s.league_average_match)],
      ["Season start week", s.start_week],
      ["Max keepers", s.type === 1 ? s.max_keepers : "n/a"],
    ]), "");

    lines.push("## Roster", "");
    const counts = {};
    for (const p of L.roster_positions || []) counts[p] = (counts[p] || 0) + 1;
    lines.push(table(["Slot", "Count"], Object.entries(counts).map(([k, v]) => [slotLabel(k), v])), "");
    lines.push(table(["Setting", "Value"], [
      ["IR slots", s.reserve_slots || 0],
      ["IR allows OUT / Doubtful / Suspended / NA / COVID", [s.reserve_allow_out, s.reserve_allow_doubtful, s.reserve_allow_sus, s.reserve_allow_na, s.reserve_allow_cov].map(yes).join(" / ")],
      ["Taxi slots", s.taxi_slots || 0],
      ["Taxi max years / allow vets", `${s.taxi_years || 0} / ${yes(s.taxi_allow_vets)}`],
      ["Position limits (QB/RB/WR/TE/K/DEF)", ["qb", "rb", "wr", "te", "k", "def"].map((p) => s[`position_limit_${p}`] || "-").join(" / ")],
    ]), "");

    lines.push("## Waivers and free agency", "");
    lines.push(table(["Setting", "Value"], [
      ["Waiver type", WAIVER_TYPES[s.waiver_type] || s.waiver_type],
      ["FAAB budget", s.waiver_type === 2 ? `$${s.waiver_budget}` : "n/a"],
      ["Minimum bid", s.waiver_type === 2 ? `$${s.waiver_bid_min || 0}` : "n/a"],
      ["Waivers process", s.daily_waivers ? `Daily at ${s.daily_waivers_hour}:00` : DAYS[s.waiver_day_of_week] || s.waiver_day_of_week],
      ["Waiver clear days", s.waiver_clear_days],
      ["Free agent adds disabled", yes(s.disable_adds)],
      ["Offseason adds allowed", yes(s.offseason_adds)],
    ]), "");

    lines.push("## Trades", "");
    lines.push(table(["Setting", "Value"], [
      ["Trades disabled", yes(s.disable_trades)],
      ["Trade deadline", s.trade_deadline >= 99 ? "None" : `Week ${s.trade_deadline}`],
      ["Trade review days", s.trade_review_days],
      ["Draft pick trading", yes(s.pick_trading)],
      ["Veto votes needed", s.veto_votes_needed || "n/a"],
      ["Auto veto poll", yes(s.veto_auto_poll)],
    ]), "");

    lines.push("## Playoffs", "");
    lines.push(table(["Setting", "Value"], [
      ["Playoff teams", s.playoff_teams],
      ["Playoff start week", s.playoff_week_start],
      ["Round format", PLAYOFF_ROUND_TYPES[s.playoff_round_type] || s.playoff_round_type],
      ["Re-seed each round", yes(s.playoff_seed_type === 1)],
    ]), "");

    lines.push("## Scoring", "");
    const scoring = Object.entries(L.scoring_settings || {}).sort((a, b) => a[0].localeCompare(b[0]));
    lines.push(table(["Stat", "Key", "Points"], scoring.map(([k, v]) => [SCORING_LABELS[k] || k, `\`${k}\``, v])), "");

    lines.push("## Raw settings", "");
    lines.push("Every raw value from the Sleeper `settings` object. See `league.json` for the full league payload.", "");
    lines.push(table(["Key", "Value"], Object.entries(s).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [`\`${k}\``, v])), "");
    return lines.join("\n");
  }

  function inferScoring(sc) {
    const rec = (sc && sc.rec) || 0;
    return rec >= 1 ? "PPR" : rec >= 0.5 ? "Half PPR" : "Standard";
  }

  function slotLabel(k) {
    return { BN: "Bench", FLEX: "FLEX (RB/WR/TE)", SUPER_FLEX: "Superflex (QB/RB/WR/TE)", REC_FLEX: "Flex (WR/TE)", WRRB_FLEX: "Flex (RB/WR)", IDP_FLEX: "IDP Flex" }[k] || k;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function table(headers, rows) {
    const esc = (v) => String(v ?? "").replace(/\|/g, "\\|");
    return [
      `| ${headers.join(" | ")} |`,
      `| ${headers.map(() => "---").join(" | ")} |`,
      ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
    ].join("\n");
  }

  function playerLabel(players, id) {
    const p = players[id];
    if (!p) return String(id);
    const meta = [p.position, p.team].filter(Boolean).join(", ");
    return meta ? `${p.full_name} (${meta})` : p.full_name;
  }

  function pickLabel(ctx, pk) {
    return `${pk.season} Round ${pk.round} (orig. ${ctx.roster(pk.roster_id).displayName})`;
  }

  function nameOf(managers, id, fallback) {
    const m = managers.get(id);
    return m ? m.displayName : fallback;
  }

  function score(m) {
    return round2(m.custom_points != null ? m.custom_points : m.points || 0);
  }

  function pts(whole, dec) {
    return round2((whole || 0) + (dec || 0) / 100);
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function pairKey(a, b) {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  }

  /** RFC 4180 CSV. Column order follows the first row's keys. */
  function toCsv(rows, columns) {
    if (!rows || !rows.length) return columns ? columns.join(",") + "\n" : "";
    const cols = columns || Object.keys(rows[0]);
    const esc = (v) => {
      if (v === null || v === undefined) return "";
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
  }

  NS.buildModel = buildModel;
  NS.toCsv = toCsv;
  NS.rulesMarkdown = rulesMarkdown;
  NS.SCHEMA_VERSION = SCHEMA_VERSION;
})(typeof globalThis !== "undefined" ? globalThis : this);

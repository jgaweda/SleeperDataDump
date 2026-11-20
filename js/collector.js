/*
 * Collector: pulls every raw dataset Sleeper exposes for a league, optionally
 * walking back through prior seasons via `previous_league_id`.
 *
 * Output is a plain "dataset" object of raw API responses. Nothing here
 * reshapes data; transforms live in transform.js so raw data is always
 * preserved verbatim in the export.
 */
(function (root) {
  "use strict";

  const NS = (root.SleeperDump = root.SleeperDump || {});

  // NFL regular season + playoffs never exceeds 18 weeks.
  const MAX_WEEK = 18;

  // Fields kept from /players/nfl for name lookups. Keeps the cache ~2-3 MB instead of ~15 MB.
  const PLAYER_FIELDS = [
    "full_name", "first_name", "last_name", "position", "fantasy_positions", "team",
    "age", "birth_date", "years_exp", "status", "injury_status", "college", "number",
    "height", "weight", "depth_chart_position",
  ];

  /**
   * @param {SleeperClient} client
   * @param {object} opts
   * @param {string} opts.leagueId              league to export (most recent season to include)
   * @param {string} [opts.userId]              user whose team gets the "my_team" view
   * @param {boolean} [opts.includeHistory=true] follow previous_league_id back through prior seasons
   * @param {boolean} [opts.includeFullPlayers=false] keep the full raw /players/nfl payload
   * @param {object} [opts.playerCache]         { get(): Promise<obj|null>, set(obj): Promise } 24h cache
   * @param {function} [opts.onProgress]        ({message, done, total}) => void
   */
  async function collectLeague(client, opts) {
    const onProgress = opts.onProgress || (() => {});
    const progress = { done: 0, total: 0 };
    const report = (message) => onProgress({ message, done: progress.done, total: progress.total });
    const track = (promise) => {
      progress.total++;
      return promise.finally(() => {
        progress.done++;
        report();
      });
    };

    report("Reading NFL state");
    const nflState = await track(client.getNflState());

    // 1. Discover the season chain.
    const chain = [];
    let nextId = opts.leagueId;
    const seen = new Set();
    while (nextId && nextId !== "0" && !seen.has(nextId)) {
      seen.add(nextId);
      const league = await track(client.getLeague(nextId));
      if (!league) {
        if (!chain.length) throw new NS.SleeperApiError(`League ${nextId} not found`, 404, "/league");
        break;
      }
      chain.push(league);
      report(`Found ${league.season} season: ${league.name}`);
      if (opts.includeHistory === false) break;
      nextId = league.previous_league_id;
    }

    // 2. Pull every season in parallel (the client enforces the rate limit).
    const seasons = await Promise.all(chain.map((league) => collectSeason(client, league, nflState, track, report)));

    // 3. Player directory (cached for 24h per Sleeper's guidance).
    report("Loading NFL player directory");
    const cached = opts.playerCache ? await safe(() => opts.playerCache.get()) : null;
    let players = cached && cached.slim;
    let playersFull = (cached && cached.full) || null;
    if (!players || (opts.includeFullPlayers && !playersFull)) {
      playersFull = (await track(client.getAllPlayers())) || {};
      players = slimPlayers(playersFull);
      if (opts.playerCache) {
        const toCache = { slim: players, full: opts.includeFullPlayers ? playersFull : null };
        await safe(() => opts.playerCache.set(toCache));
      }
    } else {
      report("Using cached player directory (refreshes every 24h)");
    }

    report("Collection complete");
    return {
      exportedAt: new Date().toISOString(),
      rootLeagueId: opts.leagueId,
      userId: opts.userId || null,
      username: opts.username || null,
      nflState,
      seasons, // newest first
      players,
      playersFull: opts.includeFullPlayers ? playersFull : null,
      requestCount: client.requestCount,
    };
  }

  async function collectSeason(client, league, nflState, track, report) {
    const id = league.league_id;
    const weeks = range(1, MAX_WEEK);

    const [users, rosters, tradedPicks, winnersBracket, losersBracket, draftList, txWeeks, muWeeks] =
      await Promise.all([
        track(client.getLeagueUsers(id)),
        track(client.getRosters(id)),
        track(client.getTradedPicks(id)),
        track(client.getWinnersBracket(id)),
        track(client.getLosersBracket(id)),
        track(client.getLeagueDrafts(id)),
        Promise.all(weeks.map((w) => track(client.getTransactions(id, w)))),
        Promise.all(weeks.map((w) => track(client.getMatchups(id, w)))),
      ]);

    const drafts = await Promise.all(
      (draftList || []).map(async (d) => {
        const [draft, picks, draftTradedPicks] = await Promise.all([
          track(client.getDraft(d.draft_id)),
          track(client.getDraftPicks(d.draft_id)),
          track(client.getDraftTradedPicks(d.draft_id)),
        ]);
        return { draft: draft || d, picks: picks || [], tradedPicks: draftTradedPicks || [] };
      })
    );

    const transactionsByWeek = {};
    const matchupsByWeek = {};
    weeks.forEach((w, i) => {
      if (txWeeks[i] && txWeeks[i].length) transactionsByWeek[w] = txWeeks[i];
      if (muWeeks[i] && muWeeks[i].length) matchupsByWeek[w] = muWeeks[i];
    });

    report(`Finished ${league.season} season`);
    return {
      season: String(league.season),
      leagueId: id,
      league,
      users: users || [],
      rosters: rosters || [],
      tradedPicks: tradedPicks || [],
      winnersBracket: winnersBracket || [],
      losersBracket: losersBracket || [],
      drafts,
      transactionsByWeek,
      matchupsByWeek,
      lastCompletedWeek: lastCompletedWeek(league, nflState),
    };
  }

  /**
   * Last week whose matchup scores are final. Weeks after this are excluded from
   * standings / head-to-head math so in-progress or future weeks don't skew results.
   */
  function lastCompletedWeek(league, nflState) {
    const status = league.status;
    if (status === "pre_draft" || status === "drafting") return 0;
    const lastScored = Number((league.settings && league.settings.last_scored_leg) || 0) || MAX_WEEK;
    const isCurrent = nflState && String(nflState.league_season || nflState.season) === String(league.season);
    if (isCurrent && status !== "complete") {
      if (nflState.season_type === "pre") return 0;
      if (nflState.season_type === "regular") return Math.min(lastScored, Math.max(0, Number(nflState.week) - 1));
    }
    return lastScored;
  }

  function slimPlayers(all) {
    const out = {};
    for (const [id, p] of Object.entries(all)) {
      const s = {};
      for (const f of PLAYER_FIELDS) if (p[f] !== undefined && p[f] !== null) s[f] = p[f];
      if (!s.full_name) {
        s.full_name = [p.first_name, p.last_name].filter(Boolean).join(" ") || id;
      }
      out[id] = s;
    }
    return out;
  }

  function range(a, b) {
    const out = [];
    for (let i = a; i <= b; i++) out.push(i);
    return out;
  }

  async function safe(fn) {
    try {
      return await fn();
    } catch (e) {
      return null;
    }
  }

  NS.collectLeague = collectLeague;
  NS.slimPlayers = slimPlayers;
  NS.lastCompletedWeek = lastCompletedWeek;
})(typeof globalThis !== "undefined" ? globalThis : this);

/*
 * Sleeper API client.
 *
 * Read-only, unauthenticated client for https://api.sleeper.app/v1.
 * - Throttled to stay well under Sleeper's guidance of 1000 calls per minute.
 * - Bounded concurrency, retries with exponential backoff on 429 / 5xx / network errors.
 * - No DOM dependencies, so the same code runs in the browser and in Node (tests).
 */
(function (root) {
  "use strict";

  const NS = (root.SleeperDump = root.SleeperDump || {});

  const BASE_URL = "https://api.sleeper.app/v1";
  // Sleeper fantasy football launched for the 2017 NFL season.
  const FIRST_SEASON = 2017;

  class SleeperApiError extends Error {
    constructor(message, status, path) {
      super(message);
      this.name = "SleeperApiError";
      this.status = status;
      this.path = path;
    }
  }

  class SleeperClient {
    /**
     * @param {object} [opts]
     * @param {number} [opts.concurrency=6]   max in-flight requests
     * @param {number} [opts.minIntervalMs=70] min spacing between request starts (~850/min ceiling)
     * @param {number} [opts.retries=4]
     * @param {function} [opts.fetchImpl]
     */
    constructor(opts = {}) {
      this.concurrency = opts.concurrency || 6;
      this.minIntervalMs = opts.minIntervalMs ?? 70;
      this.retries = opts.retries ?? 4;
      this.fetchImpl = opts.fetchImpl || root.fetch.bind(root);
      this.requestCount = 0;
      this._active = 0;
      this._queue = [];
      this._lastStart = 0;
    }

    // ---- low level -------------------------------------------------------

    _schedule(task) {
      return new Promise((resolve, reject) => {
        this._queue.push({ task, resolve, reject });
        this._pump();
      });
    }

    _pump() {
      while (this._active < this.concurrency && this._queue.length) {
        const { task, resolve, reject } = this._queue.shift();
        this._active++;
        const now = Date.now();
        const wait = Math.max(0, this._lastStart + this.minIntervalMs - now);
        this._lastStart = now + wait;
        sleep(wait)
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            this._active--;
            this._pump();
          });
      }
    }

    /** GET a path relative to the API base and parse JSON. Returns null for empty bodies. */
    get(path) {
      return this._schedule(() => this._getWithRetry(path));
    }

    async _getWithRetry(path) {
      let attempt = 0;
      for (;;) {
        let res;
        try {
          this.requestCount++;
          res = await this.fetchImpl(BASE_URL + path, { headers: { Accept: "application/json" } });
        } catch (err) {
          if (attempt++ < this.retries) {
            await sleep(backoff(attempt));
            continue;
          }
          throw new SleeperApiError(`Network error calling ${path}: ${err.message}`, 0, path);
        }
        if (res.ok) {
          const text = await res.text();
          if (!text || text === "null") return null;
          return JSON.parse(text);
        }
        if ((res.status === 429 || res.status >= 500) && attempt++ < this.retries) {
          await sleep(backoff(attempt));
          continue;
        }
        if (res.status === 404) return null;
        throw new SleeperApiError(`Sleeper API returned ${res.status} for ${path}`, res.status, path);
      }
    }

    // ---- endpoints -------------------------------------------------------

    getNflState() { return this.get("/state/nfl"); }
    getUser(usernameOrId) { return this.get(`/user/${encodeURIComponent(usernameOrId)}`); }
    getUserLeagues(userId, season) { return this.get(`/user/${userId}/leagues/nfl/${season}`); }
    getLeague(leagueId) { return this.get(`/league/${leagueId}`); }
    getLeagueUsers(leagueId) { return this.get(`/league/${leagueId}/users`); }
    getRosters(leagueId) { return this.get(`/league/${leagueId}/rosters`); }
    getMatchups(leagueId, week) { return this.get(`/league/${leagueId}/matchups/${week}`); }
    getTransactions(leagueId, week) { return this.get(`/league/${leagueId}/transactions/${week}`); }
    getTradedPicks(leagueId) { return this.get(`/league/${leagueId}/traded_picks`); }
    getWinnersBracket(leagueId) { return this.get(`/league/${leagueId}/winners_bracket`); }
    getLosersBracket(leagueId) { return this.get(`/league/${leagueId}/losers_bracket`); }
    getLeagueDrafts(leagueId) { return this.get(`/league/${leagueId}/drafts`); }
    getDraft(draftId) { return this.get(`/draft/${draftId}`); }
    getDraftPicks(draftId) { return this.get(`/draft/${draftId}/picks`); }
    getDraftTradedPicks(draftId) { return this.get(`/draft/${draftId}/traded_picks`); }
    /** ~15 MB. Sleeper asks clients to call this at most once per day; callers should cache. */
    getAllPlayers() { return this.get("/players/nfl"); }

    // ---- composite helpers ----------------------------------------------

    /**
     * Find every league a user has been in, across all seasons.
     * @returns {Promise<{user: object, leagues: object[]}>}
     */
    async findUserLeagues(username, currentSeason) {
      const user = await this.getUser(username.trim());
      if (!user || !user.user_id) {
        throw new SleeperApiError(`No Sleeper user found for "${username}"`, 404, "/user");
      }
      const seasons = [];
      for (let s = Number(currentSeason); s >= FIRST_SEASON; s--) seasons.push(s);
      const results = await Promise.all(
        seasons.map((s) => this.getUserLeagues(user.user_id, s).then((l) => l || []))
      );
      return { user, leagues: results.flat() };
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function backoff(attempt) {
    return Math.min(8000, 400 * 2 ** (attempt - 1)) + Math.random() * 250;
  }

  NS.SleeperClient = SleeperClient;
  NS.SleeperApiError = SleeperApiError;
  NS.SLEEPER_BASE_URL = BASE_URL;
  NS.FIRST_SEASON = FIRST_SEASON;
})(typeof globalThis !== "undefined" ? globalThis : this);

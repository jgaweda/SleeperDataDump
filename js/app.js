/*
 * UI controller. All user-supplied strings (league names, team names) are
 * rendered with textContent via h() so league data can never inject markup.
 */
(function () {
  "use strict";

  const SD = window.SleeperDump;
  const client = new SD.SleeperClient();
  const $ = (id) => document.getElementById(id);

  const LEAGUE_TYPES = { 0: "Redraft", 1: "Keeper", 2: "Dynasty" };
  const STORAGE_KEY = "sleeper-exporter:username";

  const state = {
    nflState: null,
    user: null,
    lineages: [], // [{ head: league, seasons: [league...] newest first }]
    selected: null, // lineage
    lastZip: null,
  };

  // ---------------------------------------------------------------------------
  // DOM helper
  // ---------------------------------------------------------------------------

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function setStatus(id, msg, isError) {
    const el = $(id);
    el.textContent = msg || "";
    el.classList.toggle("error", !!isError);
  }

  function show(id, visible = true) {
    $(id).classList.toggle("hidden", !visible);
  }

  function avatarEl(avatarId, label) {
    const fallback = () => h("span", { class: "avatar", "aria-hidden": "true" }, (label || "?").trim().charAt(0).toUpperCase());
    if (!avatarId) return fallback();
    const img = h("img", { class: "avatar", src: `https://sleepercdn.com/avatars/thumbs/${avatarId}`, alt: "", loading: "lazy" });
    img.addEventListener("error", () => img.replaceWith(fallback()), { once: true });
    return img;
  }

  // ---------------------------------------------------------------------------
  // Step 1: find leagues
  // ---------------------------------------------------------------------------

  async function getNflState() {
    if (!state.nflState) state.nflState = await client.getNflState();
    return state.nflState;
  }

  async function onFindLeagues(e) {
    e.preventDefault();
    const username = $("username").value.trim();
    if (!username) return;
    try { localStorage.setItem(STORAGE_KEY, username); } catch (_) { /* storage blocked */ }

    $("find-btn").disabled = true;
    setStatus("user-status", "Looking up leagues across every season...");
    resetDownstream();
    try {
      const nfl = await getNflState();
      const { user, leagues } = await client.findUserLeagues(username, nfl.league_season || nfl.season);
      state.user = user;
      state.lineages = groupLineages(leagues);
      if (!state.lineages.length) {
        setStatus("user-status", `Found ${user.display_name}, but no NFL leagues on Sleeper.`, true);
        return;
      }
      const seasonCount = new Set(leagues.map((l) => l.season)).size;
      setStatus(
        "user-status",
        `${user.display_name}: ${state.lineages.length} league${state.lineages.length === 1 ? "" : "s"} across ${seasonCount} season${seasonCount === 1 ? "" : "s"}.`
      );
      renderSeasonFilter();
      renderLeagues();
      show("step-league");
    } catch (err) {
      setStatus("user-status", err.message || String(err), true);
    } finally {
      $("find-btn").disabled = false;
    }
  }

  async function onLoadLeagueId(e) {
    e.preventDefault();
    const id = $("league-id").value.trim();
    if (!/^\d+$/.test(id)) {
      setStatus("user-status", "League IDs are numeric. Find it in the Sleeper league URL or settings.", true);
      return;
    }
    setStatus("user-status", "Loading league...");
    resetDownstream();
    try {
      const league = await client.getLeague(id);
      if (!league) throw new Error(`League ${id} not found.`);
      // Resolve the optional username so "my team" views still work.
      const username = $("username").value.trim();
      state.user = username ? await client.getUser(username) : null;
      state.lineages = [{ head: league, seasons: [league] }];
      setStatus("user-status", `Loaded ${league.name} (${league.season}).`);
      renderSeasonFilter();
      renderLeagues();
      show("step-league");
      selectLineage(state.lineages[0]);
    } catch (err) {
      setStatus("user-status", err.message || String(err), true);
    }
  }

  /**
   * Group leagues that are the same league renewed across seasons
   * (linked by previous_league_id), so a 5-year dynasty shows once.
   */
  function groupLineages(leagues) {
    const byId = new Map(leagues.map((l) => [l.league_id, l]));
    const hasSuccessor = new Set();
    for (const l of leagues) if (byId.has(l.previous_league_id)) hasSuccessor.add(l.previous_league_id);
    const heads = leagues.filter((l) => !hasSuccessor.has(l.league_id));
    return heads
      .map((head) => {
        const seasons = [head];
        let prev = byId.get(head.previous_league_id);
        while (prev && !seasons.includes(prev)) {
          seasons.push(prev);
          prev = byId.get(prev.previous_league_id);
        }
        return { head, seasons };
      })
      .sort((a, b) => Number(b.head.season) - Number(a.head.season) || a.head.name.localeCompare(b.head.name));
  }

  // ---------------------------------------------------------------------------
  // Step 2: league list
  // ---------------------------------------------------------------------------

  function renderSeasonFilter() {
    const sel = $("season-filter");
    const seasons = [...new Set(state.lineages.flatMap((l) => l.seasons.map((s) => s.season)))].sort().reverse();
    sel.replaceChildren(
      h("option", { value: "" }, "All seasons"),
      ...seasons.map((s) => h("option", { value: s }, s))
    );
  }

  function renderLeagues() {
    const filter = $("season-filter").value;
    const list = $("league-list");
    const rows = state.lineages.filter((l) => !filter || l.seasons.some((s) => s.season === filter));
    list.replaceChildren(
      ...rows.map((lin) => {
        // When filtering by season, show that season's league; otherwise the latest.
        const league = (filter && lin.seasons.find((s) => s.season === filter)) || lin.head;
        const s = league.settings || {};
        const years = lin.seasons.map((x) => x.season);
        const span = years.length > 1 ? `${years[years.length - 1]}-${years[0]}` : years[0];
        const scoring = (league.metadata && league.metadata.scoring_type) || "";
        const isSelected = state.selected && state.selected.head.league_id === lin.head.league_id;
        return h(
          "button",
          {
            type: "button",
            class: "league",
            role: "radio",
            "aria-checked": isSelected ? "true" : "false",
            onclick: () => selectLineage(lin, league),
          },
          avatarEl(league.avatar, league.name),
          h(
            "div",
            { class: "league-info" },
            h("div", { class: "league-name" }, league.name),
            h(
              "div",
              { class: "tags" },
              h("span", { class: "tag accent" }, span),
              h("span", { class: "tag" }, `${league.total_rosters} teams`),
              h("span", { class: "tag" }, LEAGUE_TYPES[s.type] || "League"),
              scoring && h("span", { class: "tag" }, scoring.replace(/_/g, " ").toUpperCase()),
              h("span", { class: "tag" }, league.status.replace(/_/g, " "))
            )
          )
        );
      })
    );
  }

  function selectLineage(lin, league) {
    state.selected = { ...lin, exportFrom: league || lin.head };
    renderLeagues();
    const L = state.selected.exportFrom;
    $("selected-league").replaceChildren(
      h(
        "div",
        { class: "league", style: "cursor:default" },
        avatarEl(L.avatar, L.name),
        h(
          "div",
          { class: "league-info" },
          h("div", { class: "league-name" }, L.name),
          h("div", { class: "tags" },
            h("span", { class: "tag accent" }, `Exporting from ${L.season}`),
            h("span", { class: "tag" }, `League ID ${L.league_id}`))
        )
      )
    );
    show("step-export");
    show("step-result", false);
    setStatus("export-status", "");
    $("step-export").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function resetDownstream() {
    state.selected = null;
    show("step-league", false);
    show("step-export", false);
    show("step-result", false);
  }

  // ---------------------------------------------------------------------------
  // Step 3: export
  // ---------------------------------------------------------------------------

  async function onExport() {
    if (!state.selected) return;
    const btn = $("export-btn");
    btn.disabled = true;
    show("progress");
    show("step-result", false);
    setStatus("export-status", "");
    const exportClient = new SD.SleeperClient();

    try {
      const dataset = await SD.collectLeague(exportClient, {
        leagueId: state.selected.exportFrom.league_id,
        userId: state.user ? state.user.user_id : null,
        username: state.user ? state.user.username : null,
        includeHistory: $("opt-history").checked,
        includeFullPlayers: $("opt-players").checked,
        playerCache: SD.playerCache,
        onProgress: updateProgress,
      });
      updateProgress({ message: "Building tables", done: 1, total: 1 });
      const model = SD.buildModel(dataset);
      const { zip, fileName, folderName, manifest } = SD.buildZip(dataset, model, window.JSZip);
      updateProgress({ message: "Compressing zip", done: 1, total: 1 });
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
      state.lastZip = { blob, fileName };
      triggerDownload(blob, fileName);
      updateProgress({ message: `Saved ${fileName} (${formatBytes(blob.size)})`, done: 1, total: 1 });
      renderResult(model, manifest, folderName, blob.size);
    } catch (err) {
      console.error(err);
      setStatus("export-status", `Export failed: ${err.message || err}`, true);
    } finally {
      btn.disabled = false;
    }
  }

  function updateProgress({ message, done, total }) {
    if (message) $("progress-msg").textContent = message;
    const pct = total ? Math.round((done / total) * 100) : 0;
    $("progress-fill").style.width = `${pct}%`;
    $("progress-count").textContent = total > 1 ? `${done} / ${total} requests` : "";
  }

  function triggerDownload(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: fileName });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  // ---------------------------------------------------------------------------
  // Results summary (a preview of the analysis the exported data supports)
  // ---------------------------------------------------------------------------

  function renderResult(model, manifest, folderName, size) {
    const t = model.tables;
    const stat = (v, k) => h("div", { class: "stat" }, h("div", { class: "v" }, v), h("div", { class: "k" }, k));
    const champs = t.standings.filter((s) => s.champion).sort((a, b) => Number(b.season) - Number(a.season));
    const topRivalries = t.headToHead
      .filter((r) => r.games >= 2)
      .sort((a, b) => b.games - a.games || a.avg_margin_abs - b.avg_margin_abs)
      .slice(0, 5);

    const body = [
      h(
        "div",
        { class: "stats" },
        stat(manifest.seasons.length, manifest.seasons.length === 1 ? "season" : "seasons"),
        stat(t.managers.length, "managers"),
        stat(t.matchups.length / 2, "games"),
        stat(t.trades.length, "trades"),
        stat(t.transactions.length, "transactions"),
        stat(formatBytes(size), "zip size")
      ),
    ];

    const left = h("div", {},
      h("h3", {}, "Champions"),
      champs.length
        ? h("table", { class: "mini" },
            h("thead", {}, h("tr", {}, h("th", {}, "Season"), h("th", {}, "Champion"), h("th", {}, "Record"))),
            h("tbody", {}, champs.map((c) => h("tr", {},
              h("td", {}, c.season),
              h("td", { class: "gold" }, c.team_name),
              h("td", { class: "num" }, `${c.wins}-${c.losses}${c.ties ? "-" + c.ties : ""}`)))))
        : h("p", { class: "note" }, "No completed playoffs yet."));

    const right = h("div", {},
      h("h3", {}, "Most-played rivalries"),
      topRivalries.length
        ? h("table", { class: "mini" },
            h("thead", {}, h("tr", {}, h("th", {}, "Matchup"), h("th", {}, "Games"), h("th", {}, "Series"))),
            h("tbody", {}, topRivalries.map((r) => h("tr", {},
              h("td", {}, `${r.manager_a} vs ${r.manager_b}`),
              h("td", { class: "num" }, r.games),
              h("td", { class: "num" }, `${r.a_wins}-${r.b_wins}${r.ties ? "-" + r.ties : ""}`)))))
        : h("p", { class: "note" }, "Not enough completed games yet."));

    body.push(h("div", { class: "result-grid" }, left, right));

    const my = model.myTeam;
    if (my && my.found) {
      const s = my.summary;
      const nemesis = [...my.rivals].filter((r) => r.games >= 2).sort((a, b) => (a.wins - a.losses) - (b.wins - b.losses))[0];
      body.push(
        h("h3", { style: "margin:20px 0 8px;font-size:0.95rem" }, `Your team: ${my.displayName}`),
        h("div", { class: "stats" },
          stat(`${s.wins}-${s.losses}${s.ties ? "-" + s.ties : ""}`, "all-time record"),
          stat(s.points_for.toLocaleString(), "points for"),
          stat(s.championships, s.championships === 1 ? "title" : "titles"),
          stat(s.trades, "trades made"),
          nemesis && stat(nemesis.opponent, `nemesis (${nemesis.wins}-${nemesis.losses})`))
      );
    } else if (state.user) {
      body.push(h("p", { class: "note" }, `${state.user.display_name} is not a manager in this league, so my_team/ was skipped.`));
    }

    const tree = [
      `${folderName}/`,
      "  README.md, manifest.json",
      "  history/      managers, standings, matchups, head_to_head, transactions, trades, drafts",
      ...manifest.seasons.map((s) => `  seasons/${s.season}/  league.json, rules.md, rosters, matchups/, transactions/, drafts/, playoffs/`),
      my && my.found ? "  my_team/      your seasons, rivals, matchups, trades, roster" : null,
      "  players/      player lookup for every referenced player",
    ].filter(Boolean).join("\n");
    body.push(h("h3", { style: "margin:20px 0 8px;font-size:0.95rem" }, "What's in the zip"), h("div", { class: "tree" }, tree));
    body.push(h("p", { class: "note" }, `${manifest.api_requests} Sleeper API requests. Schema v${manifest.schema_version}.`));

    $("result-body").replaceChildren(...body);
    show("step-result");
    $("step-result").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  // ---------------------------------------------------------------------------
  // Wire up
  // ---------------------------------------------------------------------------

  $("user-form").addEventListener("submit", onFindLeagues);
  $("league-id-form").addEventListener("submit", onLoadLeagueId);
  $("season-filter").addEventListener("change", renderLeagues);
  $("export-btn").addEventListener("click", onExport);
  $("download-again").addEventListener("click", () => {
    if (state.lastZip) triggerDownload(state.lastZip.blob, state.lastZip.fileName);
  });

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) $("username").value = saved;
  } catch (_) { /* storage blocked */ }

  // Deep link: ?username=foo or ?league=123
  const params = new URLSearchParams(location.search);
  if (params.get("username")) {
    $("username").value = params.get("username");
    $("user-form").requestSubmit();
  } else if (params.get("league")) {
    $("league-id").value = params.get("league");
    document.querySelector("details.alt").open = true;
    $("league-id-form").requestSubmit();
  }
})();

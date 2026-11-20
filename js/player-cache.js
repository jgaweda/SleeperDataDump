/*
 * 24-hour IndexedDB cache for the Sleeper NFL player directory.
 * Sleeper asks clients to fetch /players/nfl at most once per day.
 * Every call is wrapped so private browsing or blocked storage just means "no cache".
 */
(function (root) {
  "use strict";

  const NS = (root.SleeperDump = root.SleeperDump || {});
  const DB = "sleeper-exporter";
  const STORE = "kv";
  const KEY = "players_nfl";
  const TTL_MS = 24 * 60 * 60 * 1000;

  function open() {
    return new Promise((resolve, reject) => {
      if (!root.indexedDB) return reject(new Error("IndexedDB unavailable"));
      const req = root.indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(mode, fn) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(STORE, mode);
          const out = fn(t.objectStore(STORE));
          t.oncomplete = () => resolve(out && out.result);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        })
    );
  }

  const playerCache = {
    async get() {
      try {
        const v = await tx("readonly", (s) => s.get(KEY));
        if (!v || Date.now() - v.savedAt > TTL_MS) return null;
        return v;
      } catch (e) {
        return null;
      }
    },
    async set({ slim, full }) {
      try {
        await tx("readwrite", (s) => s.put({ slim, full: full || null, savedAt: Date.now() }, KEY));
      } catch (e) {
        /* storage blocked or full: run without cache */
      }
    },
  };

  NS.playerCache = playerCache;
})(typeof globalThis !== "undefined" ? globalThis : this);

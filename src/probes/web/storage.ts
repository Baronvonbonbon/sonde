// Persistence.
//
// Every storage mechanism here can be present-but-partitioned, present-but-
// ephemeral, or present-but-quota-zero. Feature detection cannot see any of
// those, so each probe writes something and reads it back.

import { TIER, type Probe } from "../../core/types";
import { detect, lines, need, ok, pad, probe, wrong } from "../helpers";

const CAT = "storage";
const KEY = "sonde.probe";

const webStorage = probe({
  id: "web.storage.webStorage",
  title: "localStorage + sessionStorage round-trip",
  why: "The journal that makes this suite crash-resilient is written to localStorage. If it does not persist, a crash loses the report — so this is checked, not assumed.",
  category: CAT,
  tier: TIER.INVOKE,
  async run(ctx) {
    const rows: string[] = [];
    let broken = 0;

    for (const [name, store] of [
      ["localStorage", localStorage],
      ["sessionStorage", sessionStorage],
    ] as const) {
      try {
        const value = `sonde-${Date.now()}`;
        store.setItem(KEY, value);
        ctx.cleanup.add(`${name}-key`, () => store.removeItem(KEY));
        const read = store.getItem(KEY);
        rows.push(pad(name, read === value ? `ok (${store.length} keys)` : `MISMATCH — wrote "${value}", read "${read}"`));
        if (read !== value) broken++;
      } catch (e) {
        // Throwing on write is what a WebView with storage disabled does, and
        // it throws rather than returning null, so it must be caught per-store.
        rows.push(pad(name, `THREW — ${(e as Error).message}`));
        broken++;
      }
    }

    return broken === 0
      ? ok("Both stores round-trip.", lines(...rows))
      : wrong(`${broken} of 2 web storage areas are unusable. The crash journal degrades to in-memory.`, lines(...rows));
  },
});

const indexedDb = probe({
  id: "web.storage.indexedDb",
  title: "IndexedDB round-trip",
  why: "The journal's preferred backend and the only store that holds structured data at size. A blocked or absent IDB is a common WebView restriction.",
  category: CAT,
  tier: TIER.INVOKE,
  timeoutMs: 20_000,
  async run(ctx) {
    const idb = need<IDBFactory>("indexedDB");
    const dbName = `sonde-probe-${Date.now()}`;

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("s", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("open failed"));
      // A WebView that never settles `open` is a real failure mode and would
      // otherwise burn the probe's whole budget with no evidence of why.
      req.onblocked = () => reject(new Error("open blocked by another connection"));
      ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
    });
    ctx.cleanup.add("idb-connection", () => db.close());
    ctx.cleanup.add("idb-database", () =>
      new Promise<void>((r) => {
        const d = idb.deleteDatabase(dbName);
        d.onsuccess = d.onerror = d.onblocked = () => r();
      }),
    );

    const payload = { id: 1, blob: new Uint8Array(1024).fill(7), when: new Date() };
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction("s", "readwrite");
      t.objectStore("s").put(payload);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error ?? new Error("write failed"));
    });
    const read = await new Promise<typeof payload>((resolve, reject) => {
      const req = db.transaction("s", "readonly").objectStore("s").get(1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const intact = read?.blob?.length === 1024 && read.blob[0] === 7 && read.when instanceof Date;
    return intact
      ? ok("Wrote and read back a structured record with binary and Date fields.", lines(pad("bytes", read.blob.length), pad("Date survived", read.when instanceof Date)))
      : wrong("Record came back altered — the structured clone path is lossy here.", pad("read", JSON.stringify(read)?.slice(0, 200)));
  },
});

const cacheStorage = probe({
  id: "web.storage.cacheStorage",
  title: "CacheStorage round-trip",
  why: "Offline asset storage. Available without a service worker, and often the only large-object store a restricted WebView leaves open.",
  category: CAT,
  tier: TIER.INVOKE,
  async run(ctx) {
    const caches = need<CacheStorage>("caches");
    const name = `sonde-${Date.now()}`;
    const cache = await caches.open(name);
    ctx.cleanup.add("cache", () => caches.delete(name));

    const url = new URL("./sonde-cache-probe", location.href).href;
    await cache.put(url, new Response("sonde", { headers: { "content-type": "text/plain" } }));
    const hit = await cache.match(url);
    const text = hit ? await hit.text() : null;

    return text === "sonde"
      ? ok("Stored and retrieved a synthetic Response.", lines(pad("caches", (await caches.keys()).length)))
      : wrong(`Retrieved "${text}" instead of the stored body.`);
  },
});

const quota = probe({
  id: "web.storage.quota",
  title: "Quota estimate + persistence request",
  why: "A quota of zero means every storage probe above is writing to something that will be evicted. Persistence is what stops a crash journal disappearing between runs.",
  category: CAT,
  tier: TIER.PROMPT,
  permissions: ["persistent-storage"],
  async run() {
    const storage = need<StorageManager>("navigator.storage");
    const rows: string[] = [];

    if (storage.estimate) {
      const est = await storage.estimate();
      rows.push(
        pad("quota", est.quota != null ? `${(est.quota / 1e6).toFixed(0)} MB` : "not reported"),
        pad("usage", est.usage != null ? `${(est.usage / 1e6).toFixed(2)} MB` : "not reported"),
      );
      const detail = (est as { usageDetails?: Record<string, number> }).usageDetails;
      if (detail) for (const [k, v] of Object.entries(detail)) rows.push(pad(`  ${k}`, `${(v / 1e3).toFixed(1)} KB`));
    } else {
      rows.push(pad("estimate", "absent"));
    }

    let persisted = false;
    if (storage.persisted && storage.persist) {
      persisted = await storage.persisted();
      if (!persisted) persisted = await storage.persist();
      rows.push(pad("persisted", persisted));
    } else {
      rows.push(pad("persist", "absent"));
    }

    const est = storage.estimate ? await storage.estimate() : { quota: undefined };
    if (est.quota === 0) {
      return {
        status: "blocked",
        detail: "Quota is zero — writes will fail or be evicted immediately. Storage is nominally present but unusable.",
        data: lines(...rows),
        diagnosis: "quota-exceeded",
      };
    }
    return ok(
      persisted ? "Quota reported and storage is persistent." : "Quota reported; storage is best-effort (evictable).",
      lines(...rows, "", persisted ? "" : "Best-effort storage can be cleared under pressure. A crash journal may not survive."),
    );
  },
});

const cookies = probe({
  id: "web.storage.cookies",
  title: "Cookies + Cookie Store API",
  why: "In a third-party iframe — which is exactly how the gateway surface embeds this — cookies are partitioned or blocked outright. Distinguishing that from 'disabled' matters.",
  category: CAT,
  tier: TIER.INVOKE,
  async run(ctx) {
    const rows: string[] = [pad("navigator.cookieEnabled", navigator.cookieEnabled)];

    const name = "sonde_probe";
    document.cookie = `${name}=1; SameSite=Lax; path=/`;
    ctx.cleanup.add("cookie", () => {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    });
    const readBack = document.cookie.includes(`${name}=1`);
    rows.push(pad("document.cookie write", readBack ? "ok" : "did not persist"));

    const cookieStore = (globalThis as { cookieStore?: { getAll(): Promise<unknown[]> } }).cookieStore;
    rows.push(pad("cookieStore API", cookieStore ? "present" : "absent"));
    if (cookieStore) {
      try {
        rows.push(pad("cookieStore.getAll", `${(await cookieStore.getAll()).length} cookie(s)`));
      } catch (e) {
        rows.push(pad("cookieStore.getAll", `threw — ${(e as Error).message}`));
      }
    }

    const hasStorageAccess = (document as { hasStorageAccess?: () => Promise<boolean> }).hasStorageAccess;
    if (hasStorageAccess) {
      try {
        rows.push(pad("hasStorageAccess", await hasStorageAccess.call(document)));
      } catch (e) {
        rows.push(pad("hasStorageAccess", `threw — ${(e as Error).message}`));
      }
    }

    if (!readBack) {
      return {
        status: "blocked",
        detail:
          "A first-party cookie did not persist. In a framed context this is partitioning or " +
          "third-party cookie blocking, not a broken engine.",
        data: lines(...rows, "", pad("framed", window.self !== window.top)),
        diagnosis: "policy-blocked-by-embedder",
      };
    }
    return ok("Cookie written and read back.", lines(...rows));
  },
});

const storageAccess = detect({
  id: "web.storage.storageAccessApi",
  title: "Storage Access API",
  why: "The sanctioned escape hatch from partitioning for a framed document. Its absence means a framed Product has no route to unpartitioned storage at all.",
  category: CAT,
  paths: ["document.requestStorageAccess", "document.hasStorageAccess"],
});

export const STORAGE_PROBES: Probe[] = [
  webStorage,
  indexedDb,
  cacheStorage,
  quota,
  cookies,
  storageAccess,
];

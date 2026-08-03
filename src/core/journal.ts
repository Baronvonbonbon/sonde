// Crash-resilient result log.
//
// Bank A deliberately includes probes that can take the renderer down — WebGPU
// device loss, large SharedArrayBuffer allocations, getDisplayMedia on a
// constrained WebView. Without a journal, a crash at probe 90 of 140 produces
// an empty page. With one it produces "crashed at web.graphics.webgpu.device",
// which is frequently the single most valuable line in the report.
//
// The mechanism is deliberately dumb: write `begin` BEFORE invoking, `finish`
// AFTER. A record with a begin and no finish is a crash, by construction. No
// heartbeat, no timers, nothing that itself needs to survive.

import type { Outcome, Status } from "./types";

const DB_NAME = "sonde";
const STORE = "journal";
const META_KEY = "sonde:run";
const LS_PREFIX = "sonde:j:";

export interface RunMeta {
  runId: string;
  startedAt: string;
  suiteVersion: string;
  buildId: string;
}

export interface JournalEntry {
  probeId: string;
  begunAt: number;
  outcome?: Outcome;
}

/**
 * IndexedDB with a localStorage fallback.
 *
 * The fallback is not defensive padding: a WebView with storage partitioned or
 * IDB disabled is exactly the kind of runtime this suite exists to characterise,
 * and losing the journal there would lose the evidence of that.
 */
export class Journal {
  private db: IDBDatabase | null = null;
  private useLocalStorage = false;
  private meta: RunMeta | null = null;

  async open(meta: RunMeta): Promise<void> {
    this.meta = meta;
    try {
      this.db = await openDb();
    } catch {
      this.useLocalStorage = true;
    }
    try {
      localStorage.setItem(META_KEY, JSON.stringify(meta));
    } catch {
      /* Both stores gone. The journal degrades to in-memory; the run still works. */
    }
  }

  async begin(probeId: string): Promise<void> {
    await this.put({ probeId, begunAt: Date.now() });
  }

  async finish(probeId: string, outcome: Outcome): Promise<void> {
    await this.put({ probeId, begunAt: Date.now(), outcome });
  }

  /**
   * Recover a previous run. Any entry with a begin and no outcome is promoted
   * to `crashed` — that promotion is the whole point of the file.
   */
  async recover(): Promise<{ meta: RunMeta; results: Map<string, Outcome> } | null> {
    // Entries first, and metadata only as a bonus. The entries are the whole
    // point; the run header is a convenience. An earlier version bailed out
    // when the header was missing and threw away a recovered crash record for
    // want of a timestamp — exactly backwards.
    const entries = await this.all();
    if (entries.length === 0) return null;

    let meta: RunMeta = {
      runId: "recovered",
      startedAt: new Date(Math.min(...entries.map((e) => e.begunAt))).toISOString(),
      suiteVersion: "unknown",
      buildId: "unknown",
    };
    try {
      const raw = localStorage.getItem(META_KEY);
      if (raw) meta = { ...meta, ...(JSON.parse(raw) as RunMeta) };
    } catch {
      /* keep the synthesised header */
    }

    const results = new Map<string, Outcome>();
    for (const e of entries) {
      results.set(
        e.probeId,
        e.outcome ?? {
          status: "crashed" as Status,
          detail:
            "Started and never finished — the runtime died during this probe. " +
            "That it is this probe and not another is itself the finding.",
          diagnosis: "threw",
        },
      );
    }
    return { meta, results };
  }

  async clear(): Promise<void> {
    try {
      localStorage.removeItem(META_KEY);
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith(LS_PREFIX)) localStorage.removeItem(k);
      }
    } catch {
      /* nothing to clear */
    }
    if (this.db) {
      await tx(this.db, "readwrite", (s) => s.clear()).catch(() => {});
    }
  }

  get runMeta(): RunMeta | null {
    return this.meta;
  }

  // -- storage backends ------------------------------------------------------

  private async put(entry: JournalEntry): Promise<void> {
    // localStorage first and always, even when IDB is available. It is
    // synchronous, so it has actually landed by the time the probe is invoked;
    // an IDB write is a promise that a hard crash can beat.
    try {
      localStorage.setItem(LS_PREFIX + entry.probeId, JSON.stringify(entry));
    } catch {
      /* quota or disabled — IDB may still take it */
    }
    if (this.db && !this.useLocalStorage) {
      await tx(this.db, "readwrite", (s) => s.put(entry)).catch(() => {});
    }
  }

  private async all(): Promise<JournalEntry[]> {
    const byId = new Map<string, JournalEntry>();
    if (this.db) {
      const rows = await tx<JournalEntry[]>(this.db, "readonly", (s) => s.getAll()).catch(() => []);
      for (const r of rows) byId.set(r.probeId, r);
    }
    try {
      for (const k of Object.keys(localStorage)) {
        if (!k.startsWith(LS_PREFIX)) continue;
        const raw = localStorage.getItem(k);
        if (!raw) continue;
        const e = JSON.parse(raw) as JournalEntry;
        // localStorage wins: it is written synchronously, so where the two
        // disagree it is because IDB lost the race with a crash.
        byId.set(e.probeId, e);
      }
    } catch {
      /* fall back to whatever IDB gave us */
    }
    return [...byId.values()];
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no indexedDB"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "probeId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    req.onblocked = () => reject(new Error("indexedDB blocked"));
    // A WebView that never settles the open request would otherwise hang the
    // whole suite before the first probe runs.
    setTimeout(() => reject(new Error("indexedDB open timed out")), 3_000);
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = op(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

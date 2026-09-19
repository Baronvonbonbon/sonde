// Limits, measured by hitting them.
//
// The capability probes answer "does it work?". These answer "how far does it go?",
// which is what a Product has to design around: how large one message to the host
// can be, how many calls it takes at once, how much host storage holds, how long
// Bulletin keeps data, how many statements an account holds. Each result carries
// `measures`, so a limit can be tracked across app builds rather than rediscovered.
//
// Added 2026-09-19. The quota-exhausting ones are opt-in (types.ts OptIn): they use
// up this product's own allowance, which is why sonde, not almanac, runs them.

import {
  createProofAuthorized,
  deriveEntropy,
  formatHostError,
  getHostLocalStorage,
  getNotificationManager,
  getPreimageManager,
  getStatementStore,
  requestPermission,
  requestResourceAllocation,
  toHex,
  type PreimageManager,
} from "@parity/product-sdk-host";
import { TIER, type Ctx, type Probe } from "../../core/types";
import { lines, ok, pad, probe, unsupported, within, wrong } from "../helpers";
import { listUploads, rememberUpload } from "./uploads";

const host = (p: Omit<Probe, "bank" | "category">): Probe => probe({ ...p, bank: "host", category: "host-limits" });

const MiB = 1024 * 1024;
const enc = new TextEncoder();
const random = (n: number) => {
  // getRandomValues refuses more than 64 KiB at a time.
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65_536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65_536)));
  return out;
};
const errOf = (e: unknown) => (e instanceof Error ? e.message : JSON.stringify(e) ?? String(e)).slice(0, 220);
const sizeOf = (n: number) => (n >= MiB ? `${n / MiB} MiB` : `${n / 1024} KiB`);

// -- the host connection itself ------------------------------------------------

const bridgePayload = host({
  id: "host.limits.bridgePayload",
  title: "Largest message the host accepts",
  why: "Every host call is a message across the WebView bridge. Writing a growing value to host local storage (a scratch key, cleared afterwards) finds the largest single message the bridge carries — and whether going over it rejects or hangs.",
  tier: TIER.INVOKE,
  needs: ["host.localStorage.roundTrip"],
  timeoutMs: 180_000,
  async run(ctx) {
    // *Corrected 2026-09-19:* this grew the input to deriveEntropy, which accepts at most
    // 32 bytes ("Key must be at most 32 bytes"), so it measured that call's argument check,
    // not the bridge.
    const store = await getHostLocalStorage();
    if (!store) return unsupported("getHostLocalStorage() returned null.");
    const key = "sonde.limits.bridge";
    ctx.cleanup.add("bridge-scratch", () => store.clear(key).catch(() => {}));
    const rows: string[] = [];
    let largest = 0;
    let failure = "none up to 16 MiB";
    for (const n of [1024, 64 * 1024, MiB, 4 * MiB, 16 * MiB]) {
      const bytes = random(n);
      let put;
      try {
        put = await within(ctx.signal, 45_000, sizeOf(n), () => store.writeBytes(key, bytes));
      } catch (e) {
        rows.push(pad(sizeOf(n), `refused — ${errOf(e)}`));
        failure = `refused at ${sizeOf(n)}`;
        break;
      }
      if (!put.ok) {
        rows.push(pad(sizeOf(n), `no answer in ${put.ms} ms`));
        failure = `hang at ${sizeOf(n)}`;
        break;
      }
      const get = await within(ctx.signal, 45_000, "read", () => store.readBytes(key));
      const back = get.ok ? get.value : undefined;
      const intact = !!back && back.length === n && back[n - 1] === bytes[n - 1];
      rows.push(pad(sizeOf(n), `write ${put.ms} ms, read ${get.ms} ms, ${intact ? "intact" : "NOT intact"}`));
      if (!intact) {
        failure = `read-back fails at ${sizeOf(n)}`;
        break;
      }
      largest = n;
    }
    await store.clear(key).catch(() => {});
    const measures = { largestOkBytes: largest, beyond: failure };
    if (!largest) return { ...wrong("Even a 1 KiB value failed.", lines(...rows)), measures };
    return { ...ok(`Largest message carried both ways: ${sizeOf(largest)}. Beyond it: ${failure}.`, lines(...rows)), measures };
  },
});

const concurrency = host({
  id: "host.limits.concurrency",
  title: "Many host calls at once",
  why: "A Product that renders a list may fire dozens of host calls together. Whether the host queues them, drops some or deadlocks decides whether calls must be serialised by hand.",
  tier: TIER.INVOKE,
  needs: ["host.system.handshake"],
  timeoutMs: 90_000,
  async run(ctx) {
    const rows: string[] = [];
    const measures: Record<string, number> = {};
    // A known answer to compare the parallel results against.
    const probeInput = enc.encode("sonde-concurrency-reference");
    const ref = await deriveEntropy(probeInput);
    if (!ref.ok) return wrong(`deriveEntropy errored: ${formatHostError(ref.error)}`);
    const refHex = toHex(ref.value);

    for (const n of [10, 50, 200]) {
      let resolved = 0;
      let wrongAnswers = 0;
      const calls = Array.from({ length: n }, (_, i) =>
        deriveEntropy(i === 0 ? probeInput : enc.encode(`sonde-concurrency-${n}-${i}`)).then((r) => {
          resolved++;
          if (i === 0 && (!r.ok || toHex(r.value) !== refHex)) wrongAnswers++;
          return r;
        }),
      );
      const w = await within(ctx.signal, 25_000, `${n} at once`, () => Promise.all(calls));
      rows.push(pad(`${n} at once`, w.ok ? `all answered in ${w.ms} ms` : `${resolved} of ${n} answered in ${w.ms} ms, then silence`));
      if (wrongAnswers) rows.push(pad("", "the reference call returned a DIFFERENT value under load"));
      measures[`answered_${n}`] = resolved;
      measures[`ms_${n}`] = w.ms;
      if (!w.ok || wrongAnswers) {
        return { ...wrong(`With ${n} calls in flight, ${resolved} answered${wrongAnswers ? " and one answered wrongly" : ""}.`, lines(...rows)), measures };
      }
    }
    return { ...ok(`200 calls at once all answered, in ${measures.ms_200} ms.`, lines(...rows)), measures };
  },
});

// -- host local storage -------------------------------------------------------

const localStorageCeiling = host({
  id: "host.limits.localStorageCeiling",
  title: "Host local storage — largest record",
  why: "almanac measured 4 MiB in one record. This steps up from 5 MiB until a write or read-back fails. On 2026-09-19 an 8 MiB write took the whole page down, so each size is noted before it is tried: a re-run reports the size that killed the last attempt and stops short of it.",
  tier: TIER.INVOKE,
  optIn: "crash-risk",
  crashRisk: "high",
  needs: ["host.localStorage.roundTrip"],
  timeoutMs: 600_000,
  async run(ctx) {
    const store = await getHostLocalStorage();
    if (!store) return unsupported("getHostLocalStorage() returned null.");
    const key = "sonde.limits.ceiling";
    // In web localStorage, not host storage: it has to survive the page dying mid-write.
    const MARK = "sonde.limits.ceiling.trying";
    const killedAt = Number(safeGet(MARK) ?? 0);
    ctx.cleanup.add("host-ls-ceiling", () => store.clear(key).catch(() => {}));
    const rows: string[] = [];
    if (killedAt) rows.push(pad("last attempt", `the page died writing ${sizeOf(killedAt)} — stopping below it`));
    let largest = 0;
    let beyond = killedAt ? `page died at ${sizeOf(killedAt)} (earlier run)` : "none up to 8 MiB";
    for (const n of [5 * MiB, 6 * MiB, 7 * MiB, 8 * MiB]) {
      if (killedAt && n >= killedAt) break;
      safeSet(MARK, String(n));
      const bytes = random(n);
      let put;
      try {
        put = await within(ctx.signal, 120_000, "write", () => store.writeBytes(key, bytes));
      } catch (e) {
        rows.push(pad(sizeOf(n), `refused — ${errOf(e)}`));
        beyond = `refused at ${sizeOf(n)}`;
        break;
      }
      if (!put.ok) {
        rows.push(pad(sizeOf(n), `write: no answer in ${put.ms} ms`));
        beyond = `write hangs at ${sizeOf(n)}`;
        break;
      }
      const get = await within(ctx.signal, 120_000, "read", () => store.readBytes(key));
      const back = get.ok ? get.value : undefined;
      const same = !!back && back.length === n && back[0] === bytes[0] && back[n - 1] === bytes[n - 1] && back[n >> 1] === bytes[n >> 1];
      rows.push(pad(sizeOf(n), `write ${put.ms} ms, read ${get.ms} ms${get.ok ? "" : " (no answer)"}, ${same ? "intact" : `came back ${back?.length ?? "empty"}`}`));
      if (!same) {
        beyond = `read-back fails at ${sizeOf(n)}`;
        break;
      }
      largest = n;
    }
    // Only a size that finished clears the mark; a crash leaves it for the next run to read.
    if (!killedAt) safeSet(MARK, "");
    await store.clear(key).catch(() => {});
    const measures = { largestRecordMiB: largest / MiB, beyond };
    return largest
      ? { ...ok(`Largest record written and read back intact: ${sizeOf(largest)}. Beyond: ${beyond}.`, lines(...rows)), measures }
      : { ...wrong(`No size from 5 MiB up round-tripped. Beyond: ${beyond}.`, lines(...rows)), measures };
  },
});

function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k) || null;
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string): void {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* best effort */
  }
}

// -- notifications --------------------------------------------------------------

const notificationLimits = host({
  id: "host.limits.notifications",
  title: "Notification limits — text length, how many, how far ahead",
  why: "Reminders are the one way a Product reaches a user with the app closed (almanac P3). How long the text can be, how many can wait at once and how far ahead they can be set decide what a reminder feature can promise.",
  tier: TIER.PROMPT,
  needs: ["host.notifications.push"],
  timeoutMs: 120_000,
  async run(ctx) {
    const n = await getNotificationManager();
    if (!n) return unsupported("getNotificationManager() returned null.");
    const ids: unknown[] = [];
    ctx.cleanup.add("limit-notifications", async () => {
      for (const id of ids) await n.cancel(id as never).catch(() => {});
    });
    const tomorrow = BigInt(Date.now() + 86_400_000);
    const rows: string[] = [];
    const measures: Record<string, number | string | boolean> = {};
    const tryPush = async (label: string, text: string, at: bigint) => {
      const w = await within(ctx.signal, 15_000, label, () => n.push({ text, scheduledAt: at }));
      if (!w.ok) return `no answer in ${w.ms} ms`;
      ids.push(w.value);
      return "accepted";
    };
    const wrapErr = async (label: string, text: string, at: bigint) => {
      try {
        return await tryPush(label, text, at);
      } catch (e) {
        return `refused — ${errOf(e)}`;
      }
    };

    // Everything is scheduled a day out and cancelled at the end, so nothing appears.
    let longest = 0;
    for (const len of [200, 1_000, 10_000, 100_000]) {
      const r = await wrapErr(`${len} chars`, `sonde limit probe — safe to ignore. ${"x".repeat(len)}`.slice(0, len), tomorrow);
      rows.push(pad(`text ${len} chars`, r));
      if (r !== "accepted") break;
      longest = len;
    }
    measures.longestTextAccepted = longest;

    let scheduled = 0;
    for (let i = 0; i < 30; i++) {
      const r = await wrapErr(`scheduled ${i}`, "sonde limit probe — safe to ignore.", tomorrow + BigInt(i * 60_000));
      if (r !== "accepted") {
        rows.push(pad(`scheduled #${i + 1}`, r));
        break;
      }
      scheduled++;
    }
    rows.push(pad("scheduled at once", `${scheduled} of 30 accepted`));
    measures.scheduledAccepted = scheduled;

    const far = await wrapErr("a year ahead", "sonde limit probe — safe to ignore.", BigInt(Date.now() + 365 * 86_400_000));
    rows.push(pad("a year ahead", far));
    measures.yearAhead = far === "accepted";

    for (const id of ids.splice(0)) await n.cancel(id as never).catch(() => {});
    return {
      ...ok(`Text up to ${longest} chars, ${scheduled} of 30 scheduled at once, a year ahead ${far}. All cancelled.`, lines(...rows)),
      measures,
    };
  },
});

// -- Bulletin -------------------------------------------------------------------

async function preimages(): Promise<PreimageManager> {
  // Asked here, not through `needs`: host.cloud.allowance is a gesture probe and runs after
  // every unattended one, so a `needs` on it always read "has not run yet" (2026-09-19).
  await requestResourceAllocation([{ tag: "BulletinAllowance", value: undefined } as never]).catch(() => {});
  const p = await requestPermission({ tag: "PreimageSubmit", value: undefined });
  if (!p.ok || !p.value) throw new Error(p.ok ? "PreimageSubmit declined" : formatHostError(p.error));
  const m = await getPreimageManager();
  if (!m) throw new Error("getPreimageManager() returned null");
  return m;
}

function lookup(m: PreimageManager, key: string, ms: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    let sub: { unsubscribe(): void } | undefined;
    const done = (b: Uint8Array | null) => {
      clearTimeout(t);
      try {
        sub?.unsubscribe();
      } catch {
        /* gone */
      }
      resolve(b);
    };
    const t = setTimeout(() => done(null), ms);
    try {
      sub = m.lookup(key as `0x${string}`, (b) => b && done(b));
    } catch {
      done(null);
    }
  });
}

const retention = host({
  id: "host.limits.retention",
  title: "Bulletin retention — can earlier uploads still be read?",
  why: "Bulletin is documented as permanent and measured at about two weeks. Every sonde upload is remembered; each run looks them all up again, so the age at which data disappears is measured from inside the app, run after run.",
  tier: TIER.INVOKE,
  needs: ["host.system.handshake"],
  timeoutMs: 60_000,
  async run() {
    const uploads = await listUploads();
    if (!uploads.length) {
      return {
        status: "skip",
        detail: "No earlier uploads to look up yet — the T3 upload probes record what they store, and the next run checks it.",
      };
    }
    const m = await getPreimageManager();
    if (!m) return unsupported("getPreimageManager() returned null.");
    const now = Date.now();
    const found = await Promise.all(uploads.map((u) => lookup(m, u.key, 20_000)));
    const rows: string[] = [];
    let oldestFound = -1;
    let youngestMissing = Infinity;
    found.forEach((b, i) => {
      const u = uploads[i];
      const days = (now - Date.parse(u.at)) / 86_400_000;
      rows.push(pad(`${days.toFixed(1)} d, ${u.bytes} B`, b ? `found (${u.via})` : `NOT found (${u.via})`));
      if (b) oldestFound = Math.max(oldestFound, days);
      else youngestMissing = Math.min(youngestMissing, days);
    });
    const hits = found.filter(Boolean).length;
    const measures = {
      tracked: uploads.length,
      found: hits,
      oldestFoundDays: Number(oldestFound.toFixed(2)),
      youngestMissingDays: Number.isFinite(youngestMissing) ? Number(youngestMissing.toFixed(2)) : -1,
    };
    const summary = `${hits} of ${uploads.length} earlier uploads still readable; oldest found ${oldestFound.toFixed(1)} days` +
      (Number.isFinite(youngestMissing) ? `, youngest missing ${youngestMissing.toFixed(1)} days.` : ".");
    return { ...ok(summary, lines(...rows)), measures };
  },
});

const preimageSize = host({
  id: "host.limits.preimageSize",
  title: "Largest single Bulletin upload (2, 3, 4 MiB)",
  why: "almanac stored 1 MiB in 41 s and stopped there. A claim is 4 MiB, so this asks for a fresh allowance before each step and finds the largest single upload the host will carry.",
  tier: TIER.SPEND,
  optIn: "spends-quota",
  cost: "Requests up to three Bulletin allowance claims and stores up to 9 MiB of random bytes on Bulletin, readable by hash for ~2 weeks.",
  needs: ["host.system.handshake"],
  timeoutMs: 900_000,
  async run(ctx) {
    const m = await preimages();
    const rows: string[] = [];
    const measures: Record<string, number | string> = {};
    let largest = 0;
    for (const n of [2 * MiB, 3 * MiB, 4 * MiB]) {
      await requestResourceAllocation([{ tag: "BulletinAllowance", value: undefined } as never]).catch(() => {});
      const bytes = random(n);
      const put = await within(ctx.signal, 240_000, "submit", () => m.submit(bytes));
      if (!put.ok) {
        rows.push(pad(sizeOf(n), `no answer in ${put.ms} ms`));
        measures.beyond = `hang at ${sizeOf(n)}`;
        break;
      }
      const key = put.value as string;
      await rememberUpload({ key, bytes: n, at: new Date().toISOString(), via: "host.limits.preimageSize" });
      const back = await lookup(m, key, 60_000);
      const intact = !!back && back.length === n && back[0] === bytes[0] && back[n - 1] === bytes[n - 1];
      rows.push(pad(sizeOf(n), `stored in ${(put.ms / 1000).toFixed(1)} s, read back ${intact ? "intact" : back ? `as ${back.length} B` : "— no answer in 60 s"}`));
      measures[`seconds_${n / MiB}MiB`] = Number((put.ms / 1000).toFixed(1));
      if (!intact) {
        measures.beyond = `read-back fails at ${sizeOf(n)}`;
        break;
      }
      largest = n;
    }
    measures.largestOkMiB = largest / MiB;
    return largest
      ? { ...ok(`Largest single upload stored and read back: ${sizeOf(largest)}.`, lines(...rows)), measures }
      : { ...wrong("A 2 MiB upload did not store and read back.", lines(...rows)), measures };
  },
});

const bulletinQuota = host({
  id: "host.limits.bulletinQuota",
  title: "Bulletin quota — what happens when it runs out",
  why: "A claim is 10 uploads and 4 MiB (almanac P6b), and nobody has seen what a Product gets when it is spent: an error, a hang, or a prompt. This uploads 32 bytes at a time until refused, then asks for another allowance and tries once more.",
  tier: TIER.SPEND,
  optIn: "spends-quota",
  cost: "Uses up every remaining Bulletin upload of this product's current claims (up to 80 uploads of 32 bytes), then requests one more claim. sondeprobes.dot may be unable to store for up to ~14 days.",
  needs: ["host.system.handshake"],
  timeoutMs: 1_200_000,
  async run(ctx) {
    const m = await preimages();
    const rows: string[] = [];
    let stored = 0;
    let refusal = "";
    for (let i = 0; i < 80 && !refusal; i++) {
      try {
        const w = await within(ctx.signal, 60_000, `upload ${i + 1}`, () => m.submit(random(32)));
        if (!w.ok) refusal = `upload ${i + 1} never answered (60 s)`;
        else stored++;
      } catch (e) {
        refusal = `upload ${i + 1} refused — ${errOf(e)}`;
      }
    }
    rows.push(pad("uploads stored", stored), pad("then", refusal || "no refusal within 80 uploads"));

    let topUp = "not tried";
    if (refusal) {
      const r = await requestResourceAllocation([{ tag: "BulletinAllowance", value: undefined } as never]).catch((e) => ({ ok: false, error: e }) as const);
      rows.push(pad("new allowance", r.ok ? JSON.stringify(r.value) : `failed — ${errOf((r as { error: unknown }).error)}`));
      try {
        const w = await within(ctx.signal, 60_000, "after top-up", () => m.submit(random(32)));
        topUp = w.ok ? "upload works again" : "still no answer";
      } catch (e) {
        topUp = `still refused — ${errOf(e)}`;
      }
      rows.push(pad("after top-up", topUp));
    }
    const measures = { uploadsBeforeRefusal: refusal ? stored : -1, refusal: refusal || "none", topUp };
    return refusal
      ? { ...ok(`Refused after ${stored} uploads: ${refusal}. Top-up: ${topUp}.`, lines(...rows)), measures }
      : { ...ok(`No refusal within 80 uploads — the claims hold more than that.`, lines(...rows)), measures };
  },
});

// -- Statement Store ------------------------------------------------------------

async function channelOf(label: string): Promise<`0x${string}`> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`sonde:${label}`)))) as `0x${string}`;
}

let sequence = 0;
/** (unix seconds << 32) | sequence — a later value is a newer statement. */
const expiryIn = (seconds: number) => (BigInt(Math.floor(Date.now() / 1000) + seconds) << 32n) | BigInt(++sequence & 0xffff);

/**
 * AccountFull's minExpiry is the shortest expiry the account holds. When it is i64::MAX the
 * account holds statements submitted with no expiry, which the store keeps as the maximum —
 * and a statement is refused if it would expire sooner than everything held. Found
 * 2026-09-19: sonde's own host.statement.submit had been submitting with no expiry on a
 * fresh topic every run, filling this product's account with statements that never expire.
 */
const NO_EXPIRY_HELD = "9223372036854775807";
const explain = (msg: string) =>
  msg.includes(`minExpiry=${NO_EXPIRY_HELD}`)
    ? `${msg} — the account is full of statements with NO expiry (stored as the maximum), so any statement with a finite expiry is refused`
    : msg;

async function submit(statement: { topics: string[]; channel?: string; expiry?: bigint; data: string }) {
  const store = await getStatementStore();
  if (!store) throw new Error("getStatementStore() returned null");
  const proof = await createProofAuthorized(statement as never);
  if (!proof.ok) throw new Error(`proof: ${formatHostError(proof.error)}`);
  await store.submit({ ...statement, proof: proof.value } as never);
}

async function trySubmit(ctx: Ctx, statement: Parameters<typeof submit>[0]): Promise<string> {
  try {
    const w = await within(ctx.signal, 30_000, "submit", () => submit(statement));
    return w.ok ? "accepted" : `no answer in ${w.ms} ms`;
  } catch (e) {
    return `refused — ${explain(errOf(e))}`;
  }
}

const topicNow = () => toHex(random(32));

const statementSize = host({
  id: "host.limits.statementSize",
  title: "Statement Store — exact size limit",
  why: "The SDK says 512 bytes a statement. This submits 256, 512, 513 and 1024 bytes on one channel (each replacing the last, so it holds one slot) and records what is refused and how.",
  tier: TIER.SPEND,
  cost: "Submits up to four statements on sonde's one limits channel, each replacing the previous. They carry no expiry, so the slot stays held.",
  needs: ["host.statement.submit"],
  timeoutMs: 180_000,
  async run(ctx) {
    // No expiry: while this account holds no-expiry statements, nothing finite is accepted.
    const channel = await channelOf("limits");
    const rows: string[] = [];
    let largest = 0;
    let beyond = "none up to 1024 B";
    for (const n of [256, 512, 513, 1024]) {
      const r = await trySubmit(ctx, { topics: [topicNow()], channel, data: toHex(random(n)) });
      rows.push(pad(`${n} B`, r));
      if (r !== "accepted") {
        beyond = `${n} B: ${r}`;
        break;
      }
      largest = n;
    }
    const measures = { largestOkBytes: largest, beyond };
    return largest
      ? { ...ok(`Largest statement accepted: ${largest} B. ${beyond === "none up to 1024 B" ? "Nothing refused up to 1024 B." : `Next: ${beyond}`}`, lines(...rows)), measures }
      : { ...wrong("Even 256 bytes was refused.", lines(...rows)), measures };
  },
});

const statementLatency = host({
  id: "host.limits.statementLatency",
  title: "Statement Store — time from submit to delivery",
  why: "Signalling a WebRTC call over statements is only as quick as a statement reaches a subscriber. This subscribes to a fresh topic, submits on it, and times the delivery back to the same phone — the lower bound for two phones.",
  tier: TIER.SPEND,
  cost: "Submits one small statement on sonde's one limits channel, replacing what is there. No expiry, so the slot stays held.",
  needs: ["host.statement.submit"],
  timeoutMs: 120_000,
  async run(ctx) {
    const store = await getStatementStore();
    if (!store) return unsupported("getStatementStore() returned null.");
    const topic = topicNow();
    const marker = toHex(random(16));
    let submittedAt = 0;
    const arrived = new Promise<number>((resolve) => {
      const sub = store.subscribe({ matchAny: [topic as `0x${string}`] }, (page) => {
        for (const s of page.statements as { data?: string }[]) {
          if (s.data && s.data.toLowerCase() === marker.toLowerCase()) resolve(performance.now());
        }
      });
      ctx.cleanup.add("latency-subscription", () => sub.unsubscribe());
    });
    // Let the subscription settle before submitting.
    await new Promise((r) => setTimeout(r, 1_000));
    submittedAt = performance.now();
    const r = await trySubmit(ctx, { topics: [topic], channel: await channelOf("limits"), data: marker });
    const submitMs = Math.round(performance.now() - submittedAt);
    if (r !== "accepted") return wrong(`Submit ${r}.`);
    const w = await within(ctx.signal, 60_000, "delivery", () => arrived);
    if (!w.ok) return { ...wrong(`Submitted in ${submitMs} ms, but the statement never reached this phone's own subscription within 60 s.`), measures: { submitMs, deliveredMs: -1 } };
    const deliveredMs = Math.round(w.value - submittedAt);
    return {
      ...ok(`Submit took ${submitMs} ms; delivered to the subscription ${deliveredMs} ms after submitting began.`, lines(pad("submit", `${submitMs} ms`), pad("delivered", `${deliveredMs} ms`))),
      measures: { submitMs, deliveredMs },
    };
  },
});

const statementExpiry = host({
  id: "host.limits.statementExpiry",
  title: "Statement Store — longest expiry",
  why: "almanac saw 90 days accepted. A long-lived pointer (a backup location, a standing offer) needs to know the ceiling. This tries 180, 365 and 730 days on one channel.",
  tier: TIER.SPEND,
  optIn: "spends-quota",
  cost: "Holds one statement slot of this product for up to two years: a later expiry replaces an earlier one, so the slot cannot be freed early.",
  needs: ["host.statement.submit"],
  timeoutMs: 180_000,
  async run(ctx) {
    const channel = await channelOf("limits.expiry");
    const rows: string[] = [];
    let longest = 0;
    for (const days of [180, 365, 730]) {
      const r = await trySubmit(ctx, { topics: [topicNow()], channel, expiry: expiryIn(days * 86_400), data: toHex(enc.encode(`sonde expiry ${days}d`)) });
      rows.push(pad(`${days} days`, r));
      if (r !== "accepted") break;
      longest = days;
    }
    return { ...ok(longest ? `Longest expiry accepted: ${longest} days.` : "Even 180 days was refused.", lines(...rows)), measures: { longestAcceptedDays: longest } };
  },
});

const statementCapacity = host({
  id: "host.limits.statementCapacity",
  title: "Statement Store — how many one account holds",
  why: "almanac's three runs disagreed (two, four, then 'added one without pushing others out'), and its sharing design rests on the answer. This submits 12 statements of 400 bytes on separate channels, then counts how many are still delivered — separating 'refused' from 'accepted but evicted another'.",
  tier: TIER.SPEND,
  optIn: "spends-quota",
  cost: "Submits up to 12 statements of 400 bytes with no expiry, on 12 fixed channels. Whatever the account keeps stays held, and may push this product's other statements out.",
  needs: ["host.statement.submit"],
  timeoutMs: 600_000,
  async run(ctx) {
    const store = await getStatementStore();
    if (!store) return unsupported("getStatementStore() returned null.");
    const topic = topicNow();
    const rows: string[] = [];
    let accepted = 0;
    let firstRefusal = "";
    for (let i = 0; i < 12; i++) {
      const data = new Uint8Array(400);
      data.set(random(400));
      data[0] = i; // which submission this is, read back below
      // No expiry: while the account holds no-expiry statements, a finite one is refused.
      // Channels are fixed per index, so re-running replaces rather than adds.
      const r = await trySubmit(ctx, { topics: [topic], channel: await channelOf(`limits.capacity.${i}`), data: toHex(data) });
      rows.push(pad(`#${i + 1}`, r));
      if (r === "accepted") accepted++;
      else if (!firstRefusal) firstRefusal = `#${i + 1}: ${r}`;
    }
    const seen = new Set<number>();
    const sub = store.subscribe({ matchAny: [topic as `0x${string}`] }, (page) => {
      for (const s of page.statements as { data?: string }[]) if (s.data) seen.add(parseInt(s.data.slice(2, 4), 16));
    });
    ctx.cleanup.add("capacity-subscription", () => sub.unsubscribe());
    await new Promise((r) => setTimeout(r, 10_000));
    sub.unsubscribe();
    rows.push("", pad("still delivered", `${seen.size}: #${[...seen].sort((a, b) => a - b).map((i) => i + 1).join(", #")}`));
    const measures = { submitted: 12, accepted, stillHeld: seen.size, firstRefusal: firstRefusal || "none" };
    return {
      ...ok(`${accepted} of 12 accepted; ${seen.size} still delivered afterwards${accepted > seen.size ? " — later ones evicted earlier ones" : ""}.`, lines(...rows)),
      measures,
    };
  },
});

/** Runs before any upload probe, so it measures earlier runs' uploads, not this one's. */
export const RETENTION_PROBES: Probe[] = [retention];

export const LIMIT_PROBES: Probe[] = [
  bridgePayload,
  concurrency,
  notificationLimits,
  localStorageCeiling,
  statementSize,
  statementLatency,
  statementExpiry,
  statementCapacity,
  preimageSize,
  bulletinQuota,
];

// Cloud storage, allowances, and the statement store.
//
// This is where kite's investigation stopped: reads worked, the allowance
// allocated, and uploads hung without ever erroring. The probes here preserve
// the two diagnostics that got that far — the permissionless read as a control,
// and the canary payload — and add the seal/round-trip as a self-contained
// WebCrypto exercise rather than an import from a sibling checkout.

import {
  requestResourceAllocation,
  requestPermission,
  getPreimageManager,
  getStatementStore,
  createProofAuthorized,
  formatHostError,
  toHex,
} from "@parity/product-sdk-host";
import type { App } from "@parity/product-sdk";
import { TIER, type Probe } from "../../core/types";
import { canary, kb, lines, ok, pad, probe, unsupported, wrong } from "../helpers";
import { rememberUpload } from "./uploads";

const CAT = "host-cloud";
const host = (p: Omit<Probe, "bank" | "category">): Probe => probe({ ...p, bank: "host", category: CAT });

const enc = new TextEncoder();

/**
 * A known-good CID.
 *
 * Reads are permissionless — no signature, no allowance, no account — which
 * makes this the control that separates "cloud storage is broken" from "the
 * write path is broken". kite's single most useful storage probe.
 *
 * *Corrected 2026-09-19:* this was a SHA-256 (bafybei…) CID. The host's lookup
 * finds BLAKE2b-256 content only (almanac P7), so it could never come back and
 * the probe reported a broken read. This one is almanac's P7 fixture: 79 bytes,
 * raw codec, BLAKE2b-256 — the way the SDK itself uploads — stored 2026-09-14
 * and verified through the devnet gateway on 2026-09-19. Bulletin keeps data
 * for about two weeks, so a timeout after ~2026-09-28 more likely means it
 * expired than that reads broke; host.cloud.roundTrip is the fresh control.
 */
const KNOWN_CID = "bafk2bzacebowgi5ykjhnh26gioxl4c3nwr5yu5rcw67i6mf3ksn7uhfo3q5ys";
const KNOWN_CID_STORED = "2026-09-14";

const read = host({
  id: "host.cloud.read",
  title: "Cloud storage read (no signature needed)",
  why: "Reads need no allowance and no signature. If this works while uploads hang, the fault is isolated to the write path — the difference between a broken feature and a broken service.",
  tier: TIER.INVOKE,
  needs: ["host.system.createApp"],
  timeoutMs: 90_000,
  async run(ctx) {
    const app = ctx.shared.app as App | undefined;
    const cs = app?.cloudStorage;
    if (!cs) return unsupported("cloudStorage is null on the App — it was constructed with storage disabled, or the host declined it.");

    const [res, ms] = await ctx.timed(() => cs.fetch(KNOWN_CID));
    if (!res.ok) {
      return {
        status: "fail",
        ms,
        detail: "Read returned an error.",
        data: lines(
          pad("cid", KNOWN_CID),
          pad("stored", `${KNOWN_CID_STORED} (Bulletin keeps ~2 weeks; after that this is expiry, not a broken read)`),
          pad("error", JSON.stringify(res.error)?.slice(0, 300)),
        ),
        diagnosis: "threw",
      };
    }

    // Content addressing means the CID is a checksum. Recomputing it proves the
    // host returned the right bytes rather than merely some bytes.
    const recomputed = await cs.computeCid(res.value);
    const verified = recomputed === KNOWN_CID;
    return {
      status: verified ? "pass" : "fail",
      ms,
      detail: verified
        ? `Fetched ${kb(res.value.length)} in ${ms} ms and the CID verifies. Reads work.`
        : "CID MISMATCH — the host returned bytes that do not hash to the requested CID.",
      data: lines(pad("requested", KNOWN_CID), pad("recomputed", recomputed), pad("bytes", res.value.length)),
      diagnosis: verified ? undefined : "wrong-result",
    };
  },
});

const seal = host({
  id: "host.cloud.seal",
  title: "Seal under a crypto-shred key (WebCrypto)",
  why: "A fresh random AES-256-GCM key is what makes expiry guaranteed rather than best-effort — storage never sees plaintext, so discarding the key is the deletion.",
  tier: TIER.INVOKE,
  timeoutMs: 30_000,
  async run(ctx) {
    // Self-contained. kite imported this from a sibling checkout, which is what
    // made it un-runnable by anyone else.
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = ctx.shared.jpeg ?? enc.encode(`sonde placeholder ${Date.now()}`);
    const usingPlaceholder = !ctx.shared.jpeg;

    const [ct, ms] = await ctx.timed(async () =>
      new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bufferOf(plaintext))),
    );

    ctx.shared.sealKey = key;
    ctx.shared.sealed = { iv: toHex(iv), ct: toHex(ct) };

    return ok(
      usingPlaceholder
        ? `Sealed a placeholder in ${ms} ms (run the camera probe first for a real payload).`
        : `Sealed ${kb(plaintext.length)} in ${ms} ms.`,
      lines(pad("algorithm", "AES-256-GCM"), pad("iv", toHex(iv)), pad("plaintext", kb(plaintext.length)), pad("ciphertext", kb(ct.length))),
    );
  },
});

const allowance = host({
  id: "host.cloud.allowance",
  title: "Request a Bulletin allowance",
  why: "Bulletin writes are gated by a per-account quota that is GRANTED, not bought, and a Product must ask for its own. Nothing uploads until this succeeds.",
  tier: TIER.PROMPT,
  gesture: true,
  needs: ["host.system.createApp"],
  timeoutMs: 150_000,
  async run(ctx) {
    const log: string[] = [];

    // The tag spelling is inconsistent across the SDK: the type declares
    // "BulletInAllowance" (capital I) while the host package's own example says
    // "BulletinAllowance". The second is the one that actually allocates; the
    // first throws inside the SDK. Correct one first, both tried.
    for (const tag of ["BulletinAllowance", "BulletInAllowance"]) {
      try {
        const r = await requestResourceAllocation([{ tag, value: undefined } as never]);
        if (!r.ok) {
          log.push(pad(tag, `err — ${formatHostError(r.error)}`));
          continue;
        }
        const outcomes = r.value as unknown[];
        log.push(pad(tag, JSON.stringify(outcomes)?.slice(0, 200)));
        const allocated = Array.isArray(outcomes) && outcomes.every((o) => o === "Allocated");

        if (allocated) {
          // The allocation creates a slot account. createApp already ran, before
          // that account existed, so its cloud-storage client holds a view of
          // the world with no allowance in it — a candidate explanation for an
          // upload that hangs rather than erroring. Rebuild so the next upload
          // starts from current state.
          const app = ctx.shared.app as App | undefined;
          if (app) {
            try {
              const { createApp } = await import("@parity/product-sdk");
              const { PRODUCT_ID } = await import("../../../product.mjs");
              const env = ctx.shared.appEnv ?? "devnet";
              const rebuilt = await createApp({ name: PRODUCT_ID, cloudStorage: { environment: env } });
              const acct = (await rebuilt.wallet.connect()).accounts[0];
              if (acct) rebuilt.wallet.selectAccount(acct.address);
              ctx.shared.app = rebuilt;
              log.push(pad("rebuild", `App re-created on "${env}" so storage sees the slot account`));
            } catch (e) {
              log.push(pad("rebuild", `failed — ${(e as Error).message}`));
            }
          }
          return ok("Allocated, and the App was rebuilt so cloud storage picks up the slot account.", lines(...log));
        }
        return wrong('Request returned, but not every resource came back "Allocated".', lines(...log));
      } catch (e) {
        log.push(pad(tag, `threw — ${(e as Error).message}`));
      }
    }

    return {
      status: "fail",
      detail: "Both tag spellings failed.",
      data: lines(
        ...log,
        "",
        "If no approval prompt appeared on the device, the host is not surfacing one — the same",
        "failure shape as a permission callback that is never answered.",
      ),
      diagnosis: "allowance-missing",
    };
  },
});

const upload = host({
  id: "host.cloud.upload",
  title: "Cloud storage upload (canary, then payload)",
  why: "The live test of storage authorization. A tiny canary before the real payload separates a size or chunking limit from a signing or authorization failure — same call either way, so the comparison is clean.",
  tier: TIER.SPEND,
  cost: "Writes to Bulletin under this Product's allowance and consumes quota. Data has a ~2-week TTL and is publicly readable by CID.",
  needs: ["host.cloud.seal"],
  timeoutMs: 180_000,
  async run(ctx) {
    const app = ctx.shared.app as App | undefined;
    const cs = app?.cloudStorage;
    if (!cs) return unsupported("cloudStorage is unavailable.");
    if (!ctx.shared.sealed) return unsupported("Nothing sealed — run the seal probe first.");

    const selected = app!.wallet.getSelectedAccount();
    if (!selected) {
      return {
        status: "fail",
        detail: "No account selected. The upload would stall rather than error — re-run host.account.connect.",
        diagnosis: "no-account-selected",
      };
    }

    const log: string[] = [pad("account", `${selected.address.slice(0, 10)}…`)];
    const payload = enc.encode(JSON.stringify(ctx.shared.sealed));

    const result = await canary(
      async (bytes) => {
        const r = await cs.upload(bytes);
        if (!r.ok) throw new Error(JSON.stringify(r.error)?.slice(0, 200) ?? "upload err");
        return r.value;
      },
      payload,
      log,
    );

    if ("failed" in result) {
      return result.phase === "canary"
        ? {
            status: "fail",
            detail: `Even a ~26-byte upload failed — this is not a size problem.`,
            data: lines(
              ...log,
              "",
              "The allowance request DOES raise a prompt, so the host can surface them. A store",
              "that produces none is therefore not a permission callback going unanswered.",
              "Either the write is sponsored by the slot account and never needed a tap and is",
              "hanging earlier, or it never reaches the signing path at all. Either way it",
              "should reject rather than stall.",
              "",
              "Known since almanac P6 (2026-09-14): cloudStorage.upload signs with product account #0,",
              "which holds no Bulletin authorization, so it is refused (Invalid: Payment). The",
              "allowance lands on a slot account only the host can sign with — host.preimage.submit",
              "tests that route.",
            ),
            diagnosis: "allowance-missing",
          }
        : wrong("The canary landed but the real payload did not — a size or chunking limit.", lines(...log));
    }

    ctx.shared.cid = result.value as string;
    return ok(
      `Stored ${kb(payload.length)}.`,
      lines(...log, pad("cid", ctx.shared.cid), "", "NOTE: ~2-week TTL. Not renewing is the expiry."),
    );
  },
});

/**
 * The upload route that works: the host's preimage manager, paid from the slot account
 * that BulletinAllowance funds (almanac P6b, 2026-09-16). Added 2026-09-19 — until then
 * sonde only tested cloudStorage.upload, the route that cannot work, so a Product author
 * reading a sonde report had no evidence the platform can store at all.
 */
const preimageSubmit = host({
  id: "host.preimage.submit",
  title: "Preimage submit — upload through the host, then read it back",
  why: "cloudStorage.upload signs with an account that holds no Bulletin authorization. The host's preimage manager signs with the slot account the allowance funds. This is the storage path a Product can actually use; the lookup afterwards proves the bytes landed.",
  tier: TIER.SPEND,
  cost: "Stores ~64 bytes on Bulletin from this Product's allowance (one of ~10 transactions a claim). Publicly readable by hash for ~2 weeks.",
  needs: ["host.cloud.allowance"],
  timeoutMs: 180_000,
  async run(ctx) {
    const log: string[] = [];
    const permission = await requestPermission({ tag: "PreimageSubmit", value: undefined });
    if (!permission.ok) return wrong(`PreimageSubmit permission errored: ${formatHostError(permission.error)}`);
    if (!permission.value) return { status: "blocked", detail: "PreimageSubmit was declined.", diagnosis: "os-denied" };
    const manager = await getPreimageManager();
    if (!manager) return unsupported("getPreimageManager() returned null.");

    // Random bytes, so every run stores something new and the lookup cannot be answered from an earlier run.
    const bytes = crypto.getRandomValues(new Uint8Array(64));
    const [key, putMs] = await ctx.timed(() => manager.submit(bytes));
    log.push(pad("submit", `${putMs} ms → ${String(key).slice(0, 18)}…`));
    // host.limits.retention looks this up again on later runs.
    await rememberUpload({ key: String(key), bytes: bytes.length, at: new Date().toISOString(), via: "host.preimage.submit" }).catch(() => {});

    const back = await new Promise<{ bytes: Uint8Array | null; ms: number }>((resolve) => {
      const t0 = performance.now();
      let sub: { unsubscribe(): void } | undefined;
      const done = (b: Uint8Array | null) => {
        clearTimeout(timer);
        try {
          sub?.unsubscribe();
        } catch {
          /* already gone */
        }
        resolve({ bytes: b, ms: Math.round(performance.now() - t0) });
      };
      const timer = setTimeout(() => done(null), 30_000);
      sub = manager.lookup(key as `0x${string}`, (b) => b && done(b));
      ctx.cleanup.add("preimage-submit-lookup", () => sub?.unsubscribe());
    });
    if (!back.bytes) return wrong("Stored, but the lookup of the returned key never answered in 30 s.", lines(...log));
    const same = back.bytes.length === bytes.length && back.bytes.every((b, i) => b === bytes[i]);
    log.push(pad("lookup", `${back.ms} ms, ${back.bytes.length} bytes, ${same ? "identical" : "DIFFERENT"}`));
    return same
      ? ok(`Stored 64 B in ${putMs} ms and read it back in ${back.ms} ms, byte for byte.`, lines(...log))
      : wrong("The lookup returned different bytes from those stored.", lines(...log));
  },
});

const roundTrip = host({
  id: "host.cloud.roundTrip",
  title: "Fetch → CID verify → decrypt",
  why: "Closes the loop. Content addressing proves the host returned the right bytes, and decryption proves the seal survived the trip — neither alone is sufficient.",
  tier: TIER.INVOKE,
  needs: ["host.cloud.upload"],
  timeoutMs: 120_000,
  async run(ctx) {
    const app = ctx.shared.app as App | undefined;
    const cs = app?.cloudStorage;
    if (!cs || !ctx.shared.cid || !ctx.shared.sealKey || !ctx.shared.sealed) {
      return unsupported("Needs a successful upload and a seal key first.");
    }

    const [res, ms] = await ctx.timed(() => cs.fetch(ctx.shared.cid!));
    if (!res.ok) return wrong("fetch returned an error.", JSON.stringify(res.error)?.slice(0, 300));

    const recomputed = await cs.computeCid(res.value);
    const cidOk = recomputed === ctx.shared.cid;

    const sealed = JSON.parse(new TextDecoder().decode(res.value)) as { iv: string; ct: string };
    const iv = hexToBytes(sealed.iv);
    const ct = hexToBytes(sealed.ct);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: bufferOf(iv) }, ctx.shared.sealKey, bufferOf(ct)),
    );

    return {
      status: cidOk ? "pass" : "fail",
      ms,
      detail: cidOk
        ? `Round-tripped in ${ms} ms; CID verified; ${kb(plain.length)} decrypted.`
        : "CID MISMATCH — the host returned bytes that do not hash to the requested CID.",
      data: lines(pad("requested", ctx.shared.cid), pad("recomputed", recomputed), pad("decrypted", kb(plain.length))),
      diagnosis: cidOk ? undefined : "wrong-result",
    };
  },
});

// -- statement store ---------------------------------------------------------

const statementSubscribe = host({
  id: "host.statement.subscribe",
  title: "Statement Store — subscribe (read-only)",
  why: "Reads need no signature. Testing them separately from submit means a failure can be attributed to the read path or the write path, not just to 'the statement store'.",
  tier: TIER.INVOKE,
  needs: ["host.system.handshake"],
  timeoutMs: 45_000,
  async run(ctx) {
    const store = await getStatementStore();
    if (!store) return unsupported("getStatementStore() returned null — not available to this Product.");

    const pages: number[] = [];
    // matchAny with an empty topic list is the broadest filter the type allows.
    const sub = store.subscribe({ matchAny: [] }, (page) =>
      pages.push((page as { statements?: unknown[] }).statements?.length ?? 0),
    );
    ctx.cleanup.add("statement-subscription", () => sub.unsubscribe());
    // Subscriptions expose an onInterrupt hook; a silent interruption is worth
    // catching, since it looks identical to "nothing published yet".
    let interrupted: string | null = null;
    sub.onInterrupt?.((reason) => {
      interrupted = String(reason).slice(0, 120);
    });

    await new Promise((r) => setTimeout(r, 6_000));

    if (interrupted) return wrong(`Subscription was interrupted: ${interrupted}`);
    return pages.length
      ? ok(`${pages.length} page(s) delivered.`, lines(pad("statements per page", pages.join(", "))))
      : ok(
          "Subscribed without error; no pages in 6 s.",
          "An empty topic filter on a quiet store legitimately delivers nothing, so this is not\na failure — but it also does not prove delivery works.",
        );
  },
});

const statementProof = host({
  id: "host.statement.createProof",
  title: "Statement Store — createProofAuthorized",
  why: "Proof creation is where the host's signing authority is exercised without yet writing anything. It fails distinctly from submit, which is what makes running it separately worthwhile.",
  tier: TIER.PROMPT,
  needs: ["host.system.handshake"],
  timeoutMs: 120_000,
  async run() {
    const topic = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const r = await createProofAuthorized({
      topics: [topic],
      data: toHex(enc.encode(`sonde ${Date.now()}`)),
    });
    if (!r.ok) {
      return {
        status: "fail",
        detail: `createProofAuthorized errored: ${formatHostError(r.error)}`,
        data: pad("topic", `${topic.slice(0, 14)}…`),
        diagnosis: "allowance-missing",
      };
    }
    return ok("Host produced an authorized proof.", lines(pad("proof tag", (r.value as { tag?: string })?.tag ?? "?"), pad("topic", `${topic.slice(0, 14)}…`)));
  },
});

const statementSubmit = host({
  id: "host.statement.submit",
  title: "Statement Store — submit",
  why: "The write path. Needs an allowance and a proof, and consumes a statement slot, so it is the clearest single test of whether a Product can publish at all.",
  tier: TIER.SPEND,
  cost: "Submits a signed statement to the Statement Store, consuming one of this Product's statement slots. Statements are public and expire per the store's TTL.",
  needs: ["host.statement.createProof"],
  timeoutMs: 180_000,
  async run() {
    const store = await getStatementStore();
    if (!store) return unsupported("getStatementStore() returned null.");

    const topic = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const statement = { topics: [topic], data: toHex(enc.encode(`sonde probe ${Date.now()}`)) };

    const proof = await createProofAuthorized(statement);
    if (!proof.ok) return wrong(`Could not create a proof to submit: ${formatHostError(proof.error)}`);

    await store.submit({ ...statement, proof: proof.value } as never);
    return ok(
      "Statement submitted.",
      lines(pad("topic", `${topic.slice(0, 14)}…`), "", "The statement is public and will expire per the store's TTL."),
    );
  },
});

/**
 * WebCrypto wants a `BufferSource` backed by a plain ArrayBuffer. A Uint8Array
 * is nominally `ArrayBufferLike`, which could be a SharedArrayBuffer, so recent
 * TypeScript lib definitions reject it. Copying into a fresh buffer is the
 * honest fix — casting would just hide a real (if unlikely) incompatibility.
 */
function bufferOf(u8: Uint8Array): ArrayBuffer {
  return u8.slice().buffer as ArrayBuffer;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export const CLOUD_PROBES: Probe[] = [
  read,
  seal,
  statementSubscribe,
  statementProof,
  allowance,
  upload,
  roundTrip,
  preimageSubmit,
  statementSubmit,
];

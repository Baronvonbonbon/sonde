// The remaining truapi namespaces: localStorage, theme, chain, notifications,
// chat, payment, coinPayment, preimage.
//
// Grouped in one file because each is a small number of probes sharing the same
// "get the manager, or null" idiom. Splitting them per namespace would be more
// files than content.

import {
  getHostLocalStorage,
  getThemeProvider,
  getChatManager,
  getNotificationManager,
  getPaymentManager,
  getPreimageManager,
  getChainSpec,
  getHostProvider,
  formatHostError,
  toHex,
} from "@parity/product-sdk-host";
import { TIER, type Probe } from "../../core/types";
import { lines, ok, pad, probe, unsupported, wrong } from "../helpers";

const host = (cat: string) => (p: Omit<Probe, "bank" | "category">): Probe =>
  probe({ ...p, bank: "host", category: cat });

// -- localStorage ------------------------------------------------------------

const ls = host("host-storage");

const localStorageRoundTrip = ls({
  id: "host.localStorage.roundTrip",
  title: "Host local storage — string, JSON, bytes",
  why: "The host's own per-product store, namespaced by product id. Distinct from web localStorage and not subject to the same partitioning, so it may work where the web one does not.",
  tier: TIER.INVOKE,
  needs: ["host.system.handshake"],
  timeoutMs: 45_000,
  async run(ctx) {
    const store = await getHostLocalStorage();
    if (!store) return unsupported("getHostLocalStorage() returned null.");

    const key = `sonde.probe.${Date.now()}`;
    ctx.cleanup.add("host-localstorage-key", () => store.clear(key).catch(() => {}));

    const rows: string[] = [];
    let failed = 0;

    try {
      await store.writeString(`${key}.s`, "sonde");
      const v = await store.readString(`${key}.s`);
      rows.push(pad("string", v === "sonde" ? "ok" : `MISMATCH — got "${v}"`));
      if (v !== "sonde") failed++;
      ctx.cleanup.add("host-ls-string", () => store.clear(`${key}.s`).catch(() => {}));
    } catch (e) {
      rows.push(pad("string", `threw — ${(e as Error).message}`));
      failed++;
    }

    try {
      const payload = { n: 42, nested: { ok: true }, list: [1, 2, 3] };
      await store.writeJSON(`${key}.j`, payload);
      const v = (await store.readJSON(`${key}.j`)) as typeof payload;
      const same = JSON.stringify(v) === JSON.stringify(payload);
      rows.push(pad("JSON", same ? "ok" : `MISMATCH — got ${JSON.stringify(v)?.slice(0, 80)}`));
      if (!same) failed++;
      ctx.cleanup.add("host-ls-json", () => store.clear(`${key}.j`).catch(() => {}));
    } catch (e) {
      rows.push(pad("JSON", `threw — ${(e as Error).message}`));
      failed++;
    }

    try {
      const bytes = crypto.getRandomValues(new Uint8Array(256));
      await store.writeBytes(`${key}.b`, bytes);
      const v = await store.readBytes(`${key}.b`);
      const same = v?.length === bytes.length && v.every((b, i) => b === bytes[i]);
      rows.push(pad("bytes (256B)", same ? "ok" : `MISMATCH — got ${v?.length ?? "undefined"} bytes`));
      if (!same) failed++;
      ctx.cleanup.add("host-ls-bytes", () => store.clear(`${key}.b`).catch(() => {}));
    } catch (e) {
      rows.push(pad("bytes (256B)", `threw — ${(e as Error).message}`));
      failed++;
    }

    return failed === 0
      ? ok("All three value types round-trip.", lines(...rows))
      : wrong(`${failed} of 3 value types failed to round-trip.`, lines(...rows));
  },
});

// -- theme -------------------------------------------------------------------

const theme = host("theme")({
  id: "host.theme.subscribe",
  title: "Theme subscription",
  why: "A Product that ignores the host theme looks broken next to native screens. This also exercises the subscription lifecycle — the runner's cleanup must actually unsubscribe.",
  tier: TIER.INVOKE,
  needs: ["host.system.handshake"],
  timeoutMs: 30_000,
  async run(ctx) {
    const provider = await getThemeProvider();
    if (!provider) return unsupported("getThemeProvider() returned null.");

    const seen: string[] = [];
    const sub = provider.subscribeTheme((t) => seen.push(JSON.stringify(t)));
    ctx.cleanup.add("theme-subscription", () => sub.unsubscribe());

    // A subscription that never delivers an initial value forces a Product to
    // guess, so waiting briefly is part of the test rather than politeness.
    await new Promise((r) => setTimeout(r, 2_500));

    return seen.length
      ? ok(`Received ${seen.length} theme update(s).`, lines(...seen.map((s, i) => pad(`update ${i + 1}`, s.slice(0, 120)))))
      : wrong(
          "Subscribed successfully but no theme was delivered in 2.5 s, not even a current value.",
          "A Product has nothing to render against until the user happens to change theme.",
        );
  },
});

// -- chain -------------------------------------------------------------------

const chain = host("chain");

const chainSpec = chain({
  id: "host.chain.genesis",
  title: "Chain spec — genesis, name, properties",
  why: "Resolves the genesis hash that the T3 spend allowlist checks against. No genesis, no spend: the runner refuses rather than guessing which chain it is on.",
  tier: TIER.INVOKE,
  needs: ["host.system.handshake"],
  timeoutMs: 45_000,
  async run(ctx) {
    // Devnet and paseo Asset Hub, the two a Products build is likely to carry.
    const candidates: [string, string][] = [
      ["Paseo Asset Hub", "0xd6eec26d5b1e9e4a9c5a1f2a9d3f6c1b2e8a4f7c3b9d5e1a7c4f8b2d6e0a3c9f"],
      ["Polkadot Asset Hub", "0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f"],
    ];

    const rows: string[] = [];
    for (const [name, genesis] of candidates) {
      const r = await getChainSpec(genesis as `0x${string}`);
      if (!r.ok) {
        rows.push(pad(name, `error — ${formatHostError(r.error)}`));
        continue;
      }
      if (!r.value) {
        rows.push(pad(name, "not carried by this host build"));
        continue;
      }
      rows.push(pad(name, `${r.value.name} · ${r.value.genesisHash.slice(0, 12)}…`));
      // First one that resolves becomes the T3 reference. The allowlist check
      // in the runner is what decides whether spending is permitted on it.
      ctx.shared.genesis ??= r.value.genesisHash;
      if (r.value.properties) {
        rows.push(pad("  properties", JSON.stringify(r.value.properties).slice(0, 120)));
      }
    }

    return ctx.shared.genesis
      ? ok(
          `Resolved a chain spec. Genesis ${ctx.shared.genesis.slice(0, 12)}… is now the reference for the T3 allowlist.`,
          lines(...rows),
        )
      : {
          status: "unsupported",
          detail: "No candidate chain resolved a spec. T3 probes will refuse for want of an identified chain, which is the intended behaviour.",
          data: lines(...rows),
          diagnosis: "chain-not-supported",
        };
  },
});

const chainProvider = chain({
  id: "host.chain.provider",
  title: "Host JSON-RPC provider",
  why: "The host proxies chain access so a Product needs no direct WebSocket. If this works where web.net.websocket is blocked, the host route is the only viable one.",
  tier: TIER.INVOKE,
  needs: ["host.chain.genesis"],
  timeoutMs: 45_000,
  async run(ctx) {
    const genesis = ctx.shared.genesis;
    if (!genesis) return unsupported("No genesis hash resolved.");
    const provider = await getHostProvider(genesis as `0x${string}`);
    if (!provider) return unsupported("getHostProvider() returned null for this chain.");
    return ok(
      "Host provider constructed.",
      lines(
        pad("genesis", `${genesis.slice(0, 16)}…`),
        pad("shape", typeof provider),
        "",
        "Compare with web.net.websocket: if that is blocked and this is not, the host proxy",
        "is the only route to chain data from a Product.",
      ),
    );
  },
});

// -- notifications -----------------------------------------------------------

const notifications = host("host-notifications")({
  id: "host.notifications.push",
  title: "Host push notification",
  why: "Separate from the web Notification API and not subject to the same permission. Which of the two works decides how a Product reaches a backgrounded user.",
  tier: TIER.PROMPT,
  needs: ["host.system.handshake"],
  timeoutMs: 60_000,
  async run(ctx) {
    const manager = await getNotificationManager();
    if (!manager) return unsupported("getNotificationManager() returned null.");

    const id = await manager.push({ text: "sonde capability probe — safe to dismiss." });
    // Cancelled immediately. A probe should not leave a notification in
    // someone's shade after the run.
    ctx.cleanup.add("host-notification", () => manager.cancel(id).catch(() => {}));

    return ok(
      "Host accepted a push notification.",
      lines(pad("notification id", String(id)), "", "Cancelled by cleanup — it should not remain in the notification shade."),
    );
  },
});

// -- chat --------------------------------------------------------------------

const chat = host("chat")({
  id: "host.chat.list",
  title: "Chat — list subscription",
  why: "An entire host namespace most Products never touch. Read-only here on purpose: registering a room or a bot would leave persistent state behind.",
  tier: TIER.INVOKE,
  needs: ["host.system.handshake"],
  timeoutMs: 30_000,
  async run(ctx) {
    const manager = await getChatManager();
    if (!manager) return unsupported("getChatManager() returned null — chat is not available to this Product.");

    const rooms: unknown[] = [];
    const sub = manager.subscribeChatList((r) => rooms.push(...r));
    ctx.cleanup.add("chat-subscription", () => sub.unsubscribe());
    await new Promise((r) => setTimeout(r, 2_500));

    return ok(
      `Chat namespace reachable; ${rooms.length} room(s) visible.`,
      lines(
        pad("rooms", rooms.length),
        "",
        "registerRoom and registerBot are NOT called: both create persistent host-side state,",
        "which a capability probe has no business leaving behind.",
      ),
    );
  },
});

// -- payment (read-only) -----------------------------------------------------

const payment = host("payment")({
  id: "host.payment.balance",
  title: "Payment — balance subscription (read-only)",
  why: "Reads the purse without moving anything. Whether a balance is even readable decides if the spend probes have any chance, and it costs nothing to ask.",
  tier: TIER.INVOKE,
  needs: ["host.system.handshake"],
  timeoutMs: 30_000,
  async run(ctx) {
    const manager = await getPaymentManager();
    if (!manager) return unsupported("getPaymentManager() returned null.");

    const seen: string[] = [];
    const sub = manager.subscribeBalance((b) => seen.push(JSON.stringify(b).slice(0, 160)));
    ctx.cleanup.add("payment-subscription", () => sub.unsubscribe());
    await new Promise((r) => setTimeout(r, 3_000));

    return seen.length
      ? ok(`Balance delivered.`, lines(...seen.map((s, i) => pad(`update ${i + 1}`, s))))
      : wrong(
          "Subscribed but no balance arrived in 3 s — not even a zero.",
          "A Product cannot show a balance, or decide whether it can afford anything.",
        );
  },
});

// -- preimage (read-only) ----------------------------------------------------

const preimage = host("preimage")({
  id: "host.preimage.lookup",
  title: "Preimage lookup (read-only)",
  why: "Reads are permissionless; submit is a chain write and lives at T3. Splitting them separates 'preimages are unreachable' from 'writing is blocked'.",
  tier: TIER.INVOKE,
  needs: ["host.system.handshake"],
  timeoutMs: 30_000,
  async run(ctx) {
    const manager = await getPreimageManager();
    if (!manager) return unsupported("getPreimageManager() returned null.");

    // A hash that certainly has no preimage. "Not found" is a successful
    // answer here — the probe is testing reachability, not content.
    const absent = ("0x" + "ab".repeat(32)) as `0x${string}`;
    let answered = false;
    let result = "no answer";
    const sub = manager.lookup(absent, (p) => {
      answered = true;
      result = p ? `${p.length} bytes` : "null (not found — a correct answer)";
    });
    ctx.cleanup.add("preimage-subscription", () => sub.unsubscribe());
    await new Promise((r) => setTimeout(r, 5_000));

    return answered
      ? ok("Lookup answered.", lines(pad("hash", `${absent.slice(0, 14)}…`), pad("result", result)))
      : wrong(
          "Lookup never called back in 5 s — neither a hit nor a miss.",
          "Calling code cannot distinguish 'still looking' from 'never will'.",
        );
  },
});

export const SERVICE_PROBES: Probe[] = [
  localStorageRoundTrip,
  theme,
  chainSpec,
  chainProvider,
  notifications,
  chat,
  payment,
  preimage,
];

/** Re-exported for the storage probes, which need the same hex helper. */
export { toHex };

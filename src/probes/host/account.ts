// truapi `account` + `signing` + `entropy` — identity and the signing split.

import {
  getAccountsProvider,
  deriveEntropy,
  formatHostError,
  toHex,
} from "@parity/product-sdk-host";
import type { App } from "@parity/product-sdk";
import { Wallet, verifyTypedData } from "ethers";
import { TIER, type Probe } from "../../core/types";
import { errText, lines, nt, ok, pad, probe, unsupported, wrong } from "../helpers";
import { PRODUCT_ID } from "../../../product.mjs";

const CAT = "account";
const host = (p: Omit<Probe, "bank" | "category">): Probe => probe({ ...p, bank: "host", category: CAT });

const walletConnect = host({
  id: "host.account.connect",
  title: "wallet.connect + selectAccount",
  why: "Connecting alone is not enough: upload() needs a SELECTED account, and a connected-but-unselected wallet makes storage calls stall rather than error. kite lost a session to exactly this.",
  tier: TIER.PROMPT,
  needs: ["host.system.createApp"],
  timeoutMs: 90_000,
  async run(ctx) {
    const app = ctx.shared.app as App | undefined;
    if (!app) return unsupported("No App — host.system.createApp did not produce one.");

    const r = await app.wallet.connect();
    const rows = [pad("accounts returned", r.accounts.length)];
    // Addresses are truncated. A shared report should not publish the
    // reporter's account in full.
    for (const a of r.accounts) rows.push(pad("  address", `${a.address.slice(0, 10)}…${a.address.slice(-6)}`));

    if (!r.accounts[0]) {
      return wrong("connect() succeeded but returned no accounts. Every storage and signing probe below will stall.", lines(...rows));
    }

    app.wallet.selectAccount(r.accounts[0].address);
    const selected = app.wallet.getSelectedAccount();
    rows.push(pad("selected", selected ? "yes" : "STILL NULL — uploads will stall, not error"));

    return selected
      ? ok(`Connected and selected an account.`, lines(...rows))
      : wrong("selectAccount() did not take. Uploads hang rather than failing, which is the hardest failure to diagnose.", lines(...rows));
  },
});

const anonymousAlias = host({
  id: "host.account.anonymousAlias",
  title: "Ring VRF anonymous alias",
  why: "Container-only, and the one identity primitive that does NOT link a user across actions. Whether it is stable per product or fresh per call decides whether it can be used for unlinkable attestation.",
  tier: TIER.INVOKE,
  needs: ["host.account.connect"],
  timeoutMs: 30_000,
  async run(ctx) {
    const app = ctx.shared.app as App | undefined;
    if (!app) return unsupported("No App available.");

    // Called twice on purpose. Stability across calls is the open question, and
    // a single call cannot answer it.
    const first = app.wallet.getAnonymousAlias();
    const second = app.wallet.getAnonymousAlias();

    if (first == null) {
      return unsupported("getAnonymousAlias() returned null — no alias in this runtime.", pad("first", "null"));
    }
    const stable = first === second;
    return ok(
      stable ? "Alias is stable across calls within a session." : "Alias is FRESH on each call.",
      lines(
        pad("call 1", `${first.slice(0, 12)}…`),
        pad("call 2", `${second?.slice(0, 12)}…`),
        pad("stable", stable),
        "",
        stable
          ? "A stable alias can correlate a user's actions within this product, which is the\ntrade-off for being usable as a persistent pseudonym."
          : "A fresh alias per call cannot correlate actions, which is stronger for privacy but\nmeans it cannot serve as an identifier a Product remembers.",
      ),
    );
  },
});

const productAccounts = host({
  id: "host.account.productAccounts",
  title: "Per-index product account derivation",
  why: "Distinct keys per derivation index is what makes per-order or per-session accounts possible without a seed backup. If indices collide, unlinkability is impossible.",
  tier: TIER.INVOKE,
  needs: ["host.system.handshake"],
  timeoutMs: 45_000,
  async run() {
    const provider = await getAccountsProvider();
    if (!provider) return unsupported("getAccountsProvider() returned null.");

    const rows: string[] = [];
    const keys = new Set<string>();
    for (const index of [0, 1, 2, 7]) {
      // AccountsProvider returns neverthrow, unlike the top-level host wrappers.
      const r = await nt(provider.getProductAccount(PRODUCT_ID, index));
      if (!r.ok) {
        rows.push(pad(`index ${index}`, `error — ${errText(r.error)}`));
        continue;
      }
      const pk = toHex((r.value as { publicKey: Uint8Array }).publicKey);
      rows.push(pad(`index ${index}`, `${pk.slice(0, 14)}…`));
      keys.add(pk);
    }

    if (keys.size === 0) return wrong("No derivation index produced an account.", lines(...rows));
    const distinct = keys.size === rows.filter((r) => !r.includes("error")).length;
    return distinct
      ? ok(`${keys.size} distinct key(s) across indices — per-index accounts are derivable.`, lines(...rows))
      : wrong("Different indices produced the SAME key. Per-order accounts would be linkable, defeating the point.", lines(...rows));
  },
});

const userId = host({
  id: "host.account.userId",
  title: "getUserId",
  why: "A stable per-user handle. Whether it exists at all decides if a Product can recognise a returning user without storing something itself.",
  tier: TIER.INVOKE,
  needs: ["host.system.handshake"],
  timeoutMs: 30_000,
  async run() {
    const provider = await getAccountsProvider();
    if (!provider) return unsupported("getAccountsProvider() returned null.");
    const r = await nt(provider.getUserId());
    if (!r.ok) {
      return { status: "fail" as const, detail: `getUserId errored: ${errText(r.error)}`, diagnosis: "not-implemented" as const };
    }
    const id = JSON.stringify(r.value);
    return ok("Returned a user id.", pad("shape", id.length > 60 ? `${id.slice(0, 60)}… (${id.length} chars)` : id));
  },
});

const legacyAccounts = host({
  id: "host.account.legacyAccounts",
  title: "getLegacyAccounts",
  why: "The pre-product account model. Its presence decides whether a Product must support two account shapes or one.",
  tier: TIER.INVOKE,
  needs: ["host.system.handshake"],
  timeoutMs: 30_000,
  async run() {
    const provider = await getAccountsProvider();
    if (!provider) return unsupported("getAccountsProvider() returned null.");
    const r = await nt(provider.getLegacyAccounts());
    if (!r.ok) {
      return { status: "fail" as const, detail: `errored: ${errText(r.error)}`, diagnosis: "not-implemented" as const };
    }
    const accounts = r.value as unknown[];
    return ok(`${accounts.length} legacy account(s).`, pad("count", accounts.length));
  },
});

const entropy = host({
  id: "host.account.deriveEntropy",
  title: "deriveEntropy — determinism",
  why: "Deterministic entropy is what lets a Product regenerate a local key from nothing but its own identity. If it is not deterministic, every derived key needs a backup instead.",
  tier: TIER.INVOKE,
  needs: ["host.system.handshake"],
  timeoutMs: 30_000,
  async run() {
    const key = new TextEncoder().encode("sonde-determinism-probe");
    const first = await deriveEntropy(key);
    if (!first.ok) {
      return { status: "fail" as const, detail: `deriveEntropy errored: ${formatHostError(first.error)}`, diagnosis: "not-implemented" as const };
    }
    // The whole value of this call is that the same input gives the same
    // output. One call cannot show that.
    const second = await deriveEntropy(key);
    if (!second.ok) return wrong("First call succeeded, second errored — non-deterministic by failure.");

    const a = toHex(first.value);
    const b = toHex(second.value);
    const different = await deriveEntropy(new TextEncoder().encode("sonde-different-input"));

    return a === b
      ? ok(
          "Deterministic: the same input gives the same entropy.",
          lines(
            pad("bytes", first.value.length),
            pad("same input", "identical output"),
            pad("different input", different.ok ? (toHex(different.value) === a ? "SAME OUTPUT — collision!" : "different output (correct)") : "errored"),
          ),
        )
      : wrong(
          "NOT deterministic — the same input produced different entropy on two calls. Any key derived from this cannot be regenerated.",
          lines(pad("call 1", `${a.slice(0, 20)}…`), pad("call 2", `${b.slice(0, 20)}…`)),
        );
  },
});

const signRaw = host({
  id: "host.account.signMessage",
  title: "wallet.signMessage",
  why: "The host-routed signature path. AutoSigning reports NotAvailable on both wallets, so this needs a tap — and if the host never raises the prompt, the promise never settles.",
  tier: TIER.PROMPT,
  gesture: true,
  needs: ["host.account.connect"],
  timeoutMs: 120_000,
  async run(ctx) {
    const app = ctx.shared.app as App | undefined;
    if (!app) return unsupported("No App available.");
    const message = `sonde probe ${new Date().toISOString()}`;
    const sig = await app.wallet.signMessage(message);
    return sig?.length
      ? ok(
          `Signed (${sig.length} bytes).`,
          lines(pad("message", message), pad("signature", `${toHex(sig).slice(0, 24)}…`)),
        )
      : wrong("signMessage resolved but produced no signature bytes.");
  },
});

const eip712 = host({
  id: "host.account.eip712",
  title: "EIP-712 with an app-local burner key",
  why: "The Polkadot App signs sr25519 and cannot produce an ecrecover-able signature, so EVM attestations need an app-local secp256k1 key. This proves that path still works inside the host runtime.",
  tier: TIER.INVOKE,
  timeoutMs: 30_000,
  async run(ctx) {
    // Placeholder domain on purpose. signTypedData and verifyTypedData never
    // touch the chain, so the domain's name and verifyingContract have no
    // bearing on whether signing and recovery work — only the type layout does.
    // Shipping live values would put a real contract address into a bundle
    // anyone can fetch by CID, which identifies the caller in one lookup.
    const domain = {
      name: "TypedDataProbe",
      version: "1",
      chainId: 420420417,
      verifyingContract: "0x0000000000000000000000000000000000000042",
    };
    const types = {
      Attestation: [
        { name: "id", type: "uint256" },
        { name: "phase", type: "uint8" },
        { name: "actor", type: "address" },
        { name: "commit", type: "bytes32" },
        { name: "timestamp", type: "uint64" },
      ],
    };

    const burner = Wallet.createRandom();
    const value = {
      id: "424242",
      phase: 1,
      actor: burner.address,
      commit: "0x" + "11".repeat(32),
      timestamp: Math.floor(Date.now() / 1000),
    };

    const [sig, ms] = await ctx.timed(() => burner.signTypedData(domain, types, value));
    const recovered = verifyTypedData(domain, types, value, sig);
    const matched = recovered.toLowerCase() === burner.address.toLowerCase();

    return matched
      ? ok(
          `Signed and recovered in ${ms} ms — a contract's ecrecover would accept this.`,
          lines(pad("burner", burner.address), pad("recovered", recovered), pad("chainId", domain.chainId)),
        )
      : wrong(`Recovery mismatch: expected ${burner.address}, got ${recovered}.`);
  },
});

export const ACCOUNT_PROBES: Probe[] = [
  userId,
  productAccounts,
  legacyAccounts,
  entropy,
  eip712,
  walletConnect,
  anonymousAlias,
  signRaw,
];

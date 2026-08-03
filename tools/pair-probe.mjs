#!/usr/bin/env node
// The QR-paired workstation half.
//
// Carried over from kite's allowance-probe.mjs, which answered questions the
// browser half cannot: @parity/product-sdk-terminal pairs to the mobile
// Polkadot App over a QR code and gives you a signer without the key ever
// touching this machine. That makes two things checkable from a laptop:
//
//   1. hasBulletinAllowance / hasStatementStoreAllowance — the allowance state
//      the in-app probes can only infer from whether an upload succeeded.
//   2. deriveProductPublicKey per index — whether per-order accounts are
//      derivable, without needing the host container.
//
// Nothing is written on-chain: this only reads allowance state and derives
// public keys.
//
// Usage:  node tools/pair-probe.mjs [--product <id>] [--index 1]

import {
  createTerminalAdapter,
  createNodeStorageAdapter,
  waitForSessions,
  renderQrCode,
  hasBulletinAllowance,
  hasStatementStoreAllowance,
  deriveProductPublicKey,
  sessionRootPublicKey,
} from "@parity/product-sdk-terminal";

import { PRODUCT_ID as DEFAULT_PRODUCT } from "../product.mjs";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const PRODUCT_ID = arg("--product", DEFAULT_PRODUCT);
const ALT_INDEX = Number(arg("--index", "1"));
const PAIR_TIMEOUT_MS = 180_000;

const hex = (u8) => "0x" + Buffer.from(u8).toString("hex");
const line = (k, v) => console.log(`  ${String(k).padEnd(26)} ${v}`);

async function main() {
  console.log(`\nsonde — paired probe, product "${PRODUCT_ID}"\n`);

  const adapter = await createTerminalAdapter({
    appId: PRODUCT_ID,
    storage: createNodeStorageAdapter(PRODUCT_ID),
  });

  // A stored session means a previous run already paired.
  let sessions = await waitForSessions(adapter, 1_000).catch(() => []);
  if (!sessions?.length) {
    const uri = await adapter.getPairingUri?.();
    if (!uri) {
      console.error("Adapter exposed no pairing URI — check @parity/product-sdk-terminal's version.");
      process.exit(2);
    }
    console.log(await renderQrCode(uri));
    console.log("\nScan with the Polkadot App to pair. Waiting up to 3 minutes…\n");
    sessions = await waitForSessions(adapter, PAIR_TIMEOUT_MS);
  }

  if (!sessions?.length) {
    console.error("No session established — pairing timed out.");
    process.exit(1);
  }

  const session = sessions[0];
  console.log("Paired ✓\n");
  console.log("SESSION");
  line("root public key", hex(sessionRootPublicKey(session)));

  console.log("\nPRODUCT ACCOUNTS  (ProductAccountRef = { productId, derivationIndex })");
  const keys = new Set();
  for (const derivationIndex of [0, ALT_INDEX]) {
    try {
      const pk = deriveProductPublicKey(session, { productId: PRODUCT_ID, derivationIndex });
      keys.add(hex(pk));
      line(`index ${derivationIndex}`, hex(pk));
    } catch (e) {
      line(`index ${derivationIndex}`, `FAILED: ${e.message}`);
    }
  }
  console.log(
    keys.size > 1
      ? "  → distinct keys per index: per-order accounts are derivable without a seed backup."
      : "  → indices did NOT produce distinct keys, so per-order accounts would be linkable.",
  );

  console.log("\nALLOWANCES");
  for (const [label, fn] of [
    ["Bulletin", hasBulletinAllowance],
    ["Statement Store", hasStatementStoreAllowance],
  ]) {
    try {
      line(`${label} allowance`, (await fn(adapter, PRODUCT_ID)) ? "YES" : "no");
    } catch (e) {
      line(`${label} allowance`, `ERROR: ${e.message}`);
    }
  }

  console.log(
    "\nNOTE  AutoSigning reports NotAvailable on both the Android and iOS wallets\n" +
      "      (documented in @parity/product-sdk-terminal's own types). Every host-routed\n" +
      "      signature therefore needs a tap, which is why the in-app suite queues gesture\n" +
      "      probes one at a time rather than looping them.\n",
  );

  await adapter.close?.();
}

main().catch((e) => {
  console.error("\npaired probe failed:", e);
  process.exit(1);
});

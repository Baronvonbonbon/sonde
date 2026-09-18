#!/usr/bin/env node
// Publish sonde under a label of your choosing, owned and updated by the local deploy key.
//
// History, 2026-09-18 (DEPLOY.md has the detail). Publishing through the phone could not hold a name:
// pad's phone signer is a product account the wallet derives and never reveals, and it moved when
// product-sdk-keys 0.4 changed the derivation — so caniusethis.dot (owned by the August account) and
// sondeprobe.dot (handed to the root pad displayed) can no longer be updated by it. A deploy key on
// this computer owns the name and signs its updates, as almanac does; the phone is not involved.
//
// The steps, in order:
//   1. the key      — tools/deploy-key.mjs; its address, and enough PAS for what is about to happen
//   2. the name     — read-only DotNS lookup (tools/whois.mjs). Owned by the key: update it. Unowned:
//                     registering is permanent, so it needs --register and the label typed back.
//                     Owned by anyone else: stop.
//   3. PRODUCT_ID   — product.mjs is rewritten to the label (the invariant check-identity enforces)
//   4. verify, build, check-identity, leak grep — DEPLOY.md "Before every publish"
//   5. pad, as a library — the key signs DotNS, one of pad's pool accounts signs the Bulletin upload
//
// Usage:  npm run deploy -- <label> [--register] [--check]
//   --register    allow registering an unowned label (permanent, ~10 PAS from the key)
//   --check       stop after the key and name checks: nothing is built, uploaded or signed

import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { ethers } from "ethers";
import { KEY_FILE, accountOf, readKey } from "./deploy-key.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV = "devnet";
const RPC = "https://eth-rpc-testnet.polkadot.io/"; // Paseo Asset Hub, where DotNS lives (chain 420420417)
const REGISTER_PAS = 12; // the name is 10 PAS (whois prints the exact price), plus fees
const UPDATE_PAS = 0.1; // a contenthash update is one contract call

const args = process.argv.slice(2);
const label = args.find((a) => !a.startsWith("--"))?.replace(/\.dot$/i, "").toLowerCase();
const register = args.includes("--register");
const checkOnly = args.includes("--check");

const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { cwd: root, encoding: "utf8", ...opts });
function die(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}
async function ask(q) {
  if (!process.stdin.isTTY) die("this step needs an interactive terminal");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(q)).trim();
  rl.close();
  return a;
}
const step = (s) => console.log(`\n── ${s} ${"─".repeat(Math.max(0, 60 - s.length))}`);

if (!label) die("usage: npm run deploy -- <label> [--register] [--check]");
if (!/^[a-z0-9-]+$/.test(label)) die(`"${label}" is not a DotNS label (lowercase letters, digits, hyphens)`);

// 1 ── the key ─────────────────────────────────────────────────────────────
step("deploy key");
const mnemonic = readKey();
if (!mnemonic) die(`No deploy key in ${KEY_FILE}. Create one with \`npm run deploy-key\`, then fund its address.`);
const key = accountOf(mnemonic);
const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
if ((await provider.getNetwork()).chainId !== 420420417n) die(`${RPC} is not Paseo Asset Hub — refusing`);
const balance = Number(ethers.formatEther(await provider.getBalance(key.h160)));
console.log(`  ${KEY_FILE}\n  ${key.ss58}\n  ${key.h160}   ${balance} PAS`);

// 2 ── the name ────────────────────────────────────────────────────────────
step(`${label}.dot`);
const whois = run("node", ["tools/whois.mjs", label]);
if (whois.status !== 0) die(`whois failed:\n${whois.stderr}`);
process.stdout.write(whois.stdout);
const owner = whois.stdout.match(/owner\s+(\S+)/)?.[1];
const padRule = whois.stdout.match(/pad\s+(.+)/)?.[1]?.trim();
const unowned = !owner || owner === "none";

if (padRule && padRule !== "any account") {
  die(`pad will want "${padRule}" for this label. Pick a base of 9+ letters (see DEPLOY.md).`);
}
if (unowned) {
  if (!register) {
    die(
      `${label}.dot is unowned. Publishing registers it to the deploy key — permanently, on-chain, for\n` +
        "the price above. Re-run with --register if that is what you want.",
    );
  }
  if (balance < REGISTER_PAS) die(`Registering needs about ${REGISTER_PAS} PAS; the key holds ${balance}. Fund ${key.ss58} first.`);
  console.log("  → will register it to the deploy key (you passed --register)");
} else if (owner.toLowerCase() === key.h160) {
  if (balance < UPDATE_PAS) die(`Updating needs about ${UPDATE_PAS} PAS for fees; the key holds ${balance}. Fund ${key.ss58} first.`);
  console.log("  → owned by the deploy key");
} else {
  die(
    `${label}.dot is owned by ${owner}, not the deploy key (${key.h160}). The key can only update a\n` +
      "name it owns — pick another label, or transfer this one to the key from its owner.",
  );
}

if (checkOnly) {
  console.log("\n--check: key and name are fine; nothing built, uploaded or signed.");
  process.exit(0);
}

// Registering cannot be undone, so ask for the name back rather than a y/n.
if (unowned) {
  const typed = await ask(`\n  ${label}.dot will be registered for good. Type ${label}.dot to continue: `);
  if (typed !== `${label}.dot`) die("aborted");
}

// 3 ── PRODUCT_ID ─────────────────────────────────────────────────────────
step("PRODUCT_ID");
const productPath = resolve(root, "product.mjs");
const product = readFileSync(productPath, "utf8");
const idLine = /export const PRODUCT_ID = "([^"]*)";/;
const current = product.match(idLine)?.[1];
if (current === undefined) die("could not find PRODUCT_ID in product.mjs");
if (current !== label) {
  writeFileSync(productPath, product.replace(idLine, `export const PRODUCT_ID = "${label}";`));
  console.log(`  product.mjs: "${current}" → "${label}" (commit this with the deploy record)`);
} else {
  console.log(`  already "${label}"`);
}

// 4 ── checks ─────────────────────────────────────────────────────────────
for (const [name, cmd, argv] of [
  ["verify", "npm", ["run", "verify", "--silent"]],
  ["build", "npm", ["run", "build", "--silent"]],
  ["check-identity", "node", ["tools/check-identity.mjs", `${label}.dot`, "--env", ENV]],
]) {
  step(name);
  const r = run(cmd, argv, { stdio: "inherit" });
  if (r.status !== 0) die(`${name} failed — not publishing`);
}

step("leak grep");
const leak = run("sh", ["-c", String.raw`grep -oiE "\bfare\b|docs/|§" dist/assets/index-*.js | sort | uniq -c`]);
if (leak.stdout.trim()) die(`the bundle names upstream paths:\n${leak.stdout}`);
console.log("  clean");

// 5 ── publish ────────────────────────────────────────────────────────────
// pad as a library, not its CLI (almanac, 2026-09-12): the CLI signs the Bulletin upload with the
// owner key whenever one is set, and an owner key is not authorized to store on devnet. pad's shared
// upload pool is. So the key signs DotNS and a pool account signs the upload — a pool account can
// spend upload quota and nothing more: it never owns the name or sets what it points to.
//
// transferToSignedInUser is forced off. pad defaults it on whenever a login session exists, and would
// hand the finished name to the phone account — the way both earlier names were stranded.
step("publish");
process.env.PAD_TELEMETRY = "0";
const { derivePoolAccounts } = await import("@polkadot-community-foundation/polkadot-app-deploy");
const { deploy } = await import("@polkadot-community-foundation/polkadot-app-deploy/deploy");
const pool = derivePoolAccounts();
// If this one's authorization has lapsed, pad falls back to another authorized pool account.
const uploader = pool[randomInt(pool.length)];
console.log(`  Owner and DotNS signer: the deploy key ${key.ss58}`);
console.log(`  Upload signer: pad's pool account ${uploader.index} (${uploader.address})\n`);
try {
  const result = await deploy(join(root, "dist"), `${label}.dot`, {
    mnemonic,
    storageSigner: uploader.signer,
    storageSignerAddress: uploader.address,
    transferToSignedInUser: false,
    env: ENV,
    jsMerkle: true,
  });
  console.log(`\nPublished ${result.fullDomain} — ${result.cid}`);
  console.log(`Record the CID in DEPLOY.md. Close the Polkadot app fully, then open ${label}.dot.`);
  process.exit(0); // pad can leave chain connections open after it finishes
} catch (e) {
  die(`Deployment failed: ${e?.message ?? e}\nUploads are incremental, so re-running is cheap.`);
}

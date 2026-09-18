#!/usr/bin/env node
// Publish sonde under a label of your choosing — with every check in front of `pad`.
//
// Written 2026-09-18 after caniusethis.dot turned out to belong to an account the current signer is
// not (0xFF54…333f, the owner DEPLOY.md recorded), so the SDK-bumped build had nowhere to go.
// The steps, in order, and why each is here:
//
//   1. pad whoami   — who will own the name. The mix-up above was a signer nobody looked at.
//   2. whois        — read-only DotNS lookup (eth_call only). An unowned label is registered for
//                     good, and pad registers any eligible name it is pointed at, so a first publish
//                     needs --register; a label owned by someone else stops here.
//   3. PRODUCT_ID   — product.mjs is rewritten to the label (the invariant check-identity enforces).
//   4. verify, build, check-identity, leak grep — DEPLOY.md "Before every publish".
//   5. pad          — interactive: republishing asks for a phone signature, and stdin must stay open.
//
// Usage:  npm run deploy -- <label> [--register] [--yes-owner]
//   --register    allow registering an unowned label (permanent, ~10 PAS)
//   --yes-owner   skip the "is this owner you?" question when the label is already owned

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV = "devnet";
const PAD = ["--yes", "@polkadot-community-foundation/polkadot-app-deploy@0.16.6"];

const args = process.argv.slice(2);
const label = args.find((a) => !a.startsWith("--"))?.replace(/\.dot$/i, "").toLowerCase();
const register = args.includes("--register");
const yesOwner = args.includes("--yes-owner");

if (!label) {
  console.error("usage: npm run deploy -- <label> [--register] [--yes-owner]");
  process.exit(2);
}
if (!/^[a-z0-9-]+$/.test(label)) die(`"${label}" is not a DotNS label (lowercase letters, digits, hyphens)`);

const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { cwd: root, encoding: "utf8", ...opts });
function die(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}
async function ask(q) {
  if (!process.stdin.isTTY) die("this step needs an interactive terminal");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(q)).trim().toLowerCase();
  rl.close();
  return a === "y" || a === "yes";
}
const step = (s) => console.log(`\n── ${s} ${"─".repeat(Math.max(0, 60 - s.length))}`);

// 1 ── the signer ──────────────────────────────────────────────────────────
step("signer");
const who = run("npx", [...PAD, "whoami", "--env", ENV], { input: "" });
const whoText = `${who.stdout}${who.stderr}`.trim();
if (/not logged in/i.test(whoText)) {
  die(
    "pad is not signed in, so a first publish could not be handed to your account and a republish\n" +
      "could not be signed. Sign in with your phone first, then run this again:\n\n" +
      `  npx ${PAD.slice(1).join(" ")} login --env ${ENV}`,
  );
}
console.log(whoText.split("\n").map((l) => `  ${l}`).join("\n"));
const signerAddrs = [...whoText.matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => m[0].toLowerCase());

// 2 ── the name ────────────────────────────────────────────────────────────
step(`${label}.dot`);
const whois = run("node", ["tools/whois.mjs", label]);
if (whois.status !== 0) die(`whois failed:\n${whois.stderr}`);
process.stdout.write(whois.stdout);
const owner = whois.stdout.match(/owner\s+(\S+)/)?.[1];
const padRule = whois.stdout.match(/pad\s+(.+)/)?.[1]?.trim();

if (padRule && padRule !== "any account") {
  die(`pad will want "${padRule}" for this label. Pick a base of 9+ letters (see DEPLOY.md).`);
}
if (!owner || owner === "none") {
  if (!register) {
    die(
      `${label}.dot is unowned. Publishing registers it — permanently, on-chain, for the price above —\n` +
        `and hands it to the signed-in account. Re-run with --register if that is what you want.`,
    );
  }
  console.log("  → will register (you passed --register)");
} else if (signerAddrs.includes(owner.toLowerCase())) {
  console.log("  → owned by the signed-in account");
} else if (!yesOwner) {
  console.log(
    `\n  Owned by ${owner}. pad's whoami did not print that address, and a label owned by another\n` +
      "  account uploads the bundle and then fails to link it (what happened to caniusethis.dot).",
  );
  if (!(await ask("  Is that address your signed-in account? [y/N] "))) die("stopped — pick another label");
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
step("publish");
console.log(
  "  pad may ask you to approve on your phone and then press Y. Approve FIRST, then press Y —\n" +
    "  pressing Y early makes pad collect a signature that does not exist yet (DEPLOY.md).\n",
);
const pub = run("npx", [...PAD, "./dist", `${label}.dot`, "--env", ENV, "--js-merkle"], { stdio: "inherit" });
if (pub.status !== 0) die("pad failed — uploads are incremental, so re-running is cheap");
console.log(
  `\nPublished. Open ${label}.dot in the Polkadot app, and record the CID and transactions in DEPLOY.md.\n` +
    `Run host.permissions.location first, then web.sensors.geolocation.`,
);

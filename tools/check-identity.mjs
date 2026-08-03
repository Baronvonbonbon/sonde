#!/usr/bin/env node
// Refuse to deploy when PRODUCT_ID does not match the target label.
//
// This exists because the mistake it prevents was actually made: the bundle was
// built with PRODUCT_ID="caniuse" and then deployed to caniusethis.dot. The
// invariant is documented at the top of product.mjs, and documenting it was not
// enough — the host derives product accounts and allowance lookups from
// PRODUCT_ID, so a mismatched build reports a confident "no" for every Bank B
// probe instead of failing loudly.
//
// A drift like that is invisible in the deploy output and invisible in the UI.
// The only place it can be caught cheaply is here, before `pad` runs.
//
// Usage:  node tools/check-identity.mjs <domain.dot>

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { PRODUCT_ID, CLOUD_ENV } = await import(resolve(root, "product.mjs"));

const domain = process.argv[2];
if (!domain) {
  console.error("usage: node tools/check-identity.mjs <domain.dot> [--env <id>]");
  process.exit(2);
}

const label = domain.replace(/\.dot$/i, "");
const envFlag = process.argv.includes("--env") ? process.argv[process.argv.indexOf("--env") + 1] : null;

let bad = false;

if (label !== PRODUCT_ID) {
  console.error(
    `\nIDENTITY MISMATCH — refusing to deploy.\n\n` +
      `  product.mjs PRODUCT_ID : ${PRODUCT_ID}\n` +
      `  deploy target label    : ${label}\n\n` +
      `The host derives product accounts and the local-storage namespace from PRODUCT_ID,\n` +
      `and allowances are looked up per product. Publishing this build under "${label}"\n` +
      `would make every Bank B probe exercise an identity that never published anything —\n` +
      `and report a confident "no" rather than an error.\n\n` +
      `Fix: set PRODUCT_ID = "${label}" in product.mjs, rebuild, then deploy.\n`,
  );
  bad = true;
}

if (envFlag && envFlag !== CLOUD_ENV) {
  console.error(
    `\nENVIRONMENT MISMATCH — refusing to deploy.\n\n` +
      `  product.mjs CLOUD_ENV : ${CLOUD_ENV}\n` +
      `  pad --env             : ${envFlag}\n\n` +
      `The SDK asks the host for the cloud-storage chain named by CLOUD_ENV. Publishing under\n` +
      `a different environment makes createApp request a chain this host build does not carry,\n` +
      `and every storage probe downstream is skipped.\n`,
  );
  bad = true;
}

// The built bundle is what actually ships, so check it rather than trusting
// that someone rebuilt after editing product.mjs.
try {
  const { readdirSync } = await import("node:fs");
  const assets = resolve(root, "dist/assets");
  const bundles = readdirSync(assets).filter((f) => /^index-.*\.js$/.test(f));
  const found = bundles.some((f) => readFileSync(resolve(assets, f), "utf8").includes(`"${PRODUCT_ID}"`));
  if (!found) {
    console.error(
      `\nSTALE BUILD — refusing to deploy.\n\n` +
        `  PRODUCT_ID "${PRODUCT_ID}" does not appear in any dist/assets/index-*.js\n\n` +
        `product.mjs was edited but the bundle was not rebuilt. Run: npm run build\n`,
    );
    bad = true;
  }
} catch {
  console.error("\nNo dist/ to check — run `npm run build` first.\n");
  bad = true;
}

if (bad) process.exit(1);
console.log(`identity ok — PRODUCT_ID "${PRODUCT_ID}" matches ${domain} on env "${CLOUD_ENV}"`);

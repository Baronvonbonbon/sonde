#!/usr/bin/env node
// Compare two sonde reports.
//
// One report is an anecdote. Two reports from the same device on different
// surfaces isolate a fault to the runtime; two reports from the same surface on
// different app builds isolate it to a release. That comparison is the whole
// reason the schema is machine-readable, and doing it by eye across ~140 rows
// is not realistic.
//
// Usage:
//   node tools/diff-report.mjs before.json after.json [--md] [--all]
//
// Exits 1 when anything regressed, so it can gate CI.

import { readFileSync } from "node:fs";

const SCHEMA = "sonde-report/1";

// Ordered worst to best. A move down this list is a regression and a move up is
// a fix — the only judgement this tool makes, so it is stated plainly in one
// place.
//
// `skip` is deliberately NOT on this scale. It does not mean "fine", it means
// "not measured": the tier was locked, or a precondition was unmet, or the
// operator skipped it. Ranking it alongside real outcomes makes every tier
// increase look like a wall of regressions and every tier decrease look like a
// wall of fixes, which would render the tool useless in exactly the comparison
// it exists for. Transitions in and out of `skip` get their own sections.
const SEVERITY = ["crashed", "timeout", "fail", "blocked", "unsupported", "pass"];
const rank = (s) => {
  const i = SEVERITY.indexOf(s);
  return i === -1 ? SEVERITY.length : i;
};
const measured = (s) => s !== "skip";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [beforePath, afterPath] = args.filter((a) => !a.startsWith("--"));

if (!beforePath || !afterPath) {
  console.error("usage: node tools/diff-report.mjs <before.json> <after.json> [--md] [--all]");
  process.exit(2);
}

const before = load(beforePath);
const after = load(afterPath);

function load(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    console.error(`cannot read ${path}: ${e.message}`);
    process.exit(2);
  }
  let r;
  try {
    r = JSON.parse(raw);
  } catch (e) {
    console.error(`${path} is not valid JSON: ${e.message}`);
    process.exit(2);
  }
  if (r.schema !== SCHEMA) {
    // Refuse rather than guess. A silently mis-parsed report produces a
    // confident diff that is wrong, which is worse than no diff.
    console.error(`${path}: schema is "${r.schema}", expected "${SCHEMA}".`);
    process.exit(2);
  }
  return r;
}

const beforeById = new Map(before.results.map((r) => [r.id, r]));
const afterById = new Map(after.results.map((r) => [r.id, r]));

const regressions = [];
const fixes = [];
const changes = [];
const nowMeasured = [];
const noLongerMeasured = [];
const added = [];
const removed = [];

for (const [id, a] of afterById) {
  const b = beforeById.get(id);
  if (!b) {
    added.push(a);
    continue;
  }
  if (a.status === b.status) continue;
  const entry = { id, title: a.title, from: b.status, to: a.status, detail: a.detail, diagnosis: a.diagnosis };

  if (!measured(b.status) && measured(a.status)) nowMeasured.push(entry);
  else if (measured(b.status) && !measured(a.status)) noLongerMeasured.push(entry);
  else if (rank(a.status) < rank(b.status)) regressions.push(entry);
  else if (rank(a.status) > rank(b.status)) fixes.push(entry);
  else changes.push(entry);
}

// Within "newly measured", lead with the ones that came back bad — those are
// the actionable rows even though they are not regressions.
nowMeasured.sort((x, y) => rank(x.to) - rank(y.to));
for (const [id, b] of beforeById) {
  if (!afterById.has(id)) removed.push(b);
}

regressions.sort((x, y) => rank(x.to) - rank(y.to));

// -- environment delta -------------------------------------------------------

const envRows = [];
const cmp = (label, x, y) => {
  if (String(x) !== String(y)) envRows.push({ label, from: x, to: y });
};
cmp("surface", before.fingerprint.surface.surface, after.fingerprint.surface.surface);
cmp("chromium", before.fingerprint.browser.chromium, after.fingerprint.browser.chromium);
cmp("device", before.fingerprint.browser.uaData?.model, after.fingerprint.browser.uaData?.model);
cmp(
  "platform",
  `${before.fingerprint.browser.uaData?.platform ?? "?"} ${before.fingerprint.browser.uaData?.platformVersion ?? ""}`.trim(),
  `${after.fingerprint.browser.uaData?.platform ?? "?"} ${after.fingerprint.browser.uaData?.platformVersion ?? ""}`.trim(),
);
cmp("suite", before.fingerprint.suite.version, after.fingerprint.suite.version);
cmp("truapi", before.fingerprint.host.truapi, after.fingerprint.host.truapi);
cmp("max tier", before.tiers.max, after.tiers.max);

// -- output ------------------------------------------------------------------

const md = flags.has("--md");
const out = [];
const h = (s) => out.push(md ? `\n## ${s}\n` : `\n${s}\n${"─".repeat(s.length)}`);

out.push(md ? `# sonde diff` : "sonde diff");
out.push("");
out.push(`before : ${beforePath}  (${before.finishedAt})`);
out.push(`after  : ${afterPath}  (${after.finishedAt})`);

if (envRows.length) {
  h("Environment changed");
  if (md) {
    out.push("| | before | after |", "|---|---|---|");
    for (const r of envRows) out.push(`| ${r.label} | ${r.from} | ${r.to} |`);
  } else {
    for (const r of envRows) out.push(`  ${r.label.padEnd(10)} ${r.from}  →  ${r.to}`);
  }
  // Two reports that differ in both environment AND results cannot attribute
  // the change to either. Say so rather than let a reader assume.
  if (regressions.length || fixes.length) {
    out.push(
      "",
      envRows.length > 1
        ? "  NOTE: more than one environment variable moved. Result changes below cannot be"
        : "  NOTE: the environment moved too. Result changes below cannot be",
      "  attributed to a single cause — vary one thing at a time for a clean comparison.",
    );
  }
} else {
  h("Environment");
  out.push("  identical");
}

section("Regressions", regressions, true);
section("Fixes", fixes, false);
section("Other changes", changes, false);
// Not regressions: these probes were not run in the earlier report, so there is
// nothing to have regressed from. Shown because a newly-measured `fail` is
// still worth acting on.
section("Newly measured (were skipped before)", nowMeasured, true);
section("No longer measured (skipped this time)", noLongerMeasured, false);

if (added.length) {
  h(`New probes (${added.length})`);
  for (const r of added) out.push(`  + ${r.id} — ${r.status}`);
}
if (removed.length) {
  h(`Removed probes (${removed.length})`);
  for (const r of removed) out.push(`  - ${r.id} (was ${r.status})`);
}

if (flags.has("--all")) {
  h("Unchanged");
  let n = 0;
  for (const [id, a] of afterById) {
    const b = beforeById.get(id);
    if (b && b.status === a.status) {
      out.push(`  = ${id} — ${a.status}`);
      n++;
    }
  }
  if (!n) out.push("  (none)");
}

h("Summary");
out.push(
  `  ${regressions.length} regression(s), ${fixes.length} fix(es), ${changes.length} other change(s)`,
  `  ${nowMeasured.length} newly measured, ${noLongerMeasured.length} no longer measured`,
  `  ${added.length} probe(s) added, ${removed.length} removed`,
);
const newlyBad = nowMeasured.filter((r) => rank(r.to) < rank("pass"));
if (newlyBad.length) {
  out.push(
    "",
    `  ${newlyBad.length} newly-measured probe(s) came back worse than pass. Not regressions —`,
    "  they were never measured before — but they are the actionable rows here.",
  );
}

console.log(out.join("\n"));
process.exit(regressions.length > 0 ? 1 : 0);

function section(title, rows, detailed) {
  if (!rows.length) return;
  h(`${title} (${rows.length})`);
  if (md) {
    out.push("| probe | from | to | diagnosis |", "|---|---|---|---|");
    for (const r of rows) {
      out.push(`| \`${r.id}\` | ${r.from} | **${r.to}** | ${r.diagnosis ?? ""} |`);
    }
    if (detailed) {
      for (const r of rows) out.push("", `**${r.id}** — ${r.detail}`);
    }
  } else {
    for (const r of rows) {
      out.push(`  ${r.from.padEnd(12)} → ${r.to.padEnd(12)} ${r.id}`);
      if (detailed) out.push(`  ${" ".repeat(28)}${r.detail}`);
    }
  }
}

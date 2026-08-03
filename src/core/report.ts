// The deliverable.
//
// A report is only useful if a stranger can act on it. That means three things
// this file is responsible for: it must name the runtime precisely enough to be
// reproduced, it must distinguish "absent" from "forbidden" from "broken", and
// it must be comparable to another report by machine. Prose cannot do the
// third, so the JSON shape is the primary artifact and every human-readable
// rendering is derived from it.

import type { Fingerprint } from "./fingerprint";
import { fingerprintSummary } from "./fingerprint";
import type { Outcome, Probe, Status } from "./types";
import { BAD_STATUSES } from "./types";

/** Bump when the shape changes incompatibly. The diff CLI refuses mismatches. */
export const SCHEMA = "sonde-report/1";

export interface ResultRow {
  id: string;
  title: string;
  bank: string;
  category: string;
  tier: number;
  status: Status;
  detail: string;
  data?: string;
  ms?: number;
  diagnosis?: string;
  permissions?: { before: Record<string, string>; after: Record<string, string> };
  leaked?: string[];
  txHash?: string;
  /** Carried from the Probe so the issue formatter works off the report alone. */
  repro?: string;
  /** Carried so a reader knows what the probe was for without the source. */
  why: string;
}

export interface Report {
  schema: typeof SCHEMA;
  runId: string;
  startedAt: string;
  finishedAt: string;
  fingerprint: Fingerprint;
  tiers: { max: number };
  results: ResultRow[];
  totals: Record<Status, number>;
  /** Stated in the artifact itself, because a reader deserves to know the limits. */
  caveats: string[];
}

export function buildReport(args: {
  runId: string;
  startedAt: string;
  fingerprint: Fingerprint;
  maxTier: number;
  probes: Probe[];
  results: ReadonlyMap<string, Outcome>;
}): Report {
  const rows: ResultRow[] = [];
  const totals: Record<Status, number> = {
    pass: 0,
    unsupported: 0,
    blocked: 0,
    fail: 0,
    timeout: 0,
    crashed: 0,
    skip: 0,
  };

  for (const probe of args.probes) {
    const outcome = args.results.get(probe.id);
    // A probe with no result is reported as `skip`, not omitted. Silence in a
    // compatibility matrix reads as "fine" and it never is.
    const status: Status = outcome?.status ?? "skip";
    totals[status]++;
    rows.push({
      id: probe.id,
      title: probe.title,
      bank: probe.bank,
      category: probe.category,
      tier: probe.tier,
      status,
      detail: outcome?.detail ?? "Not run.",
      data: outcome?.data,
      ms: outcome?.ms,
      diagnosis: outcome?.diagnosis,
      permissions: outcome?.permissions as ResultRow["permissions"],
      leaked: outcome?.leaked,
      txHash: outcome?.txHash,
      repro: probe.repro,
      why: probe.why,
    });
  }

  return {
    schema: SCHEMA,
    runId: args.runId,
    startedAt: args.startedAt,
    finishedAt: new Date().toISOString(),
    fingerprint: args.fingerprint,
    tiers: { max: args.maxTier },
    results: rows,
    totals,
    caveats: buildCaveats(rows, args.maxTier),
  };
}

function buildCaveats(rows: ResultRow[], maxTier: number): string[] {
  const out: string[] = [
    "No Polkadot App version is recorded because no host API exposes one. The Chromium " +
      "version is a proxy: the app ships a bundled engine, so it moves with app releases.",
    "A `timeout` means the call never settled. The suite abandons the promise but cannot " +
      "cancel the underlying platform call — a hung call may still be running.",
  ];
  if (maxTier < 3) {
    out.push(`Tier 3 (spend/write) was locked, so ${rows.filter((r) => r.tier === 3).length} probes did not run.`);
  }
  if (rows.some((r) => r.leaked?.length)) {
    out.push(
      "Some teardowns did not complete in time (see `leaked`). Later results in this run may " +
        "be affected by the resource still being held.",
    );
  }
  if (rows.some((r) => r.status === "crashed")) {
    out.push("This run was recovered after the runtime died. A `crashed` probe names what killed it.");
  }
  if (rows.some((r) => r.status !== "skip" && r.tier >= 2)) {
    out.push(
      "Bluetooth/USB/Serial grants persist per origin. Clear site data before re-running, or a " +
        "second run will report `pass` where a fresh device reports `blocked`.",
    );
  }
  return out;
}

// -- renderings --------------------------------------------------------------

const MARK: Record<Status, string> = {
  pass: "x",
  fail: "!",
  timeout: "T",
  crashed: "X",
  blocked: "B",
  unsupported: "-",
  skip: " ",
};

export function toMarkdown(r: Report): string {
  const f = r.fingerprint;
  const lines: string[] = [
    `# sonde report — ${fingerprintSummary(f)}`,
    "",
    `| | |`,
    `|---|---|`,
    `| Run | \`${r.runId}\` |`,
    `| When | ${r.finishedAt} |`,
    `| Surface | ${f.surface.surface} |`,
    `| App version | **not exposed by any host API** (Chromium ${f.browser.chromium ?? "?"} as proxy) |`,
    `| User agent | \`${f.browser.userAgent}\` |`,
    `| Device | ${f.browser.uaData?.model ?? "unknown"} · ${f.browser.uaData?.platform ?? "?"} ${f.browser.uaData?.platformVersion ?? ""} |`,
    `| Suite | ${f.suite.version} (build ${f.suite.buildId}) |`,
    `| truapi | ${f.host.truapi} (codec ${f.host.truapiCodec}) |`,
    `| Secure context | ${f.context.isSecureContext} · cross-origin isolated ${f.context.crossOriginIsolated} |`,
    `| Max tier | ${r.tiers.max} |`,
    "",
    "## Totals",
    "",
    "| pass | fail | timeout | crashed | blocked | unsupported | skip |",
    "|---|---|---|---|---|---|---|",
    `| ${r.totals.pass} | ${r.totals.fail} | ${r.totals.timeout} | ${r.totals.crashed} | ${r.totals.blocked} | ${r.totals.unsupported} | ${r.totals.skip} |`,
    "",
  ];

  // Failures first. A reader scanning on a phone should hit the actionable part
  // before the wall of passes.
  const bad = r.results.filter((x) => BAD_STATUSES.includes(x.status));
  if (bad.length) {
    lines.push(`## Needs attention (${bad.length})`, "");
    for (const row of bad) lines.push(...renderRow(row));
    lines.push("");
  }

  lines.push("## Everything", "");
  let group = "";
  for (const row of r.results) {
    const key = `${row.bank} / ${row.category}`;
    if (key !== group) {
      group = key;
      lines.push("", `### ${key}`, "");
    }
    lines.push(
      `- \`[${MARK[row.status]}]\` **${row.title}** — ${row.status}${row.ms != null ? ` (${row.ms} ms)` : ""}` +
        `${row.diagnosis ? ` · \`${row.diagnosis}\`` : ""}`,
    );
    lines.push(`  ${row.detail}`);
  }

  lines.push("", "## Caveats", "");
  for (const c of r.caveats) lines.push(`- ${c}`);
  return lines.join("\n");
}

function renderRow(row: ResultRow): string[] {
  const out = [
    `### \`${row.id}\` — ${row.status}${row.diagnosis ? ` (\`${row.diagnosis}\`)` : ""}`,
    "",
    `**${row.title}** — ${row.detail}`,
    "",
  ];
  if (row.permissions) {
    out.push(
      "```",
      `permission before : ${JSON.stringify(row.permissions.before)}`,
      `permission after  : ${JSON.stringify(row.permissions.after)}`,
      "```",
      "",
    );
  }
  if (row.data) out.push("```", row.data, "```", "");
  if (row.txHash) out.push(`Transaction hash (verify by hand): \`${row.txHash}\``, "");
  if (row.leaked?.length) out.push(`Leaked handles: ${row.leaked.join(", ")}`, "");
  return out;
}

/**
 * A ready-to-paste issue in the shape that worked.
 *
 * kite's geolocation report landed because it was structured this way:
 * environment table, minimal repro, expected vs actual, and — the part that did
 * the persuading — an explicit account of why the observed signature implicates
 * the host rather than the user. Reproducing that structure mechanically is
 * most of the value of having a `diagnosis` field at all.
 */
export function toGitHubIssue(r: Report, row: ResultRow): string {
  const f = r.fingerprint;
  const why = DIAGNOSIS_PROSE[row.diagnosis ?? ""] ?? null;

  return [
    `# ${row.title} — ${row.status} in the Polkadot App`,
    "",
    "## Summary",
    "",
    row.detail,
    "",
    "## Environment",
    "",
    "| | |",
    "|---|---|",
    `| Device | ${f.browser.uaData?.model ?? "unknown"} |`,
    `| OS | ${f.browser.uaData?.platform ?? "?"} ${f.browser.uaData?.platformVersion ?? ""} |`,
    `| Runtime | ${f.surface.surface} |`,
    `| UA | \`${f.browser.userAgent}\` |`,
    `| Chromium | ${f.browser.chromium ?? "unknown"} |`,
    `| App version | not exposed by any host API — see note below |`,
    `| truapi | ${f.host.truapi} (codec ${f.host.truapiCodec}) |`,
    `| Secure context | ${f.context.isSecureContext} |`,
    "",
    "## Reproduction",
    "",
    row.repro
      ? ["```html", row.repro, "```"].join("\n")
      : `Open this suite in the Polkadot App and run \`${row.id}\`. ${row.why}`,
    "",
    "## Expected",
    "",
    "Either the call succeeds, or it fails in a way that distinguishes 'not permitted here' from",
    "'the user said no' — a Product cannot degrade gracefully against an ambiguous denial.",
    "",
    "## Actual",
    "",
    "```",
    `status    : ${row.status}`,
    `diagnosis : ${row.diagnosis ?? "n/a"}`,
    `detail    : ${row.detail}`,
    row.permissions ? `permission: ${JSON.stringify(row.permissions.before)} → ${JSON.stringify(row.permissions.after)}` : "",
    row.data ?? "",
    "```",
    "",
    ...(why ? ["## Why this signature points where it does", "", why, ""] : []),
    "## Note on versioning",
    "",
    "This report cannot name the app build it describes: no truapi namespace exposes an app",
    "version. The Chromium version above is the closest proxy. A `system.version()` call would",
    "make reports like this one comparable across releases.",
    "",
    "---",
    `Produced by sonde ${f.suite.version} (build ${f.suite.buildId}), run \`${r.runId}\`.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * The paragraph that does the persuading.
 *
 * A maintainer triaging an issue needs to know why the reporter thinks the
 * fault is theirs. kite wrote this by hand, once, for geolocation. Keying it on
 * `diagnosis` means every probe that hits the same failure shape gets the same
 * argument, written once and reviewed once.
 */
const DIAGNOSIS_PROSE: Record<string, string> = {
  "host-callback-missing":
    "The permission reads `prompt` both before and after the denial. `prompt` means the permission " +
    "was never decided — nothing granted, nothing denied, nothing stored. A genuine user refusal " +
    "leaves `denied`. So the request was rejected while the permission remained undecided, which is " +
    "what Chromium does when a request is raised and the embedder never answers it: there is no " +
    "resolution path, and it fails closed. This is a host wiring gap, not a user decision.",
  "policy-blocked-by-embedder":
    "The failure names Permissions-Policy, which is enforced before any prompt could be shown. The " +
    "page is embedded without the corresponding `allow` attribute, or a response header forbids the " +
    "feature. This is the EMBEDDER's configuration — not a user or OS decision — so no change on the " +
    "device can fix it.",
  "never-settled":
    "The call neither resolved nor rejected within the budget. A hang is worse than an error: an " +
    "error can be handled, a hang cannot be distinguished from slowness, so calling code has no " +
    "correct behaviour available to it. Whatever the underlying cause, this should reject.",
  "spend-refused-by-allowlist":
    "sonde refused to run this itself — the resolved chain was not in the explicit spend allowlist. " +
    "This is a guard in the probe, not a finding about the host.",
};

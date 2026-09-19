// A report as a run record for the shared capability matrix.
//
// https://github.com/Baronvonbonbon/polkadot-host-capabilities collects runs from many phones and
// app builds into one matrix that people and LLMs read to learn what a Product can do inside the
// Polkadot app. Its schema (schema/run.v1.schema.json there) is smaller than a sonde report on
// purpose: it keeps what makes two runs comparable and drops what identifies the person who ran
// one. Left out: languages, time zone, screen and the raw user agent. Redacted: account addresses,
// public keys and the names of files picked in the file-picker probes. Evidence is kept only for
// results that need attention, as in the markdown report.
//
// The record is keyed by what decides compatibility — the date, the host wire codec, the
// product-sdk-host version and the OS — since no host API reports the app's own version.

import { MAINNET_GENESIS, SPEND_ALLOWED_GENESIS } from "../../product.mjs";
import type { Report, ResultRow } from "./report";
import { BAD_STATUSES } from "./types";

export const RECORD_SCHEMA = "polkadot-host-capabilities/run@1";

/** Probes whose detail quotes a picked file's name. */
const PICKED_FILE = new Set(["web.filesystem.fileInput", "web.filesystem.showOpenFilePicker"]);

/** Hashes that name chains, not people, and so stay readable. */
const KNOWN_HASHES = new Set<string>([...SPEND_ALLOWED_GENESIS, ...Object.keys(MAINNET_GENESIS)].map((h) => h.toLowerCase()));

export function redact(text: string): string {
  return text
    .replace(/0x[0-9a-fA-F]{64}\b/g, (h) => (KNOWN_HASHES.has(h.toLowerCase()) ? h : "<32-byte key>"))
    .replace(/0x[0-9a-fA-F]{40}\b/g, "<h160 address>")
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{46,48}\b/g, "<ss58 address>");
}

function osOf(report: Report): { label: string; slug: string } {
  const ua = report.fingerprint.browser.uaData;
  const platform = (ua?.platform as string | undefined) ?? report.fingerprint.browser.userAgent.match(/\b(Android|iPhone OS|Mac OS X|Windows NT|Linux)\b/)?.[1] ?? "unknown";
  const version = (ua?.platformVersion as string | undefined) ?? report.fingerprint.browser.userAgent.match(/Android ([\d.]+)/)?.[1] ?? "";
  const name = platform.toLowerCase().replace(/[^a-z]+/g, "") || "unknown";
  const major = version.split(".")[0] || "x";
  return { label: `${platform} ${version}`.trim(), slug: `${name}-${major}` };
}

export function recordKey(report: Report): string {
  const host = report.fingerprint.host;
  const hostPkg = host.sdk["@parity/product-sdk-host"] ?? "unknown";
  return `${report.startedAt.slice(0, 10)}_codec${host.truapiCodec}_host-${hostPkg}_${osOf(report).slug}`;
}

function resultOf(row: ResultRow) {
  const detail = PICKED_FILE.has(row.id) ? row.detail.replace(/"[^"]*"/g, '"<picked file>"') : row.detail;
  const needsAttention = BAD_STATUSES.includes(row.status);
  return {
    title: row.title,
    status: row.status,
    diagnosis: row.diagnosis ?? null,
    ms: row.ms ?? null,
    detail: redact(detail),
    ...(needsAttention && row.data ? { evidence: redact(PICKED_FILE.has(row.id) ? "" : row.data) } : {}),
  };
}

export function toRecord(report: Report, notes: string[] = []): object {
  const f = report.fingerprint;
  const results = Object.fromEntries(report.results.map((row) => [row.id, resultOf(row)]));
  const skipped = report.results.filter((r) => r.status === "skip").length;
  return {
    schema: RECORD_SCHEMA,
    key: recordKey(report),
    capturedAt: report.startedAt,
    // A sonde record carries every probe, run or not (unrun ones are `skip`), so it is complete
    // by construction. Whoever submits it adds a note for anything the operator skipped by hand.
    complete: true,
    notes: [...notes, ...(skipped ? [`${skipped} probe(s) skipped — the detail of each says why.`] : [])],
    tool: {
      name: "sonde",
      version: f.suite.version,
      build: f.suite.buildId,
      source: f.suite.source,
      runId: report.runId,
      productId: f.suite.productId,
    },
    runtime: {
      surface: f.surface.surface,
      os: osOf(report).label,
      device: (f.browser.uaData?.model as string) || "unknown device",
      webview: f.browser.chromium ? `Chromium ${f.browser.chromium}` : null,
      appVersion: f.host.appVersion,
    },
    host: {
      wireCodec: f.host.truapiCodec,
      truapi: f.host.truapi,
      sdk: f.host.sdk,
    },
    results,
    totals: report.totals,
  };
}

export function toRecordJson(report: Report): string {
  return `${JSON.stringify(toRecord(report), null, 2)}\n`;
}

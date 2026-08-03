// Shared probe vocabulary.
//
// At ~140 probes, the ratio that matters is evidence per line. These helpers
// exist so a probe body is mostly the interesting part — the call being tested
// and what its result means — rather than boilerplate around it.

import { TIER, UnsupportedError, type Outcome, type Probe } from "../core/types";

export const kb = (n: number) => `${(n / 1024).toFixed(1)} KiB`;

export function lines(...xs: (string | false | null | undefined)[]): string {
  return xs.filter((x): x is string => typeof x === "string" && x.length > 0).join("\n");
}

export function pad(k: string, v: unknown): string {
  return `${k.padEnd(22)}: ${v}`;
}

/** Walks a dotted path off `globalThis`, returning undefined rather than throwing. */
export function at(path: string): unknown {
  let cur: unknown = globalThis;
  for (const part of path.split(".")) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function present(path: string): boolean {
  return at(path) !== undefined;
}

/** Throw from a probe when the API simply is not there. Classified `unsupported`. */
export function need<T>(path: string): T {
  const v = at(path);
  if (v === undefined) throw new UnsupportedError(path);
  return v as T;
}

/**
 * A tier-0 presence probe.
 *
 * Detection is the cheap half of the matrix and there is a lot of it, so it is
 * worth one line each. Reports the typeof as evidence: a WebView that stubs an
 * API as a non-callable object is a distinct and much nastier failure than one
 * that omits it, and only the typeof tells them apart.
 */
export function detect(args: {
  id: string;
  title: string;
  why: string;
  category: string;
  paths: string | string[];
  /**
   * How to read a partial result.
   *
   * `"all"` (default) — the paths are entry points to ONE feature, so a missing
   * one means feature detection passes and the call then fails. That is worse
   * than an absent API and is reported as `fail`.
   *
   * `"any"` — the paths are related but separately scoped (a window-scoped name
   * beside a service-worker-scoped one, or a newer method beside an older one).
   * Partial presence is normal and must not be reported as a defect.
   */
  mode?: "all" | "any";
  /** Extra evidence gathered only when the API is present. */
  extra?: () => string | undefined;
}): Probe {
  const paths = Array.isArray(args.paths) ? args.paths : [args.paths];
  const mode = args.mode ?? "all";
  return {
    id: args.id,
    title: args.title,
    why: args.why,
    bank: "web",
    category: args.category,
    tier: TIER.DETECT,
    async run() {
      const found = paths.map((p) => ({ path: p, value: at(p) }));
      const missing = found.filter((f) => f.value === undefined);
      const body = lines(
        ...found.map((f) => pad(f.path, f.value === undefined ? "absent" : `present (${typeof f.value})`)),
        args.extra?.(),
      );
      if (missing.length === paths.length) {
        return {
          status: "unsupported",
          detail: `Not present in this runtime.`,
          data: body,
          diagnosis: "not-implemented",
        };
      }
      if (missing.length) {
        return mode === "any"
          ? {
              status: "pass",
              detail: `Partially present (${paths.length - missing.length} of ${paths.length}) — expected, since these are separately scoped.`,
              data: body,
            }
          : {
              status: "fail",
              detail: `Partially present — ${missing.length} of ${paths.length} entry points are missing. A half-implemented API is worse than an absent one: feature detection passes and the call fails.`,
              data: body,
              diagnosis: "not-implemented",
            };
      }
      return { status: "pass", detail: "Present.", data: body };
    },
  };
}

/** Convenience constructor so probe files stay declarative. */
export function probe(p: Omit<Probe, "bank"> & { bank?: Probe["bank"] }): Probe {
  return { bank: "web", ...p } as Probe;
}

export function ok(detail: string, data?: string): Outcome {
  return { status: "pass", detail, data };
}

export function unsupported(detail: string, data?: string): Outcome {
  return { status: "unsupported", detail, data, diagnosis: "not-implemented" };
}

export function wrong(detail: string, data?: string): Outcome {
  return { status: "fail", detail, data, diagnosis: "wrong-result" };
}

/**
 * Race a call against the probe's own abort signal.
 *
 * The runner already bounds every probe. This is for the finer-grained case: a
 * probe making several calls that wants to attribute the hang to one of them
 * rather than report "something in here never returned".
 */
export async function within<T>(
  signal: AbortSignal,
  ms: number,
  label: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T; ms: number } | { ok: false; label: string; ms: number }> {
  const t0 = performance.now();
  const timeout = new Promise<symbol>((r) => {
    const h = setTimeout(() => r(TIMED_OUT), ms);
    signal.addEventListener("abort", () => clearTimeout(h), { once: true });
  });
  const raced = await Promise.race([fn(), timeout]);
  const took = Math.round(performance.now() - t0);
  if (raced === TIMED_OUT) return { ok: false, label, ms: took };
  return { ok: true, value: raced as T, ms: took };
}
const TIMED_OUT = Symbol("timed-out");

/**
 * Normalise neverthrow into the plain tagged shape.
 *
 * The SDK uses TWO Result conventions and they are not interchangeable:
 *
 *   - `@parity/product-sdk-host`'s top-level wrappers (requestDevicePermission,
 *     deriveEntropy, getChainSpec, navigateTo, requestResourceAllocation, …)
 *     return `@parity/result`'s `{ ok, value } | { ok, error }`.
 *   - The raw truapi client and `AccountsProvider` return neverthrow's
 *     `ResultAsync`, which has `.match()` / `.isOk()` and NO `.ok` property.
 *
 * Reading `.ok` off the second silently yields `undefined`, which is falsy, so
 * every call looks like it failed. Routing neverthrow through here means a
 * probe body never has to remember which layer it is talking to.
 */
export type Tagged<T, E> = { ok: true; value: T } | { ok: false; error: E };

export async function nt<T, E>(r: {
  match<A>(onOk: (v: T) => A, onErr: (e: E) => A): Promise<A>;
}): Promise<Tagged<T, E>> {
  // The type argument is explicit: inferring A from the first callback alone
  // narrows it to the ok branch and rejects the err branch.
  return r.match<Tagged<T, E>>(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
}

/** Best-effort readable text for either convention's error channel. */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  const s = JSON.stringify(e);
  return s && s !== "{}" ? s.slice(0, 200) : String(e);
}

/**
 * Send a tiny payload before the real one.
 *
 * kite's best diagnostic trick, generalised. If 16 bytes lands and 50 KiB does
 * not, the fault is size or chunking; if the canary stalls too, it is signing
 * or authorisation. Same call either way, so the comparison is clean and the
 * conclusion does not depend on trusting an error message.
 */
export async function canary<T>(
  send: (bytes: Uint8Array) => Promise<T>,
  payload: Uint8Array,
  log: string[],
): Promise<{ phase: "canary" | "payload"; value: T } | { phase: "canary" | "payload"; failed: string }> {
  const enc = new TextEncoder();
  const tiny = enc.encode(`sonde-canary-${Date.now()}`);
  try {
    const t0 = performance.now();
    const v = await send(tiny);
    log.push(pad(`canary (${tiny.length}B)`, `ok in ${Math.round(performance.now() - t0)} ms`));
    void v;
  } catch (e) {
    log.push(pad(`canary (${tiny.length}B)`, `failed — ${(e as Error).message}`));
    return { phase: "canary", failed: (e as Error).message };
  }
  try {
    const t0 = performance.now();
    const v = await send(payload);
    log.push(pad(`payload (${kb(payload.length)})`, `ok in ${Math.round(performance.now() - t0)} ms`));
    return { phase: "payload", value: v };
  } catch (e) {
    log.push(pad(`payload (${kb(payload.length)})`, `failed — ${(e as Error).message}`));
    return { phase: "payload", failed: (e as Error).message };
  }
}

// The probe contract.
//
// One rule governs this whole directory: THE RUNNER OWNS SAFETY, PROBES NEVER
// DO. kite hand-rolled `Promise.race([call(), timeout])` in five separate
// checks with three different constants; at ~140 probes that is where a missed
// `catch` becomes a wedged suite. Here a probe is a plain async function that
// may throw, and every fail-safe — timeout, abort, teardown, journalling, tier
// gate — lives in runner.ts and applies uniformly. A probe cannot opt out.

import type { CleanupRegistry } from "./cleanup";

/**
 * What a probe is allowed to do, in ascending order of consequence. The runner
 * gates on this and the UI groups on it.
 */
export const TIER = {
  /** Presence and shape only. No invocation, no side effects, no prompts. */
  DETECT: 0,
  /** A real call that costs nothing and cannot prompt. */
  INVOKE: 1,
  /** May raise an OS or host permission/signing prompt. */
  PROMPT: 2,
  /** Moves testnet funds or writes to chain. Locked by default. */
  SPEND: 3,
} as const;
export type Tier = (typeof TIER)[keyof typeof TIER];

export type Bank = "web" | "host";

/**
 * kite's `pass | fail | skip` is too coarse for a compatibility matrix: it
 * cannot say WHY something did not work, which is the entire value of the
 * report. "Absent", "forbidden" and "broken" need different fixes by different
 * people, so they get different statuses.
 */
export type Status =
  /** Invoked, returned something correct. */
  | "pass"
  /** Genuinely absent in this runtime. A true negative, not a bug. */
  | "unsupported"
  /** Present, but denied by permission, Permissions-Policy, or host policy. */
  | "blocked"
  /** Present and allowed, but errored or returned something wrong. */
  | "fail"
  /** Never settled. The most damning result, and the one kite found twice. */
  | "timeout"
  /** Journal shows it started and never finished — the tab died mid-probe. */
  | "crashed"
  /** Precondition unmet, tier locked, or the user skipped it. */
  | "skip";

/** Statuses that mean "this runtime is not doing its job". */
export const BAD_STATUSES: readonly Status[] = ["fail", "timeout", "crashed", "blocked"];

/**
 * A stable, greppable slug naming the *shape* of a failure.
 *
 * This generalises the prose `DIAGNOSIS:` blocks kite wrote by hand for
 * geolocation. Prose does not survive being compared across forty devices;
 * a slug does. Add to this union rather than inventing free-form strings —
 * the diff CLI groups on it.
 */
export type Diagnosis =
  | "not-in-container"
  | "host-callback-missing"
  | "policy-blocked-by-embedder"
  | "os-denied"
  | "user-dismissed"
  | "insecure-context"
  | "needs-user-gesture"
  | "no-account-selected"
  | "chain-not-supported"
  | "allowance-missing"
  | "quota-exceeded"
  | "never-settled"
  | "wrong-result"
  | "threw"
  | "not-implemented"
  | "spend-refused-by-allowlist";

export interface PermissionSample {
  [name: string]: PermissionState | "unavailable" | "error";
}

export interface Outcome {
  status: Status;
  /** One line, shown on the card. A failure must self-explain — kite's best idea. */
  detail: string;
  /** Preformatted evidence block. Everything a reader needs to not trust us blindly. */
  data?: string;
  ms?: number;
  diagnosis?: Diagnosis;
  /**
   * Sampled by the runner before and after. A permission that reads "prompt"
   * on both sides of a denial is the signature of a host that never answered
   * the callback rather than a user who said no — the exact reasoning behind
   * kite's geolocation bug report, now automatic for every gated probe.
   */
  permissions?: { before: PermissionSample; after: PermissionSample };
  /** Cleanup handles that did not release in time. Reported, never fatal. */
  leaked?: string[];
  /**
   * Set by T3 probes BEFORE awaiting settlement. A T3 timeout is ambiguous in a
   * way no other status is — a broadcast that never settles may still have
   * landed — so the hash has to survive the timeout to be verifiable by hand.
   */
  txHash?: string;
}

export interface Probe {
  /** Dotted and stable: "web.sensors.geolocation". The diff CLI joins on this. */
  id: string;
  title: string;
  /** Why anyone should care. Shown in the UI so a failure explains itself. */
  why: string;
  bank: Bank;
  category: string;
  tier: Tier;
  /**
   * Needs transient user activation. Chromium's activation lasts ~5s and is
   * consumed by ONE call, so these cannot be driven from a loop — the runner
   * queues them for one tap each.
   */
  gesture?: boolean;
  /** Probe ids that must have passed first. Skipped (never failed) if unmet. */
  needs?: string[];
  /** Permission names to sample either side of the run. */
  permissions?: string[];
  /** Overrides DEFAULT_TIMEOUT_MS[tier]. */
  timeoutMs?: number;
  /** Can take the renderer down. Ordered last within its category. */
  crashRisk?: "high";
  /**
   * Leaves a persistent per-origin grant (Bluetooth/USB/Serial/HID) that
   * survives reload and silently changes every later run. Must register
   * `forget()`, not merely `close()`.
   */
  sticky?: boolean;
  /** Minimal standalone repro, pasted into the GitHub issue formatter. */
  repro?: string;
  /** Exactly what this will spend or write, in one sentence. Required at T3. */
  cost?: string;
  run(ctx: Ctx): Promise<Outcome>;
}

export type Surface =
  /** Inside the Polkadot App's WebView. isInsideContainerSync() is true. */
  | "polkadot-app"
  /** Framed by the dev-dot.li gateway. Host API absent, browser APIs present. */
  | "gateway-iframe"
  /** A plain browser tab. The control in the three-surface comparison. */
  | "plain-browser";

/**
 * Carried between probes. Typed, unlike kite's `Ctx` grab-bag, because at ~140
 * probes an untyped shared object is where stale state hides.
 */
export interface SharedState {
  /** @parity/product-sdk App, once host.system.createApp has run. */
  app?: unknown;
  /** The cloud-storage environment the host actually accepted. */
  appEnv?: "devnet" | "paseo";
  /** Genesis hash of the chain in play, for the T3 allowlist check. */
  genesis?: string;
  /** CID written by an upload probe, read back by the round-trip probe. */
  cid?: string;
  /** AES key from the seal probe, needed to open what came back. */
  sealKey?: CryptoKey;
  sealed?: { iv: string; ct: string };
  /** Captured image bytes, shared by the media probes. */
  jpeg?: Uint8Array;
  /** Free-form, for probes that pair without deserving a typed field. */
  scratch: Map<string, unknown>;
}

export interface Ctx {
  /** Aborted on timeout or on "Abort all". Pass it to anything that accepts one. */
  readonly signal: AbortSignal;
  /** Register teardown at acquisition time. The runner guarantees it drains. */
  readonly cleanup: CleanupRegistry;
  readonly surface: Surface;
  readonly shared: SharedState;
  /** Results of earlier probes, for `needs` checks and cross-probe reasoning. */
  readonly results: ReadonlyMap<string, Outcome>;
  timed<T>(fn: () => Promise<T>): Promise<[T, number]>;
}

/**
 * Per-tier budgets. Detection is instant or broken; a prompt has to wait for a
 * human to find their phone; a chain write has to wait for a block.
 */
export const DEFAULT_TIMEOUT_MS: Record<Tier, number> = {
  [TIER.DETECT]: 5_000,
  [TIER.INVOKE]: 15_000,
  [TIER.PROMPT]: 120_000,
  [TIER.SPEND]: 180_000,
};

/** Teardown can hang too. Bound it, report the leak, and keep going. */
export const CLEANUP_BUDGET_MS = 5_000;

export class TimeoutError extends Error {
  constructor(public readonly budgetMs: number) {
    super(`no response after ${(budgetMs / 1000).toFixed(0)}s`);
    this.name = "TimeoutError";
  }
}

export class AbortedError extends Error {
  constructor() {
    super("aborted by the operator");
    this.name = "AbortedError";
  }
}

/** Thrown by a probe that finds the API simply absent. Sugar for a common return. */
export class UnsupportedError extends Error {
  constructor(what: string) {
    super(`${what} is not present in this runtime`);
    this.name = "UnsupportedError";
  }
}

/** Thrown by a probe denied by permission or policy. */
export class BlockedError extends Error {
  constructor(
    message: string,
    public readonly diagnosis: Diagnosis = "os-denied",
  ) {
    super(message);
    this.name = "BlockedError";
  }
}

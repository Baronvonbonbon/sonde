// What ran, and where.
//
// THE POLKADOT APP EXPOSES NO VERSION API. Checked across all fifteen truapi
// namespaces (account, chain, chat, coinPayment, entropy, localStorage,
// notifications, payment, permissions, preimage, resourceAllocation, signing,
// statementStore, system, theme) — nothing returns an app version, build
// number, or release channel.
//
// That is a real problem for the stated goal of this suite. A compatibility
// report that cannot name the build it describes cannot be compared to another
// one, and "works for me" versus "broken for me" stays unresolvable. So:
//
//   1. Derive the closest available substitute (below), and
//   2. ship host.system.version as a probe that records `unsupported`, so the
//      gap appears in every report as a line item rather than a footnote.
//
// The derived fingerprint is good enough in practice because the Polkadot App
// ships a bundled Chromium: the Chrome version in the UA moves with the app
// release, so it acts as a coarse proxy for the app build even though it is not
// one.

import { TRUAPI_VERSION, TRUAPI_CODEC_VERSION } from "@parity/truapi";
import { detectSurface, type SurfaceInfo } from "./surface";
import { PRODUCT_ID, CLOUD_ENV, SUITE_VERSION, SOURCE_URL } from "../../product.mjs";

declare const __SDK_VERSIONS__: Record<string, string>;
declare const __BUILD_ID__: string;
declare const __SUITE_VERSION__: string;

export interface Fingerprint {
  surface: SurfaceInfo;
  suite: {
    version: string;
    declaredVersion: string;
    buildId: string;
    productId: string;
    cloudEnv: string;
    /** So a reader can check how any claim in this report was measured. */
    source: string;
  };
  browser: {
    userAgent: string;
    /** Chromium version parsed from the UA — on Android, the system WebView, not the app. */
    chromium: string | null;
    isWebView: boolean;
    /** navigator.userAgentData high-entropy values. Absent on non-Chromium. */
    uaData: Record<string, unknown> | null;
    languages: readonly string[];
    timeZone: string;
  };
  device: {
    hardwareConcurrency: number | null;
    deviceMemoryGb: number | null;
    devicePixelRatio: number;
    screen: string;
    viewport: string;
    maxTouchPoints: number;
    reducedMotion: boolean;
    colorScheme: string;
  };
  context: {
    origin: string;
    isSecureContext: boolean;
    crossOriginIsolated: boolean;
    /** Cross-origin isolation gates SharedArrayBuffer and precise timers. */
    protocol: string;
  };
  host: {
    truapi: number;
    truapiCodec: number;
    sdk: Record<string, string>;
    /** Filled in by the host.system.handshake probe once it has run. */
    handshake?: string;
    /** Always null today. Present so the shape does not change if it ever is not. */
    appVersion: string | null;
    appVersionSource: string;
  };
  capturedAt: string;
}

export async function captureFingerprint(): Promise<Fingerprint> {
  const ua = navigator.userAgent;
  return {
    surface: detectSurface(),
    suite: {
      version: typeof __SUITE_VERSION__ === "string" ? __SUITE_VERSION__ : SUITE_VERSION,
      declaredVersion: SUITE_VERSION,
      buildId: typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev",
      productId: PRODUCT_ID,
      cloudEnv: CLOUD_ENV,
      source: SOURCE_URL,
    },
    browser: {
      userAgent: ua,
      chromium: parseChromium(ua),
      isWebView: /\bwv\b/.test(ua),
      uaData: await highEntropy(),
      languages: navigator.languages ?? [navigator.language],
      timeZone: safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "unknown",
    },
    device: {
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      deviceMemoryGb: (navigator as { deviceMemory?: number }).deviceMemory ?? null,
      devicePixelRatio: window.devicePixelRatio,
      screen: `${screen.width}x${screen.height} (avail ${screen.availWidth}x${screen.availHeight})`,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      maxTouchPoints: navigator.maxTouchPoints ?? 0,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    },
    context: {
      origin: location.origin,
      isSecureContext: window.isSecureContext,
      crossOriginIsolated: window.crossOriginIsolated ?? false,
      protocol: location.protocol,
    },
    host: {
      truapi: TRUAPI_VERSION,
      truapiCodec: TRUAPI_CODEC_VERSION,
      sdk: typeof __SDK_VERSIONS__ === "object" ? __SDK_VERSIONS__ : {},
      appVersion: null,
      appVersionSource:
        "NOT AVAILABLE — no truapi namespace exposes an app version. " +
        "The Chromium version below is the system WebView on Android (updated separately from the app), so it does not identify the app build.",
    },
    capturedAt: new Date().toISOString(),
  };
}

/**
 * The high-entropy hints are the best device identification available and are
 * exactly what a bug report needs: `model` gives the handset, `platformVersion`
 * the Android release, `fullVersionList` the precise Chromium build.
 *
 * Gated behind a permission-ish check in some contexts, and absent entirely on
 * non-Chromium, so a rejection here is normal rather than notable.
 */
async function highEntropy(): Promise<Record<string, unknown> | null> {
  const uaData = (navigator as { userAgentData?: { getHighEntropyValues(h: string[]): Promise<Record<string, unknown>> } })
    .userAgentData;
  if (!uaData?.getHighEntropyValues) return null;
  try {
    return await uaData.getHighEntropyValues([
      "architecture",
      "bitness",
      "model",
      "platform",
      "platformVersion",
      "uaFullVersion",
      "fullVersionList",
      "formFactors",
      "wow64",
    ]);
  } catch (e) {
    return { error: (e as Error).message };
  }
}

function parseChromium(ua: string): string | null {
  return /Chrome\/([\d.]+)/.exec(ua)?.[1] ?? null;
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** One line for the top of a bug report. */
export function fingerprintSummary(f: Fingerprint): string {
  const model = (f.browser.uaData?.model as string) || "unknown device";
  const platform = f.browser.uaData?.platform
    ? `${f.browser.uaData.platform} ${f.browser.uaData.platformVersion ?? ""}`.trim()
    : "unknown platform";
  return `${model} · ${platform} · Chromium ${f.browser.chromium ?? "?"} · ${f.surface.surface}`;
}

// Which of the three runtimes are we in?
//
// The whole instrument turns on this. One probe run on one surface is an
// anecdote; the same probe run on all three and diffed is evidence. kite's
// geolocation report was persuasive precisely because it could say "works in
// mobile Chrome, denied in the app, same page, same device".

import { isInsideContainerSync } from "@parity/product-sdk";
import type { Surface } from "./types";

export interface SurfaceInfo {
  surface: Surface;
  /** How we decided. Goes in the report so the classification is auditable. */
  evidence: string[];
}

export function detectSurface(): SurfaceInfo {
  const evidence: string[] = [];

  let inContainer = false;
  try {
    inContainer = isInsideContainerSync();
    evidence.push(`isInsideContainerSync : ${inContainer}`);
  } catch (e) {
    // Outside a host build the SDK's transport may not even load. That is
    // itself an answer, not an error.
    evidence.push(`isInsideContainerSync : threw — ${(e as Error).message}`);
  }

  const framed = safeFramed();
  evidence.push(`framed                : ${framed}`);

  let ancestors = "unavailable";
  try {
    const list = (location as unknown as { ancestorOrigins?: DOMStringList }).ancestorOrigins;
    if (list) ancestors = Array.from(list).join(", ") || "(none)";
  } catch {
    /* Firefox and some WebViews do not expose it. */
  }
  evidence.push(`ancestorOrigins       : ${ancestors}`);
  evidence.push(`isWebView (UA "wv")   : ${/\bwv\b/.test(navigator.userAgent)}`);

  // Container detection is authoritative — it is the host handshake, not a
  // heuristic. Framing only disambiguates the two non-container cases.
  const surface: Surface = inContainer
    ? "polkadot-app"
    : framed
      ? "gateway-iframe"
      : "plain-browser";

  evidence.push(`→ surface             : ${surface}`);
  return { surface, evidence };
}

/** `window.top` access throws cross-origin in some embeddings; that throw IS the answer. */
function safeFramed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export const SURFACE_LABEL: Record<Surface, string> = {
  "polkadot-app": "Polkadot App (in-container WebView)",
  "gateway-iframe": "Gateway iframe (no host API)",
  "plain-browser": "Plain browser tab",
};

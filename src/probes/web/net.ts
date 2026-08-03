// The network, and the policies wrapped around it.
//
// A Product in a sandboxed iframe is subject to a Permissions-Policy and a CSP
// it did not write and cannot read directly. These probes infer them by
// attempting things and watching how they fail — which is the only route
// available from inside the sandbox.

import { TIER, type Probe } from "../../core/types";
import { detect, lines, need, ok, pad, probe, wrong } from "../helpers";

const CAT = "net";

/** Same-origin, so it works from a static bundle with no server and no CORS. */
const SELF = () => new URL(location.pathname, location.href).href;

const fetchProbe = probe({
  id: "web.net.fetch",
  title: "fetch — same-origin, CORS, streaming",
  why: "Everything the SDK does over HTTP goes through here. Which of these three works narrows a network failure to a policy, an origin, or the transport.",
  category: CAT,
  tier: TIER.INVOKE,
  timeoutMs: 30_000,
  async run(ctx) {
    const rows: string[] = [];
    let worked = 0;

    try {
      const t0 = performance.now();
      const res = await fetch(SELF(), { cache: "no-store", signal: ctx.signal });
      rows.push(pad("same-origin", `${res.status} in ${Math.round(performance.now() - t0)} ms`));
      if (res.ok) worked++;
    } catch (e) {
      rows.push(pad("same-origin", `FAILED — ${(e as Error).message}`));
    }

    // A cross-origin request is the one a sandboxed Product most needs and is
    // most likely to be denied. The failure message distinguishes a CSP
    // connect-src refusal from an ordinary network error.
    try {
      const res = await fetch("https://cloudflare-dns.com/dns-query?name=example.com&type=A", {
        headers: { accept: "application/dns-json" },
        signal: ctx.signal,
      });
      rows.push(pad("cross-origin (CORS)", `${res.status} ${res.ok ? "ok" : "not ok"}`));
      if (res.ok) worked++;
    } catch (e) {
      const msg = (e as Error).message;
      rows.push(
        pad("cross-origin (CORS)", `FAILED — ${msg}`),
        /content security policy|csp/i.test(msg)
          ? "  → refused by CSP connect-src, i.e. the embedder's policy"
          : "  → network or CORS failure (CSP refusals name the policy explicitly)",
      );
    }

    try {
      const res = await fetch(SELF(), { cache: "no-store", signal: ctx.signal });
      if (!res.body) {
        rows.push(pad("streaming", "response.body is null — no streaming"));
      } else {
        const reader = res.body.getReader();
        ctx.cleanup.add("fetch-reader", () => reader.cancel().catch(() => {}));
        let bytes = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value?.length ?? 0;
        }
        rows.push(pad("streaming", `${bytes} bytes read incrementally`));
        worked++;
      }
    } catch (e) {
      rows.push(pad("streaming", `FAILED — ${(e as Error).message}`));
    }

    return {
      status: worked >= 2 ? "pass" : worked === 1 ? "blocked" : "fail",
      detail:
        worked === 3
          ? "Same-origin, cross-origin, and streaming all work."
          : worked === 0
            ? "No form of fetch succeeded — this runtime has no usable HTTP."
            : `${worked} of 3 modes worked. See below for which.`,
      data: lines(...rows),
      diagnosis: worked === 0 ? "threw" : worked < 3 ? "policy-blocked-by-embedder" : undefined,
    };
  },
});

const websocket = probe({
  id: "web.net.websocket",
  title: "WebSocket connect",
  why: "Every Polkadot RPC endpoint is a WebSocket. If this is blocked, the entire chain half of the suite is unreachable regardless of what the host API says.",
  category: CAT,
  tier: TIER.INVOKE,
  timeoutMs: 25_000,
  async run(ctx) {
    const WS = need<typeof WebSocket>("WebSocket");
    // A public Polkadot RPC: the closest thing to what Bank B actually needs,
    // so a pass here means more than a generic echo server would.
    const url = "wss://rpc.polkadot.io";
    const t0 = performance.now();

    const result = await new Promise<{ ok: boolean; note: string }>((resolve) => {
      let ws: WebSocket;
      try {
        ws = new WS(url);
      } catch (e) {
        return resolve({ ok: false, note: `constructor threw — ${(e as Error).message}` });
      }
      ctx.cleanup.add("websocket", () => ws.close());
      ws.onopen = () => resolve({ ok: true, note: `open in ${Math.round(performance.now() - t0)} ms` });
      ws.onerror = () => resolve({ ok: false, note: "error event (no detail is exposed to script by design)" });
      ws.onclose = (e) => resolve({ ok: false, note: `closed before open — code ${e.code} ${e.reason || ""}` });
      ctx.signal.addEventListener("abort", () => resolve({ ok: false, note: "aborted" }), { once: true });
    });

    return result.ok
      ? ok(`Connected to ${url}.`, pad("result", result.note))
      : {
          status: "blocked",
          detail: `Could not open a WebSocket to ${url}.`,
          data: lines(
            pad("result", result.note),
            "",
            "WebSocket failures do not expose a reason to script. In a sandboxed iframe the",
            "usual cause is the embedder's CSP connect-src; in a WebView it is more often the",
            "host's network permission. Neither is distinguishable from here.",
          ),
          diagnosis: "policy-blocked-by-embedder",
        };
  },
});

const permissionsPolicy = probe({
  id: "web.net.permissionsPolicy",
  title: "Permissions-Policy introspection",
  why: "The single most useful thing to know in an iframe. kite's geolocation bug turned on whether the embedder had granted `allow=\"geolocation\"`, and this reads that directly instead of inferring it from a denial.",
  category: CAT,
  tier: TIER.DETECT,
  async run() {
    const fp = (document as { featurePolicy?: { allowedFeatures(): string[]; features(): string[] }; permissionsPolicy?: unknown }).featurePolicy;
    const framed = window.self !== window.top;

    if (!fp?.allowedFeatures) {
      return {
        status: "unsupported",
        detail:
          "document.featurePolicy is not exposed, so the policy governing this document cannot be read. " +
          "Permission denials here will be diagnosable only by their failure signature.",
        data: lines(pad("framed", framed), pad("featurePolicy", "absent")),
        diagnosis: "not-implemented",
      };
    }

    const allowed = new Set(fp.allowedFeatures());
    const all = fp.features?.() ?? [];
    const interesting = [
      "geolocation",
      "camera",
      "microphone",
      "bluetooth",
      "usb",
      "serial",
      "hid",
      "nfc",
      "payment",
      "publickey-credentials-get",
      "clipboard-read",
      "clipboard-write",
      "screen-wake-lock",
      "idle-detection",
      "accelerometer",
      "gyroscope",
      "magnetometer",
      "display-capture",
      "fullscreen",
      "picture-in-picture",
      "web-share",
      "storage-access",
      "cross-origin-isolated",
    ];

    const denied = interesting.filter((f) => all.includes(f) && !allowed.has(f));
    return {
      // In a top-level document nothing is denied and this is uninteresting.
      // In a frame, a denial list is the answer to most of Bank A at once.
      status: framed && denied.length ? "blocked" : "pass",
      detail: framed
        ? denied.length
          ? `${denied.length} feature(s) are denied to this frame by the embedder before any prompt can occur.`
          : "This frame is granted every feature checked."
        : `Top-level document; ${allowed.size} feature(s) allowed.`,
      data: lines(
        pad("framed", framed),
        pad("allowed count", allowed.size),
        "",
        ...interesting.map((f) => pad(f, !all.includes(f) ? "unknown to this build" : allowed.has(f) ? "allowed" : "DENIED by policy")),
        "",
        denied.length
          ? "A DENIED feature cannot be granted by the user or the OS. Only the embedder can\n" +
            'change it, by adding the corresponding allow="…" attribute to the iframe.'
          : "",
      ),
      diagnosis: framed && denied.length ? "policy-blocked-by-embedder" : undefined,
    };
  },
});

const csp = probe({
  id: "web.net.csp",
  title: "Content Security Policy in force",
  why: "A CSP the Product did not write can block the exact fetch or WebSocket the SDK needs. Reading it turns a confusing network failure into a one-line explanation.",
  category: CAT,
  tier: TIER.DETECT,
  async run() {
    const metas = [...document.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]')].map(
      (m) => m.getAttribute("content") ?? "",
    );
    // Header-delivered CSP is not readable from script. Probing whether inline
    // eval is permitted is an indirect but reliable read on the strictest part.
    let evalAllowed = false;
    try {
      // eslint-disable-next-line no-new-func
      new Function("return 1")();
      evalAllowed = true;
    } catch {
      /* blocked by script-src 'unsafe-eval' being absent */
    }
    return ok(
      metas.length ? `${metas.length} CSP meta tag(s) in this document.` : "No CSP meta tag; any policy is header-delivered and unreadable from script.",
      lines(
        ...metas.map((m, i) => pad(`meta[${i}]`, m)),
        pad("new Function()", evalAllowed ? "allowed" : "BLOCKED (no unsafe-eval)"),
        "",
        evalAllowed
          ? ""
          : "Blocking eval breaks any library that compiles code at runtime — including some\nWASM glue and several codec shims.",
      ),
    );
  },
});

const connection = probe({
  id: "web.net.connection",
  title: "Network Information + online state",
  why: "Interpreting a timeout needs to know whether the device was on a slow link. Without this, a 30 s stall on 2G looks identical to a broken host call.",
  category: CAT,
  tier: TIER.INVOKE,
  async run() {
    const conn = (navigator as { connection?: Record<string, unknown> }).connection;
    const rows = [pad("navigator.onLine", navigator.onLine)];
    if (!conn) {
      return {
        status: "unsupported",
        detail: "navigator.connection is absent — link quality cannot be recorded, so timeouts in this report are not attributable to the network.",
        data: lines(...rows),
        diagnosis: "not-implemented",
      };
    }
    for (const k of ["effectiveType", "downlink", "rtt", "saveData", "type"]) {
      if (k in conn) rows.push(pad(k, conn[k]));
    }
    return ok(`Link reports as ${conn.effectiveType ?? "unknown"}.`, lines(...rows));
  },
});

const beacon = probe({
  id: "web.net.beacon",
  title: "sendBeacon",
  why: "The only way to get data out during page teardown. Returns false rather than throwing when blocked, which is easy to miss.",
  category: CAT,
  tier: TIER.INVOKE,
  async run() {
    const sendBeacon = need<(url: string, data?: BodyInit) => boolean>("navigator.sendBeacon");
    const queued = sendBeacon.call(navigator, SELF(), new Blob(["sonde"], { type: "text/plain" }));
    return queued
      ? ok("Beacon queued. (Queuing is all the API guarantees — delivery is not observable.)")
      : wrong("sendBeacon returned false — the request was refused, most likely by CSP connect-src.");
  },
});

const webTransport = detect({
  id: "web.net.webTransport",
  title: "WebTransport",
  why: "HTTP/3 datagrams. Absent almost everywhere on mobile; recorded so its arrival is visible in a future diff.",
  category: CAT,
  paths: "WebTransport",
});

const eventSource = detect({
  id: "web.net.eventSource",
  title: "Server-Sent Events",
  why: "The simplest server-push transport. Its absence forces polling or WebSocket, both heavier.",
  category: CAT,
  paths: "EventSource",
});

export const NET_PROBES: Probe[] = [
  permissionsPolicy,
  csp,
  connection,
  fetchProbe,
  websocket,
  beacon,
  eventSource,
  webTransport,
];

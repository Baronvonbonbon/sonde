// truapi `system` — handshake, feature probing, navigation, and the version
// call that does not exist.

import { createApp, isInsideContainerSync } from "@parity/product-sdk";
import { getTruApi, isInsideContainer, navigateTo, isChainSupported, formatHostError } from "@parity/product-sdk-host";
import { TRUAPI_VERSION, TRUAPI_CODEC_VERSION } from "@parity/truapi";
import { TIER, type Probe } from "../../core/types";
import { errText, lines, nt, ok, pad, probe, unsupported, wrong } from "../helpers";
import { CLOUD_ENV, PRODUCT_ID } from "../../../product.mjs";

const CAT = "system";
const host = (p: Omit<Probe, "bank" | "category">): Probe => probe({ ...p, bank: "host", category: CAT });

export const container = host({
  id: "host.system.container",
  title: "Host container detection",
  why: "Everything else in Bank B depends on this. Outside a container the host API is simply absent, and every probe below should read `skip`, not `fail`.",
  tier: TIER.DETECT,
  async run() {
    const sync = isInsideContainerSync();
    const async_ = await isInsideContainer().catch((e: Error) => `threw — ${e.message}`);
    const rows = lines(
      pad("isInsideContainerSync", sync),
      pad("isInsideContainer()", async_),
      pad("userAgent", navigator.userAgent),
      pad("truapi version", `${TRUAPI_VERSION} (codec ${TRUAPI_CODEC_VERSION})`),
    );
    return sync
      ? ok("Running inside the Polkadot host container.", rows)
      : {
          status: "unsupported",
          detail: "Not in a host container — this is a plain browser or a gateway iframe. Open via the Polkadot App for Bank B.",
          data: rows,
          diagnosis: "not-in-container",
        };
  },
});

export const handshake = host({
  id: "host.system.handshake",
  title: "TrUApi handshake",
  why: "The transport-level greeting that must succeed before any other host call can. A failure here explains every other host failure at once.",
  tier: TIER.INVOKE,
  needs: ["host.system.container"],
  timeoutMs: 30_000,
  async run(ctx) {
    const api = await getTruApi();
    if (!api) return unsupported("getTruApi() returned null — no host transport.");
    // system.handshake() is a neverthrow ResultAsync, not @parity/result's
    // tagged shape — reading `.ok` off it yields undefined and every handshake
    // would read as a failure. See nt() in helpers.
    const [, ms] = await ctx.timed(async () => {
      const r = await nt(api.system.handshake());
      if (!r.ok) throw new Error(`handshake rejected: ${errText(r.error)}`);
    });
    ctx.shared.scratch.set("truapi", api);
    return ok(
      `Handshake completed in ${ms} ms.`,
      lines(pad("namespaces", Object.keys(api).filter((k) => !k.startsWith("_")).join(", "))),
    );
  },
});

export const version = host({
  id: "host.system.version",
  title: "App version — is one exposed at all?",
  why: "A compatibility report that cannot name the build it describes cannot be compared to another one. This probe exists to make that gap a line item in every report rather than a footnote.",
  tier: TIER.DETECT,
  needs: ["host.system.container"],
  repro: `// Checked across every truapi namespace:
//   account, chain, chat, coinPayment, entropy, localStorage, notifications,
//   payment, permissions, preimage, resourceAllocation, signing,
//   statementStore, system, theme
// None exposes an app version, build number, or release channel.
const api = await getTruApi();
Object.keys(api.system);  // handshake, featureSupported, navigateTo`,
  async run() {
    const api = await getTruApi();
    if (!api) return unsupported("No host transport, so nothing to enumerate.");

    // Enumerated rather than asserted: if a version call is ever added, this
    // probe starts passing on its own and the diff CLI surfaces it.
    const found: string[] = [];
    for (const [ns, client] of Object.entries(api)) {
      if (!client || typeof client !== "object") continue;
      for (const method of methodsOf(client)) {
        if (/version|build|release|appinfo/i.test(method)) found.push(`${ns}.${method}`);
      }
    }

    if (found.length) {
      return ok(
        `A version-shaped call exists: ${found.join(", ")}. The fingerprint should be updated to use it.`,
        lines(...found.map((f) => pad("found", f))),
      );
    }

    return {
      status: "unsupported",
      detail:
        "No host API returns an app version. Reports from different builds cannot be attributed to those builds, " +
        "which is the single largest gap in making these results comparable.",
      data: lines(
        pad("namespaces searched", Object.keys(api).length),
        pad("version-shaped calls", "none"),
        "",
        "The Chromium version in the fingerprint is the working proxy: the app ships a bundled",
        "engine, so it moves with app releases. It is a proxy, not an answer — two app builds",
        "on the same Chromium are indistinguishable in this report.",
        "",
        "A `system.version()` returning the host's own version string would fix this outright.",
      ),
      diagnosis: "not-implemented",
    };
  },
});

export const featureChain = host({
  id: "host.system.featureSupported",
  title: "featureSupported / isChainSupported",
  why: "The only introspection the host offers about itself, and it covers exactly one thing: chains. Which chains a build carries decides which storage probes can work at all.",
  tier: TIER.INVOKE,
  needs: ["host.system.handshake"],
  timeoutMs: 30_000,
  async run() {
    // The mismatch these detect is real and already cost kite a debugging
    // session: an Android devnet build carries devnet bulletin and rejects
    // paseo, while the gateway does the reverse.
    const chains: Record<string, string> = {
      "Polkadot relay": "0x91b171bb158e2d3848fa23a9f1c25182fb8e20313b2c1eb49219da7a70ce90c3",
      "Kusama relay": "0xb0a8d493285c2df73290dfb7e61f870f17b41801197a149ca93654499ea3dafe",
      "Polkadot Asset Hub": "0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f",
    };
    const rows: string[] = [];
    for (const [name, genesis] of Object.entries(chains)) {
      const r = await isChainSupported(genesis as `0x${string}`);
      rows.push(pad(name, r.ok ? (r.value ? "supported" : "not supported") : `error — ${formatHostError(r.error)}`));
    }
    return ok(
      "Queried the host's chain support.",
      lines(
        ...rows,
        "",
        "A host build carries a fixed set of chains. Publishing under one environment and",
        "asking for another is the failure mode product.mjs warns about, and it surfaces here",
        "as 'not supported' rather than as an error at the call site.",
      ),
    );
  },
});

export const createAppProbe = host({
  id: "host.system.createApp",
  title: "createApp — construct the SDK App",
  why: "Every Bank B probe that touches wallet or storage needs this object. It is also where a mismatched cloud-storage environment surfaces, so it tries both.",
  tier: TIER.INVOKE,
  needs: ["host.system.container"],
  timeoutMs: 60_000,
  async run(ctx) {
    const rows: string[] = [pad("configured env", CLOUD_ENV), pad("productId", PRODUCT_ID)];
    let lastError = "";

    // Try the configured environment first, then the other one. Pinning either
    // breaks the opposite surface, so reporting which the host ACCEPTED is more
    // useful than reporting which we asked for.
    for (const env of [CLOUD_ENV, CLOUD_ENV === "devnet" ? "paseo" : "devnet"] as const) {
      try {
        const app = await createApp({ name: PRODUCT_ID, cloudStorage: { environment: env } });
        ctx.shared.app = app;
        ctx.shared.appEnv = env;
        rows.push(pad("accepted env", `${env}${env === CLOUD_ENV ? "" : "  ← NOT the publish env"}`));
        rows.push(pad("cloudStorage", app.cloudStorage ? "available" : "null (disabled)"));
        return ok(
          env === CLOUD_ENV
            ? "App constructed on the configured environment."
            : `App constructed, but only on "${env}" — not the environment this bundle was published under. Storage probes will exercise the wrong chain.`,
          lines(...rows),
        );
      } catch (e) {
        lastError = (e as Error).message;
        rows.push(pad(`createApp(${env})`, `THREW — ${lastError.slice(0, 160)}`));
      }
    }
    return wrong(`createApp failed on both environments: ${lastError}`, lines(...rows));
  },
});

export const navigate = host({
  id: "host.system.navigateTo",
  title: "navigateTo",
  why: "The host's own link-opening call, and one of the nine declared device permissions (OpenUrl). Whether a Product can hand a URL to the host at all is a basic integration question.",
  tier: TIER.PROMPT,
  gesture: true,
  needs: ["host.system.handshake"],
  timeoutMs: 30_000,
  async run() {
    // Navigates to this suite's own URL. If the host honours it the result is a
    // no-op; a probe should not send anyone somewhere they did not ask to go.
    const r = await navigateTo(location.href);
    return r.ok
      ? ok("Host accepted the navigation request.", pad("url", location.href) + "\n\nDeliberately self-referential — this is a no-op if honoured.")
      : {
          status: "blocked",
          detail: `Host refused: ${formatHostError(r.error)}`,
          data: pad("url", location.href),
          diagnosis: "os-denied",
        };
  },
});

function methodsOf(obj: object): string[] {
  const out = new Set<string>();
  for (let o: object | null = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) {
      if (k !== "constructor" && typeof (obj as Record<string, unknown>)[k] === "function") out.add(k);
    }
  }
  return [...out];
}

export const SYSTEM_PROBES: Probe[] = [
  container,
  handshake,
  version,
  createAppProbe,
  featureChain,
  navigate,
];

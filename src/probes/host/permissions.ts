// truapi `permissions` — the host's own permission surface.
//
// This file is the reason to re-examine BUG-geolocation.md before it is triaged.
// That report states:
//
//   "There is no workaround inside the runtime — the Product SDK exposes no
//    location capability of its own (checked across @parity/product-sdk and
//    every sibling package), so the standard web API is the only route."
//
// But @parity/truapi declares, at generated/types.d.ts:2947:
//
//   export type HostDevicePermissionRequest =
//     "Notifications" | "Camera" | "Microphone" | "Bluetooth" | "NFC"
//     | "Location" | "Clipboard" | "OpenUrl" | "Biometrics";
//
// surfaced as requestDevicePermission() in @parity/product-sdk-host. So a
// location capability IS declared. Whether it is IMPLEMENTED is a different
// question, and exactly the one host.permissions.location answers.
//
// If it grants and geolocation then works, the filed issue is a documentation
// gap rather than a platform gap, and should be reclassified before a
// maintainer spends time on the WebView.

import {
  requestDevicePermission,
  requestPermission,
  formatHostError,
  type DevicePermissionKind,
  type RemotePermission,
} from "@parity/product-sdk-host";
import { TIER, type Probe } from "../../core/types";
import { lines, ok, pad, probe } from "../helpers";

const CAT = "permissions";
const host = (p: Omit<Probe, "bank" | "category">): Probe => probe({ ...p, bank: "host", category: CAT });

/** Every kind the type declares. Enumerated so a new one shows up as a gap. */
const DEVICE_KINDS: DevicePermissionKind[] = [
  "Notifications",
  "Camera",
  "Microphone",
  "Bluetooth",
  "NFC",
  "Location",
  "Clipboard",
  "OpenUrl",
  "Biometrics",
];

/**
 * The one that matters. Kept separate from the sweep below so it can be run,
 * and re-run, on its own — and so the geolocation probe can be re-run
 * immediately after it while any grant is still fresh.
 */
export const location = host({
  id: "host.permissions.location",
  title: "requestDevicePermission(\"Location\")",
  why: "BUG-geolocation.md says the SDK exposes no location capability. The type says otherwise. If this grants and web geolocation then works, that issue is misfiled — worth knowing before a maintainer starts on the WebView.",
  tier: TIER.PROMPT,
  gesture: true,
  permissions: ["geolocation"],
  needs: ["host.system.handshake"],
  timeoutMs: 90_000,
  repro: `import { requestDevicePermission } from "@parity/product-sdk-host";

const r = await requestDevicePermission("Location");
console.log(r.ok ? \`granted: \${r.value}\` : \`error: \${r.error}\`);

// then, immediately:
navigator.geolocation.getCurrentPosition(
  p => console.log("fix", p.coords),
  e => console.log("still denied", e.code, e.message),
);`,
  async run(ctx) {
    const before = await peek("geolocation");
    const r = await requestDevicePermission("Location");
    const after = await peek("geolocation");

    if (!r.ok) {
      return {
        status: "fail",
        detail: `The host rejected the call: ${formatHostError(r.error)}`,
        data: lines(
          pad("web permission before", before),
          pad("web permission after", after),
          "",
          "The permission kind is declared in the type but the call errors, so this is declared",
          "and not implemented. That is still a more actionable finding than 'no capability",
          "exists' — it points at the host's permission handler rather than the WebView's.",
        ),
        diagnosis: "not-implemented",
      };
    }

    const granted = r.value;
    // Try geolocation right away. A grant that does not unblock the web API is
    // a different, and worse, result than no grant at all: it means two
    // permission systems that do not talk to each other.
    let webResult = "not attempted";
    if (granted) {
      try {
        await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 20_000, enableHighAccuracy: false });
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
        });
        webResult = "SUCCEEDED — the host grant unblocked navigator.geolocation";
      } catch (e) {
        webResult = `still failed — ${(e as Error).message}`;
      }
    }

    return {
      status: granted ? "pass" : "blocked",
      detail: granted
        ? `Host granted Location. Web geolocation immediately after: ${webResult}`
        : "Host declined Location.",
      data: lines(
        pad("host granted", granted),
        pad("web permission before", before),
        pad("web permission after", after),
        pad("geolocation retry", webResult),
        "",
        granted && webResult.startsWith("SUCCEEDED")
          ? "FINDING: BUG-geolocation.md needs amending. A location capability exists in the SDK\n" +
            "and using it unblocks the web API. The issue should be reclassified from a platform\n" +
            "gap to a documentation gap — the fix is to document this call, not to wire up\n" +
            "onGeolocationPermissionsShowPrompt."
          : granted
            ? "FINDING: the host grants Location, but navigator.geolocation still fails. Two\n" +
              "permission systems that do not talk to each other is worse than one that is\n" +
              "missing, because the grant gives false confidence. BUG-geolocation.md stands,\n" +
              "with this as additional evidence."
            : "The host declined. BUG-geolocation.md's conclusion is unaffected, but its claim\n" +
              "that no capability exists should still be corrected — the capability exists and\n" +
              "says no.",
      ),
      diagnosis: granted ? undefined : "os-denied",
    };
  },
});

/**
 * The remaining eight kinds, one probe each.
 *
 * Generated rather than written out: they share a signature and a failure mode,
 * and the point is coverage of the enum rather than bespoke reasoning per kind.
 */
function devicePermission(kind: DevicePermissionKind, why: string): Probe {
  return host({
    id: `host.permissions.${kind.toLowerCase()}`,
    title: `requestDevicePermission("${kind}")`,
    why,
    tier: TIER.PROMPT,
    gesture: true,
    needs: ["host.system.handshake"],
    timeoutMs: 60_000,
    async run() {
      const r = await requestDevicePermission(kind);
      if (!r.ok) {
        return {
          status: "fail",
          detail: `Declared in the type but the call errored: ${formatHostError(r.error)}`,
          data: pad("kind", kind),
          diagnosis: "not-implemented",
        };
      }
      return r.value
        ? ok(`Host granted ${kind}.`)
        : { status: "blocked", detail: `Host declined ${kind}.`, diagnosis: "os-denied" as const };
    },
  });
}

const otherDeviceKinds = DEVICE_KINDS.filter((k) => k !== "Location").map((kind) =>
  devicePermission(
    kind,
    {
      Notifications: "The host's own notification permission, separate from the web Notification API. A Product may need either or both.",
      Camera: "Camera worked in kite where location did not, because it routes through a different WebView callback. Confirming that at the host layer isolates which layer differs.",
      Microphone: "Granted through the same WebView callback as the camera but not always the same OS permission.",
      Bluetooth: "Declared by the host and separately gated by the WebView. A gap between the two would explain a Web Bluetooth failure that looks like an engine problem.",
      NFC: "Android-only at the web layer. If the host declares it and the WebView does not expose NDEFReader, the seam is visible here.",
      Clipboard: "The web clipboard is gesture-gated and frequently blocked in WebViews. A host-level grant may be the only route.",
      OpenUrl: "Whether a Product may hand a URL to the host to open externally.",
      Biometrics: "Adjacent to WebAuthn. Which of the two is available decides how a Product asks for a local unlock.",
    }[kind]!,
  ),
);

export const remotePermissions = host({
  id: "host.permissions.remote",
  title: "requestRemotePermission — all five variants",
  why: "These gate outbound network access and every submit path. ChainSubmit, PreimageSubmit and StatementSubmit are also triggered implicitly by their business calls, so a denial here explains a later failure that looks unrelated.",
  tier: TIER.PROMPT,
  gesture: true,
  needs: ["host.system.handshake"],
  timeoutMs: 120_000,
  async run() {
    const variants: [string, RemotePermission][] = [
      ["Remote (domains)", { tag: "Remote", value: { domains: ["rpc.polkadot.io"] } }],
      ["WebRtc", { tag: "WebRtc", value: undefined }],
      ["ChainSubmit", { tag: "ChainSubmit", value: undefined }],
      ["PreimageSubmit", { tag: "PreimageSubmit", value: undefined }],
      ["StatementSubmit", { tag: "StatementSubmit", value: undefined }],
    ];

    const rows: string[] = [];
    let granted = 0;
    let errored = 0;
    for (const [label, permission] of variants) {
      const r = await requestPermission(permission);
      if (!r.ok) {
        rows.push(pad(label, `ERROR — ${formatHostError(r.error)}`));
        errored++;
      } else {
        rows.push(pad(label, r.value ? "granted" : "denied"));
        if (r.value) granted++;
      }
    }

    return {
      status: errored ? "fail" : granted ? "pass" : "blocked",
      detail: errored
        ? `${errored} of ${variants.length} variants errored rather than answering.`
        : `${granted} of ${variants.length} granted.`,
      data: lines(
        ...rows,
        "",
        "A denial here is a policy answer and is legitimate. An ERROR is not: it means the",
        "variant is declared in the type and not handled by the host, which leaves calling",
        "code unable to tell 'refused' from 'broken'.",
      ),
      diagnosis: errored ? "not-implemented" : granted ? undefined : "os-denied",
    };
  },
});

async function peek(name: string): Promise<string> {
  try {
    return (await navigator.permissions.query({ name: name as PermissionName })).state;
  } catch {
    return "unavailable";
  }
}

export const PERMISSION_PROBES: Probe[] = [location, remotePermissions, ...otherDeviceKinds];

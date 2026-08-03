// Everything that reaches out of the page at the user.
//
// This is the densest cluster of gesture-gated APIs in the suite, which is why
// the runner has a gesture queue at all: clipboard.read, share, fullscreen and
// idle detection each consume their own transient activation.

import { TIER, type Probe } from "../../core/types";
import { at, detect, lines, need, ok, pad, probe, unsupported, wrong } from "../helpers";

const CAT = "ux";

const clipboardWrite = probe({
  id: "web.ux.clipboardWrite",
  title: "Clipboard write",
  why: "The report's own 'Copy markdown' button depends on this. If it is blocked, sharing a result falls back to selecting text by hand — worth knowing before you need it.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  permissions: ["clipboard-write"],
  timeoutMs: 20_000,
  async run(ctx) {
    const clipboard = need<Clipboard>("navigator.clipboard");
    const token = `sonde-${Date.now()}`;
    await clipboard.writeText(token);
    ctx.shared.scratch.set("clipboard-token", token);
    return ok(
      "Wrote text to the clipboard.",
      lines(pad("token", token), "", "The read probe checks whether this exact token comes back."),
    );
  },
});

const clipboardRead = probe({
  id: "web.ux.clipboardRead",
  title: "Clipboard read",
  why: "Read is gated far more tightly than write and is routinely absent where write works. Anything accepting a pasted address or seed phrase depends on it.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  permissions: ["clipboard-read"],
  needs: ["web.ux.clipboardWrite"],
  timeoutMs: 20_000,
  async run(ctx) {
    const clipboard = need<Clipboard>("navigator.clipboard");
    if (!clipboard.readText) return unsupported("clipboard.readText is absent — write-only clipboard.");
    const text = await clipboard.readText();
    const expected = ctx.shared.scratch.get("clipboard-token");
    return text === expected
      ? ok("Read back exactly what the write probe put there.", pad("value", text))
      : wrong(
          "Read succeeded but returned something else — the clipboard is virtualised or partitioned.",
          lines(pad("expected", String(expected)), pad("got", text.slice(0, 80))),
        );
  },
});

const share = probe({
  id: "web.ux.share",
  title: "Web Share — text and URL",
  why: "The most likely route for getting a report off the device in an app with no file manager. Its absence changes how results are exported.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  timeoutMs: 60_000,
  async run() {
    const share = need<(d: ShareData) => Promise<void>>("navigator.share");
    await share.call(navigator, {
      title: "sonde",
      text: "Capability probe result",
      url: location.href,
    });
    return ok("Share sheet opened and the share completed.");
  },
});

const shareFiles = probe({
  id: "web.ux.shareFiles",
  title: "Web Share — files",
  why: "Sharing text is common; sharing a File is not. This is what decides whether a JSON report can be handed to another app directly.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  needs: ["web.ux.share"],
  timeoutMs: 60_000,
  async run() {
    const canShare = at("navigator.canShare") as ((d: ShareData) => boolean) | undefined;
    if (!canShare) return unsupported("navigator.canShare is absent, so file sharing cannot be attempted safely.");
    const file = new File([JSON.stringify({ sonde: true })], "sonde.json", { type: "application/json" });
    if (!canShare.call(navigator, { files: [file] })) {
      return unsupported("canShare({files}) is false — this runtime shares text but not files.");
    }
    await (navigator.share as (d: ShareData) => Promise<void>).call(navigator, { files: [file], title: "sonde report" });
    return ok("Shared a File successfully — reports can be handed to other apps directly.");
  },
});

const notifications = probe({
  id: "web.ux.notifications",
  title: "Notifications",
  why: "The web notification path and the host's own push API are separate systems. Knowing which of the two works decides how a Product tells a user anything while backgrounded.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  permissions: ["notifications"],
  timeoutMs: 60_000,
  async run(ctx) {
    const N = need<typeof Notification>("Notification");
    const before = N.permission;
    const granted = before === "granted" ? "granted" : await N.requestPermission();
    if (granted !== "granted") {
      return {
        status: "blocked",
        detail: `Permission is "${granted}".`,
        data: lines(pad("before", before), pad("after", granted)),
        // The runner's permission-delta check refines this further.
        diagnosis: granted === "denied" ? "os-denied" : "user-dismissed",
      };
    }
    const n = new N("sonde", { body: "Capability probe — this notification is safe to dismiss.", tag: "sonde" });
    ctx.cleanup.add("notification", () => n.close());
    await new Promise((r) => setTimeout(r, 1200));
    return ok("Permission granted and a notification was posted.", lines(pad("before", before), pad("after", granted)));
  },
});

const push = detect({
  id: "web.ux.push",
  title: "Push API",
  why: "Needs a service worker AND a push service. Recorded separately from notifications because a runtime can have one without the other.",
  category: CAT,
  // Push genuinely needs BOTH: no service worker means no push, whatever
  // PushManager's presence suggests. "all" is correct here.
  paths: ["PushManager", "navigator.serviceWorker"],
});

const vibration = probe({
  id: "web.ux.vibrate",
  title: "Vibration",
  why: "Silent haptic confirmation, and one of the few APIs that returns false rather than throwing when refused — easy to treat as success by mistake.",
  category: CAT,
  tier: TIER.INVOKE,
  async run() {
    const vibrate = need<(p: number | number[]) => boolean>("navigator.vibrate");
    const accepted = vibrate.call(navigator, [60, 40, 60]);
    return accepted
      ? ok("Pattern accepted. (Whether the motor actually fired is not observable from script.)")
      : wrong("navigator.vibrate returned false — refused, most likely by permissions-policy or a user setting.");
  },
});

const wakeLock = probe({
  id: "web.ux.wakeLock",
  title: "Screen Wake Lock",
  why: "A long probe run, or a long signing flow, dies if the screen sleeps. This is also a clean test of whether cleanup actually releases things.",
  category: CAT,
  tier: TIER.PROMPT,
  permissions: ["screen-wake-lock"],
  timeoutMs: 20_000,
  async run(ctx) {
    const wl = need<{ request(t: "screen"): Promise<{ released: boolean; release(): Promise<void>; type: string }> }>(
      "navigator.wakeLock",
    );
    const sentinel = await wl.request("screen");
    ctx.cleanup.add("wake-lock", async () => {
      if (!sentinel.released) await sentinel.release();
    });
    return ok(
      `Acquired a "${sentinel.type}" wake lock.`,
      "Released by the runner's cleanup as this probe ends — the screen will not stay on.",
    );
  },
});

const fullscreen = probe({
  id: "web.ux.fullscreen",
  title: "Fullscreen",
  why: "Permissions-policy gated in frames, and a good check that teardown restores the page — a probe that leaves the document fullscreen breaks every card below it.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  timeoutMs: 30_000,
  async run(ctx) {
    if (!document.fullscreenEnabled) {
      return {
        status: "blocked",
        detail: "document.fullscreenEnabled is false — disabled for this document, most likely by permissions-policy.",
        diagnosis: "policy-blocked-by-embedder",
        data: pad("framed", window.self !== window.top),
      };
    }
    ctx.cleanup.add("exit-fullscreen", async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
    });
    await document.documentElement.requestFullscreen();
    await new Promise((r) => setTimeout(r, 600));
    const entered = !!document.fullscreenElement;
    await document.exitFullscreen();
    return entered ? ok("Entered and exited fullscreen.") : wrong("requestFullscreen resolved but no element became fullscreen.");
  },
});

const orientationLock = probe({
  id: "web.ux.orientationLock",
  title: "Screen orientation lock",
  why: "Requires fullscreen on most engines, so a failure here is usually inherited from the fullscreen probe rather than independent.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  timeoutMs: 30_000,
  async run(ctx) {
    const so = need<{ lock?(o: string): Promise<void>; unlock?(): void; type: string; angle: number }>("screen.orientation");
    const info = lines(pad("type", so.type), pad("angle", so.angle));
    if (!so.lock) return unsupported("screen.orientation.lock is absent (read-only orientation).", info);

    ctx.cleanup.add("orientation-unlock", () => so.unlock?.());
    ctx.cleanup.add("exit-fullscreen", async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
    });

    // Locking generally requires fullscreen. Entering it first makes the result
    // a statement about orientation rather than about fullscreen.
    if (document.fullscreenEnabled && !document.fullscreenElement) {
      await document.documentElement.requestFullscreen().catch(() => {});
    }
    await so.lock("portrait");
    return ok(`Locked to portrait (was ${so.type}).`, info);
  },
});

const idleDetection = probe({
  id: "web.ux.idleDetection",
  title: "Idle Detection",
  why: "Powerful and rarely granted. Included because a runtime that grants it is unusually permissive, which is itself worth recording.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  permissions: ["idle-detection"],
  timeoutMs: 30_000,
  async run(ctx) {
    const Ctor = at("IdleDetector") as
      | (new () => { start(o: object): Promise<void>; userState: string; screenState: string })
      | undefined;
    const requestPermission = (Ctor as unknown as { requestPermission?: () => Promise<string> })?.requestPermission;
    if (!Ctor) return unsupported("IdleDetector is absent — the common answer.");

    const state = await requestPermission?.();
    if (state && state !== "granted") {
      return { status: "blocked", detail: `Permission is "${state}".`, diagnosis: "os-denied" };
    }
    const d = new Ctor();
    await d.start({ threshold: 60_000, signal: ctx.signal });
    return ok(`Detector started.`, lines(pad("userState", d.userState), pad("screenState", d.screenState)));
  },
});

const contactPicker = probe({
  id: "web.ux.contactPicker",
  title: "Contact Picker",
  why: "Android-Chromium-only. Reading it is the difference between an address book flow being possible and needing manual entry.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  timeoutMs: 60_000,
  async run() {
    const contacts = at("navigator.contacts") as
      | { select(props: string[], opts?: object): Promise<unknown[]>; getProperties(): Promise<string[]> }
      | undefined;
    if (!contacts) return unsupported("navigator.contacts is absent.");
    const props = await contacts.getProperties();
    // Deliberately requests the narrowest field. A probe should not pull a
    // stranger's address book into a report that gets shared.
    const picked = await contacts.select([props.includes("name") ? "name" : props[0]], { multiple: false });
    return ok(
      `Picker returned ${picked.length} contact(s).`,
      lines(pad("available props", props.join(", ")), "", "Contact contents are NOT recorded in this report."),
    );
  },
});

const eyeDropper = detect({
  id: "web.ux.eyeDropper",
  title: "EyeDropper",
  why: "Desktop-only. Its presence is a reliable tell that this is not a mobile WebView, independent of the user agent string.",
  category: CAT,
  paths: "EyeDropper",
});

const virtualKeyboard = detect({
  id: "web.ux.virtualKeyboard",
  title: "VirtualKeyboard API",
  why: "Lets a page control layout around the on-screen keyboard rather than being resized by it. Its absence forces visualViewport hacks.",
  category: CAT,
  paths: "navigator.virtualKeyboard",
});

const viewTransitions = detect({
  id: "web.ux.viewTransitions",
  title: "View Transitions",
  why: "Purely cosmetic, and included as a dated marker of engine recency — useful for placing an unknown WebView build on a timeline.",
  category: CAT,
  paths: "document.startViewTransition",
});

const badging = detect({
  id: "web.ux.badging",
  title: "App Badging",
  why: "Installed-PWA surface. Recorded to distinguish a WebView from an installed web app context.",
  category: CAT,
  paths: ["navigator.setAppBadge", "navigator.clearAppBadge"],
});

export const UX_PROBES: Probe[] = [
  vibration,
  wakeLock,
  eyeDropper,
  virtualKeyboard,
  viewTransitions,
  badging,
  push,
  notifications,
  clipboardWrite,
  clipboardRead,
  share,
  shareFiles,
  fullscreen,
  orientationLock,
  idleDetection,
  contactPicker,
];

// Platform identity and the odds and ends that do not group elsewhere.
//
// These run first because they are cheap and because the fingerprint they
// produce is what makes every later result attributable to a device.

import { TIER, type Probe } from "../../core/types";
import { at, detect, lines, need, ok, pad, present, probe, unsupported, wrong } from "../helpers";

const CAT = "platform";

const userAgentData = probe({
  id: "web.platform.userAgentData",
  title: "userAgentData high-entropy hints",
  why: "The only structured route to device model, OS version, and exact Chromium build. Without it a bug report says 'some Android phone', which is not reproducible.",
  category: CAT,
  tier: TIER.INVOKE,
  async run() {
    const uaData = at("navigator.userAgentData") as
      | { brands?: unknown; mobile?: boolean; platform?: string; getHighEntropyValues?(h: string[]): Promise<Record<string, unknown>> }
      | undefined;
    if (!uaData) {
      return unsupported(
        "navigator.userAgentData is absent — non-Chromium, or an engine old enough to predate UA-CH.",
        pad("userAgent", navigator.userAgent),
      );
    }
    if (!uaData.getHighEntropyValues) {
      return wrong(
        "userAgentData exists but getHighEntropyValues does not. Low-entropy hints alone cannot name the device.",
        lines(pad("brands", JSON.stringify(uaData.brands)), pad("platform", uaData.platform)),
      );
    }
    const hints = await uaData.getHighEntropyValues([
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
    const model = hints.model as string;
    return {
      // An empty model string is the interesting case: the API answered but
      // withheld the one field a bug report needs, which is a privacy decision
      // rather than a failure and must not read as a pass.
      status: model ? "pass" : "blocked",
      detail: model
        ? `Device identifies as "${model}".`
        : "Answered, but `model` came back empty — the device cannot be named in a report.",
      data: lines(...Object.entries(hints).map(([k, v]) => pad(k, JSON.stringify(v)))),
      diagnosis: model ? undefined : "policy-blocked-by-embedder",
    };
  },
});

const battery = probe({
  id: "web.platform.battery",
  title: "Battery Status",
  why: "Removed from most browsers on fingerprinting grounds but retained in some WebViews. Whether it is here says something about how permissive this embedding is.",
  category: CAT,
  tier: TIER.INVOKE,
  async run() {
    const getBattery = at("navigator.getBattery") as (() => Promise<Record<string, unknown>>) | undefined;
    if (!getBattery) return unsupported("navigator.getBattery is absent — the expected modern answer.");
    const b = await getBattery.call(navigator);
    return ok(
      `Exposed — level ${Math.round((b.level as number) * 100)}%, ${b.charging ? "charging" : "on battery"}.`,
      lines(
        pad("level", b.level),
        pad("charging", b.charging),
        pad("chargingTime", b.chargingTime),
        pad("dischargingTime", b.dischargingTime),
        "",
        "NOTE: most browsers dropped this API deliberately. Its presence is a fingerprinting",
        "surface, not a feature — worth knowing about, not worth relying on.",
      ),
    );
  },
});

const gamepad = probe({
  id: "web.platform.gamepad",
  title: "Gamepad API",
  why: "Cheap check that the input layer is wired at all. A WebView with no gamepad support reports an empty list, not an absent API.",
  category: CAT,
  tier: TIER.INVOKE,
  async run() {
    const getGamepads = need<() => (Gamepad | null)[]>("navigator.getGamepads");
    const pads = getGamepads.call(navigator).filter(Boolean) as Gamepad[];
    return ok(
      pads.length ? `${pads.length} gamepad(s) connected.` : "API present; nothing connected (expected).",
      lines(...pads.map((p) => pad(p.index.toString(), `${p.id} · ${p.buttons.length} buttons`))) || undefined,
    );
  },
});

const midi = probe({
  id: "web.platform.midi",
  title: "Web MIDI (non-sysex)",
  why: "MIDI is permission-gated in Chromium and routinely stripped from embedded WebViews. A clean example of an API that exists but is policy-blocked.",
  category: CAT,
  tier: TIER.PROMPT,
  permissions: ["midi"],
  timeoutMs: 20_000,
  async run(ctx) {
    const requestMIDIAccess = need<(o?: { sysex: boolean }) => Promise<{ inputs: Map<string, unknown>; outputs: Map<string, unknown> }>>(
      "navigator.requestMIDIAccess",
    );
    const access = await requestMIDIAccess.call(navigator, { sysex: false });
    ctx.cleanup.add("midi-access", () => void 0);
    return ok(
      `Granted — ${access.inputs.size} input(s), ${access.outputs.size} output(s).`,
      lines(pad("inputs", access.inputs.size), pad("outputs", access.outputs.size)),
    );
  },
});

const speechSynthesis = probe({
  id: "web.platform.speechSynthesis",
  title: "Speech Synthesis voices",
  why: "Present-but-empty is the common WebView failure: the API answers, getVoices() returns nothing, and speech silently does not happen.",
  category: CAT,
  tier: TIER.INVOKE,
  async run() {
    const synth = need<SpeechSynthesis>("speechSynthesis");
    // Voices load asynchronously on first call and the event is the only
    // reliable signal; polling a cold getVoices() reports a false empty.
    let voices = synth.getVoices();
    if (!voices.length) {
      await new Promise<void>((r) => {
        const done = () => r();
        synth.addEventListener("voiceschanged", done, { once: true });
        setTimeout(done, 1500);
      });
      voices = synth.getVoices();
    }
    if (!voices.length) {
      return wrong(
        "speechSynthesis exists but exposes no voices — calls to speak() will do nothing, silently.",
        "This is the failure that looks like a pass to feature detection.",
      );
    }
    return ok(
      `${voices.length} voice(s) available.`,
      lines(...voices.slice(0, 8).map((v) => pad(v.lang, `${v.name}${v.localService ? " (local)" : " (network)"}`))),
    );
  },
});

const speechRecognition = detect({
  id: "web.platform.speechRecognition",
  title: "Speech Recognition",
  why: "Prefixed-only in Chromium and usually network-backed, so its presence also implies an outbound dependency.",
  category: CAT,
  paths: ["webkitSpeechRecognition"],
});

const locks = probe({
  id: "web.platform.locks",
  title: "Web Locks",
  why: "Cross-tab coordination. A suite that cannot take a lock cannot safely assume it is the only copy running.",
  category: CAT,
  tier: TIER.INVOKE,
  async run() {
    const locks = need<{ request(name: string, fn: () => Promise<void>): Promise<void>; query(): Promise<unknown> }>(
      "navigator.locks",
    );
    let held = false;
    await locks.request("sonde-probe", async () => {
      held = true;
    });
    return held
      ? ok("Acquired and released a named lock.")
      : wrong("locks.request resolved without ever entering the callback.");
  },
});

const scheduler = detect({
  id: "web.platform.scheduler",
  title: "Prioritised task scheduling",
  why: "scheduler.postTask lets long work yield without blocking input. Its absence means the only tool is setTimeout(0).",
  category: CAT,
  // yield() shipped well after postTask(); having one without the other is
  // ordinary engine-version skew, not a broken implementation.
  paths: ["scheduler.postTask", "scheduler.yield"],
  mode: "any",
});

const timerResolution = probe({
  id: "web.platform.timerResolution",
  title: "performance.now() resolution",
  why: "Timer precision is clamped unless the page is cross-origin isolated. Every duration in this report inherits that clamp, so it needs stating.",
  category: CAT,
  tier: TIER.INVOKE,
  async run() {
    // Find the smallest non-zero delta the clock will report. Sampling until it
    // changes is the only way to see the clamp; asking for the resolution
    // directly is not something the platform exposes.
    const deltas: number[] = [];
    for (let i = 0; i < 12; i++) {
      const t0 = performance.now();
      let t1 = t0;
      while (t1 === t0) t1 = performance.now();
      deltas.push(t1 - t0);
    }
    const min = Math.min(...deltas);
    return ok(
      `Smallest observable tick: ${min.toFixed(4)} ms.`,
      lines(
        pad("crossOriginIsolated", window.crossOriginIsolated),
        pad("min delta (ms)", min.toFixed(4)),
        "",
        min >= 0.1
          ? "Coarse (≥100 µs) — the expected clamp for a page that is not cross-origin isolated."
          : "Fine-grained — this page has relaxed timer clamping.",
        "Durations elsewhere in this report are quantised to roughly this value.",
      ),
    );
  },
});

const memory = probe({
  id: "web.platform.memory",
  title: "Memory measurement",
  why: "Needed to interpret a crash. A probe that dies on a 512 MB device is a different report from one that dies on a 12 GB device.",
  category: CAT,
  tier: TIER.INVOKE,
  async run() {
    const parts: string[] = [
      pad("deviceMemory (GB)", (navigator as { deviceMemory?: number }).deviceMemory ?? "absent"),
      pad("hardwareConcurrency", navigator.hardwareConcurrency ?? "absent"),
    ];
    const legacy = at("performance.memory") as { jsHeapSizeLimit: number; usedJSHeapSize: number } | undefined;
    if (legacy) {
      parts.push(
        pad("jsHeapSizeLimit", `${(legacy.jsHeapSizeLimit / 1e6).toFixed(0)} MB`),
        pad("usedJSHeapSize", `${(legacy.usedJSHeapSize / 1e6).toFixed(1)} MB`),
      );
    }
    const measure = at("performance.measureUserAgentSpecificMemory") as (() => Promise<{ bytes: number }>) | undefined;
    if (measure && window.crossOriginIsolated) {
      try {
        const m = await measure.call(performance);
        parts.push(pad("measureUAMemory", `${(m.bytes / 1e6).toFixed(1)} MB`));
      } catch (e) {
        parts.push(pad("measureUAMemory", `threw — ${(e as Error).message}`));
      }
    } else {
      parts.push(pad("measureUAMemory", measure ? "present but needs crossOriginIsolated" : "absent"));
    }
    const anything = present("navigator.deviceMemory") || !!legacy || !!measure;
    return anything
      ? ok("Some memory reporting is available.", lines(...parts))
      : unsupported("No memory reporting of any kind — a crash here will be uninterpretable.", lines(...parts));
  },
});

const permissionsApi = probe({
  id: "web.platform.permissionsApi",
  title: "Permissions API coverage",
  why: "This suite's central diagnostic — 'prompt before AND after a denial means nobody was asked' — depends entirely on permissions.query. Which names it accepts is therefore load-bearing.",
  category: CAT,
  tier: TIER.INVOKE,
  async run() {
    const perms = need<Permissions>("navigator.permissions");
    const names = [
      "geolocation",
      "notifications",
      "camera",
      "microphone",
      "midi",
      "clipboard-read",
      "clipboard-write",
      "persistent-storage",
      "push",
      "screen-wake-lock",
      "accelerometer",
      "gyroscope",
      "magnetometer",
      "ambient-light-sensor",
      "bluetooth",
      "idle-detection",
      "payment-handler",
      "storage-access",
      "local-fonts",
      "window-management",
    ];
    const rows: string[] = [];
    let known = 0;
    for (const name of names) {
      try {
        const s = await perms.query({ name: name as PermissionName });
        rows.push(pad(name, s.state));
        known++;
      } catch (e) {
        // A rejection here means the build does not know the permission at all,
        // which is a genuine capability statement rather than an error.
        rows.push(pad(name, `unknown to this build (${(e as Error).name})`));
      }
    }
    return ok(
      `${known} of ${names.length} permission names recognised.`,
      lines(...rows, "", "Names this build does not recognise cannot be sampled, so probes gated on them", "report a less precise diagnosis."),
    );
  },
});

export const PLATFORM_PROBES: Probe[] = [
  userAgentData,
  permissionsApi,
  timerResolution,
  memory,
  battery,
  gamepad,
  locks,
  scheduler,
  speechSynthesis,
  speechRecognition,
  midi,
];

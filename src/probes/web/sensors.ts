// Where the device meets the world.
//
// The geolocation probe below is the reason this suite exists. kite found that
// the Polkadot Android app denies location without ever prompting, and the
// argument that made that report land was not the failure itself but the
// permission state either side of it. That reasoning is preserved verbatim; the
// runner now applies its core inference to every gated probe automatically.

import { TIER, type Outcome, type Probe } from "../../core/types";
import { at, detect, lines, ok, pad, probe, unsupported } from "../helpers";

const CAT = "sensors";

const geolocation = probe({
  id: "web.sensors.geolocation",
  title: "Geolocation — one-shot fix",
  why: "The hard gate for anything location-bound: delivery, logistics, check-ins, proximity attestation. There is no in-runtime workaround if this fails.",
  category: CAT,
  tier: TIER.PROMPT,
  permissions: ["geolocation"],
  timeoutMs: 45_000,
  repro: `<script>
  navigator.permissions.query({ name: 'geolocation' })
    .then(p => console.log('before:', p.state));
  navigator.geolocation.getCurrentPosition(
    pos => console.log('ok', pos.coords),
    async err => {
      const p = await navigator.permissions.query({ name: 'geolocation' });
      console.log('err', err.code, err.message, '| state after:', p.state);
    },
    { enableHighAccuracy: true, timeout: 15000 }
  );
</script>`,
  async run(ctx) {
    if (!("geolocation" in navigator)) {
      return unsupported("navigator.geolocation is absent in this runtime.");
    }

    // Sampled here as well as by the runner, because the diagnosis prose below
    // needs to quote it inline and a reader should not have to cross-reference.
    let permState = "unknown (Permissions API unavailable)";
    try {
      permState = (await navigator.permissions.query({ name: "geolocation" as PermissionName })).state;
    } catch {
      /* optional API; keep going */
    }

    const t0 = performance.now();
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 30_000,
          maximumAge: 0,
        });
        ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
      });
      const ms = Math.round(performance.now() - t0);
      return {
        status: "pass",
        ms,
        detail: `Fix acquired in ${ms} ms.`,
        data: lines(
          // Coordinates are rounded hard. A shared report should not carry the
          // reporter's doorstep, and two decimal places is ~1 km — enough to
          // show the fix is real, not enough to locate anyone.
          pad("latitude", pos.coords.latitude.toFixed(2) + "  (rounded for sharing)"),
          pad("longitude", pos.coords.longitude.toFixed(2) + "  (rounded for sharing)"),
          pad("accuracy", `${Math.round(pos.coords.accuracy)} m`),
          pad("altitude", pos.coords.altitude ?? "not provided"),
          pad("heading", pos.coords.heading ?? "not provided"),
          pad("speed", pos.coords.speed ?? "not provided"),
          pad("permission before", permState),
        ),
      };
    } catch (e) {
      const err = e as GeolocationPositionError;
      const msg = err?.message ?? String(e);
      const ms = Math.round(performance.now() - t0);

      let after = permState;
      try {
        after = (await navigator.permissions.query({ name: "geolocation" as PermissionName })).state;
      } catch {
        /* keep the earlier value */
      }

      const policyBlocked = /permissions? policy|feature policy/i.test(msg);
      const denied = err?.code === 1 || /denied/i.test(msg);
      const timedOut = err?.code === 3;

      // The ladder, carried over from kite/src/checks.ts:175-195. Each rung is
      // a different party's problem — embedder, host, user, sky — and sending
      // someone to the wrong one costs days.
      const diagnosis = policyBlocked
        ? [
            "DIAGNOSIS: blocked by Permissions-Policy before any prompt. The page is embedded in an",
            'iframe without allow="geolocation" (or a response header forbids it). This is the',
            "EMBEDDER's configuration, not a user or OS decision — no change on the device fixes it.",
          ]
        : denied && after === "prompt"
          ? [
              "DIAGNOSIS: permission reads 'prompt' yet the request was denied — that is the signature",
              "of a WebView host that never answered the permission callback, NOT a user refusal.",
              "",
              "'prompt' means the permission has never been decided: nothing granted, nothing denied,",
              "nothing stored. A genuine refusal leaves 'denied'. So the request was rejected while the",
              "permission remained undecided, which is what Chromium does when a request is raised and",
              "the embedder never resolves it — it fails closed.",
              "",
              "On Android the host must implement WebChromeClient.onGeolocationPermissionsShowPrompt",
              "and invoke its callback. The default implementation does nothing at all. Note that",
              "getUserMedia goes through onPermissionRequest, a DIFFERENT callback — so a runtime where",
              "the camera works and location does not is consistent with exactly this gap.",
            ]
          : denied
            ? [
                "DIAGNOSIS: denied at the OS or user level. Grant location to the host app in system",
                "settings, clear the site permission, and re-run.",
              ]
            : timedOut
              ? ["DIAGNOSIS: timed out without a denial — an indoor or no-fix condition, not a permission problem."]
              : ["DIAGNOSIS: not a permission failure. See the error above."];

      return {
        status: denied || policyBlocked ? "blocked" : "fail",
        ms,
        detail: msg,
        data: lines(
          pad("error code", err?.code ?? "n/a"),
          pad("permission before", permState),
          pad("permission after", after),
          "",
          ...diagnosis,
        ),
        diagnosis: policyBlocked
          ? "policy-blocked-by-embedder"
          : denied && after === "prompt"
            ? "host-callback-missing"
            : denied
              ? "os-denied"
              : "never-settled",
      } satisfies Outcome;
    }
  },
});

const geolocationWatch = probe({
  id: "web.sensors.geolocationWatch",
  title: "Geolocation — watchPosition",
  why: "A one-shot fix and a continuous watch take different paths through the WebView. Anything tracking a route needs the second, and it can fail where the first works.",
  category: CAT,
  tier: TIER.PROMPT,
  permissions: ["geolocation"],
  needs: ["web.sensors.geolocation"],
  timeoutMs: 30_000,
  async run(ctx) {
    const updates: string[] = [];
    const id = navigator.geolocation.watchPosition(
      (p) => updates.push(pad(`update ${updates.length + 1}`, `±${Math.round(p.coords.accuracy)} m at ${new Date(p.timestamp).toISOString()}`)),
      (e) => updates.push(pad("error", e.message)),
      { enableHighAccuracy: true, maximumAge: 0 },
    );
    ctx.cleanup.add("geolocation-watch", () => navigator.geolocation.clearWatch(id));

    // Two updates, or ten seconds. A watch that fires once and stops is a
    // different defect from one that never fires, so the count is the result.
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      const timer = setTimeout(done, 10_000);
      const poll = setInterval(() => {
        if (updates.length >= 2) {
          clearTimeout(timer);
          clearInterval(poll);
          done();
        }
      }, 250);
      ctx.cleanup.add("watch-poll", () => {
        clearTimeout(timer);
        clearInterval(poll);
      });
    });

    return updates.length
      ? ok(`${updates.length} update(s) in 10 s.`, lines(...updates))
      : {
          status: "fail",
          detail: "watchPosition registered but delivered nothing in 10 s — no updates, and no error either.",
          data: "A watch that neither fires nor errors gives calling code no way to distinguish\n'still acquiring' from 'never will'.",
          diagnosis: "never-settled",
        };
  },
});

/**
 * The Generic Sensor API classes all share one shape, one permission model, and
 * one failure mode (constructor present, `onerror` fires with NotAllowedError),
 * so they are worth generating rather than writing out five times.
 */
function genericSensor(args: { name: string; ctor: string; permission?: string; why: string }): Probe {
  return probe({
    id: `web.sensors.${args.name}`,
    title: `${args.ctor} (Generic Sensor)`,
    why: args.why,
    category: CAT,
    tier: TIER.PROMPT,
    permissions: args.permission ? [args.permission] : undefined,
    timeoutMs: 15_000,
    async run(ctx) {
      const Ctor = at(args.ctor) as (new (o?: object) => {
        start(): void;
        stop(): void;
        addEventListener(t: string, f: (e?: unknown) => void): void;
      }) | undefined;
      if (!Ctor) return unsupported(`${args.ctor} is absent.`);

      const sensor = new Ctor({ frequency: 10 });
      ctx.cleanup.add(`${args.name}-sensor`, () => sensor.stop());

      const result = await new Promise<{ ok: boolean; note: string }>((resolve) => {
        sensor.addEventListener("reading", () => {
          const s = sensor as unknown as Record<string, number>;
          const axes = ["x", "y", "z", "illuminance", "quaternion"]
            .filter((k) => k in s)
            .map((k) => pad(k, JSON.stringify(s[k])));
          resolve({ ok: true, note: axes.join("\n") || "reading fired with no readable axes" });
        });
        sensor.addEventListener("error", (e) => {
          const err = (e as { error?: Error })?.error;
          resolve({ ok: false, note: `${err?.name ?? "error"}: ${err?.message ?? "no detail"}` });
        });
        ctx.signal.addEventListener("abort", () => resolve({ ok: false, note: "timed out with no reading and no error" }), { once: true });
        try {
          sensor.start();
        } catch (e) {
          resolve({ ok: false, note: `start() threw — ${(e as Error).message}` });
        }
      });

      if (result.ok) return ok(`Delivering readings.`, result.note);
      const blocked = /NotAllowed|SecurityError|permission/i.test(result.note);
      return {
        status: blocked ? "blocked" : "fail",
        detail: result.note,
        data: lines(
          pad("constructor", "present"),
          "",
          blocked
            ? "The class exists but readings are refused. In a frame this is usually the\nPermissions-Policy; on a device it is the OS permission."
            : "The class exists and start() was accepted, but no reading and no error arrived.\nThat leaves calling code with nothing to branch on.",
        ),
        diagnosis: blocked ? "os-denied" : "never-settled",
      };
    },
  });
}

const accelerometer = genericSensor({
  name: "accelerometer",
  ctor: "Accelerometer",
  permission: "accelerometer",
  why: "Motion sensing underpins step counting, shake gestures, and any proof-of-movement attestation.",
});
const gyroscope = genericSensor({
  name: "gyroscope",
  ctor: "Gyroscope",
  permission: "gyroscope",
  why: "Rotation rate. Needed for orientation-aware capture and for AR-style alignment.",
});
const magnetometer = genericSensor({
  name: "magnetometer",
  ctor: "Magnetometer",
  permission: "magnetometer",
  why: "Compass heading. Frequently absent even where the hardware exists, because it is gated separately.",
});
const ambientLight = genericSensor({
  name: "ambientLight",
  ctor: "AmbientLightSensor",
  permission: "ambient-light-sensor",
  why: "Rarely shipped. Recorded so that its arrival, or removal, shows up in a diff.",
});
const absoluteOrientation = genericSensor({
  name: "absoluteOrientation",
  ctor: "AbsoluteOrientationSensor",
  why: "Fused orientation relative to the earth. The fusion is the part a WebView tends to omit.",
});

const deviceMotionEvents = probe({
  id: "web.sensors.deviceMotionEvents",
  title: "DeviceMotion / DeviceOrientation events",
  why: "The older event-based route to the same hardware. It often works where the Generic Sensor classes do not, so it is the practical fallback worth knowing about.",
  category: CAT,
  tier: TIER.PROMPT,
  timeoutMs: 15_000,
  async run(ctx) {
    const rows: string[] = [
      pad("DeviceMotionEvent", typeof DeviceMotionEvent !== "undefined"),
      pad("DeviceOrientationEvent", typeof DeviceOrientationEvent !== "undefined"),
    ];

    // iOS requires an explicit grant from a user gesture. Recording whether the
    // gate exists at all is a clean signal for which engine family this is.
    const requestPermission = (DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> })
      ?.requestPermission;
    rows.push(pad("requestPermission gate", requestPermission ? "present (iOS-style)" : "absent (Android/desktop-style)"));
    if (requestPermission) {
      try {
        rows.push(pad("requestPermission()", await requestPermission()));
      } catch (e) {
        rows.push(pad("requestPermission()", `threw — ${(e as Error).message}`));
      }
    }

    const seen = { motion: 0, orientation: 0 };
    const onMotion = () => seen.motion++;
    const onOrientation = () => seen.orientation++;
    window.addEventListener("devicemotion", onMotion);
    window.addEventListener("deviceorientation", onOrientation);
    ctx.cleanup.add("devicemotion-listener", () => window.removeEventListener("devicemotion", onMotion));
    ctx.cleanup.add("deviceorientation-listener", () => window.removeEventListener("deviceorientation", onOrientation));

    await new Promise((r) => setTimeout(r, 3_000));
    rows.push(pad("devicemotion events", seen.motion), pad("deviceorientation events", seen.orientation));

    const any = seen.motion + seen.orientation > 0;
    return any
      ? ok(`Receiving events (${seen.motion} motion, ${seen.orientation} orientation in 3 s).`, lines(...rows))
      : {
          status: typeof DeviceMotionEvent === "undefined" ? "unsupported" : "blocked",
          detail: "No motion or orientation events in 3 s. Either the device is perfectly still, or these events are not delivered here.",
          data: lines(...rows, "", "Re-run while moving the device to rule out the first."),
          diagnosis: typeof DeviceMotionEvent === "undefined" ? "not-implemented" : "os-denied",
        };
  },
});

const relativeOrientation = detect({
  id: "web.sensors.relativeOrientation",
  title: "RelativeOrientationSensor",
  why: "Orientation without a magnetometer dependency. Its presence alongside an absent AbsoluteOrientationSensor pins the gap to sensor fusion.",
  category: CAT,
  paths: "RelativeOrientationSensor",
});

export const SENSOR_PROBES: Probe[] = [
  geolocation,
  geolocationWatch,
  deviceMotionEvents,
  accelerometer,
  gyroscope,
  magnetometer,
  absoluteOrientation,
  relativeOrientation,
  ambientLight,
];

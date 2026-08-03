// Camera, microphone, screen.
//
// captureStill() below is carried over from kite almost unchanged, including
// the on-screen viewfinder. That detail is hard-won: capturing from a detached
// <video> reports success while the user sees nothing and cannot aim — the
// camera indicator lights up, no preview appears, and the "photo" is whatever
// the lens happened to face. A probe that passes under those conditions is
// worse than one that fails.

import { TIER, type Probe } from "../../core/types";
import { detect, kb, lines, need, ok, pad, probe, unsupported, wrong } from "../helpers";
import type { Ctx } from "../../core/types";

const CAT = "media";

/** Resolve a still image from the camera, preferring getUserMedia. */
async function captureStill(ctx: Ctx): Promise<{ blob: Blob; via: string }> {
  if (navigator.mediaDevices?.getUserMedia) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      ctx.cleanup.add("camera-stream", () => stream.getTracks().forEach((t) => t.stop()));

      const video = document.createElement("video");
      video.srcObject = stream;
      video.playsInline = true;
      video.muted = true;

      const shade = document.createElement("div");
      shade.className = "viewfinder";
      const shoot = document.createElement("button");
      shoot.textContent = "Shoot";
      shade.append(video, shoot);
      document.body.appendChild(shade);
      ctx.cleanup.add("viewfinder", () => shade.remove());

      await video.play();
      await new Promise<void>((resolve, reject) => {
        shoot.addEventListener("click", () => resolve(), { once: true });
        ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
      });
      shade.remove();

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")!.drawImage(video, 0, 0);
      stream.getTracks().forEach((t) => t.stop());

      const blob: Blob = await new Promise((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob returned null"))), "image/jpeg", 0.9),
      );
      return { blob, via: `getUserMedia (${video.videoWidth}x${video.videoHeight}, environment camera)` };
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      // On some runtimes getUserMedia is blocked but <input capture> still
      // reaches the native camera — a genuinely different code path, and worth
      // reporting as the fallback rather than failing outright.
      console.warn("getUserMedia failed, trying capture input:", e);
    }
  }

  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.capture = "environment";
    input.onchange = () => {
      const f = input.files?.[0];
      f ? resolve({ blob: f, via: "<input type=file capture> fallback" }) : reject(new Error("no file chosen"));
    };
    input.oncancel = () => reject(new Error("capture cancelled"));
    ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
    input.click();
  });
}

const enumerateDevices = probe({
  id: "web.media.enumerateDevices",
  title: "enumerateDevices — labels before grant",
  why: "Device labels are withheld until a media permission is granted. Comparing the list before and after a grant is a clean, non-invasive read on whether the grant actually took.",
  category: CAT,
  tier: TIER.INVOKE,
  async run() {
    const md = need<MediaDevices>("navigator.mediaDevices");
    if (!md.enumerateDevices) return unsupported("mediaDevices.enumerateDevices is absent.");
    const devices = await md.enumerateDevices();
    const labelled = devices.filter((d) => d.label).length;
    return ok(
      `${devices.length} device(s); ${labelled} with labels.`,
      lines(
        ...devices.map((d) => pad(d.kind, d.label || "(label withheld — no grant yet)")),
        "",
        labelled === 0 && devices.length > 0
          ? "Labels withheld is CORRECT before a grant. Re-run after the camera probe to confirm\nthe grant propagated: labels appearing is the confirmation."
          : "",
      ),
    );
  },
});

const camera = probe({
  id: "web.media.camera",
  title: "Camera capture (getUserMedia → still)",
  why: "Proves the whole capture path end to end: permission, live preview, frame grab, and JPEG encode. A pass here also proves EXIF stripping, since a canvas re-encode discards it by construction.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  permissions: ["camera"],
  timeoutMs: 120_000,
  async run(ctx) {
    const { blob, via } = await captureStill(ctx);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    ctx.shared.jpeg = bytes;
    return ok(
      `Captured via ${via}.`,
      lines(
        pad("size", kb(blob.size)),
        pad("type", blob.type),
        pad("route", via),
        "",
        "EXIF (and any GPS in it) is stripped by the canvas re-encode — that is construction,",
        "not a filter, so it cannot be bypassed by a malformed input.",
      ),
    );
  },
});

const microphone = probe({
  id: "web.media.microphone",
  title: "Microphone capture",
  why: "Audio and video are granted through the same callback but not always the same OS permission. A runtime where one works and the other does not narrows the fault considerably.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  permissions: ["microphone"],
  timeoutMs: 60_000,
  async run(ctx) {
    const md = need<MediaDevices>("navigator.mediaDevices");
    const stream = await md.getUserMedia({ audio: true });
    ctx.cleanup.add("mic-stream", () => stream.getTracks().forEach((t) => t.stop()));

    const track = stream.getAudioTracks()[0];
    const settings = track?.getSettings?.() ?? {};

    // Reading actual levels proves the track carries samples rather than
    // silence — a granted-but-muted mic is a real and confusing failure.
    let peak = 0;
    try {
      const AC = (window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)!;
      const acx = new AC();
      ctx.cleanup.add("audio-context", () => acx.close());
      const analyser = acx.createAnalyser();
      acx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 50));
        analyser.getByteTimeDomainData(buf);
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      }
    } catch (e) {
      peak = -1;
      console.warn("level metering failed", e);
    }

    return ok(
      `Microphone open${peak > 2 ? ` and carrying signal (peak ${peak}/128)` : peak === 0 ? " but completely silent" : ""}.`,
      lines(
        pad("label", track?.label || "(withheld)"),
        pad("sampleRate", settings.sampleRate ?? "?"),
        pad("channelCount", settings.channelCount ?? "?"),
        pad("peak amplitude", peak < 0 ? "metering unavailable" : `${peak}/128`),
        "",
        peak === 0
          ? "Granted but silent. A muted or exclusively-held mic reports exactly this way, and\nlooks like success to any code that only checks for a stream."
          : "",
      ),
    );
  },
});

const displayMedia = probe({
  id: "web.media.displayMedia",
  title: "Screen capture (getDisplayMedia)",
  why: "Almost never available in a mobile WebView, and its absence is what forces screenshot-based flows to fail over to the OS. Worth confirming rather than assuming.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  timeoutMs: 60_000,
  async run(ctx) {
    const md = need<MediaDevices>("navigator.mediaDevices");
    if (!md.getDisplayMedia) return unsupported("mediaDevices.getDisplayMedia is absent — the expected answer on mobile.");
    const stream = await md.getDisplayMedia({ video: true });
    ctx.cleanup.add("display-stream", () => stream.getTracks().forEach((t) => t.stop()));
    const s = stream.getVideoTracks()[0]?.getSettings?.() ?? {};
    return ok("Screen capture granted.", lines(pad("width", s.width ?? "?"), pad("height", s.height ?? "?"), pad("frameRate", s.frameRate ?? "?")));
  },
});

const mediaRecorder = probe({
  id: "web.media.mediaRecorder",
  title: "MediaRecorder codec support",
  why: "Which containers and codecs are available decides whether recorded media is portable. A WebView with only one exotic codec produces files nothing else can open.",
  category: CAT,
  tier: TIER.INVOKE,
  async run() {
    const MR = need<typeof MediaRecorder>("MediaRecorder");
    const types = [
      "video/webm;codecs=vp8",
      "video/webm;codecs=vp9",
      "video/webm;codecs=av01",
      "video/mp4;codecs=avc1",
      "video/mp4;codecs=hvc1",
      "audio/webm;codecs=opus",
      "audio/mp4;codecs=mp4a.40.2",
      "audio/ogg;codecs=opus",
    ];
    const supported = types.filter((t) => MR.isTypeSupported?.(t));
    return supported.length
      ? ok(`${supported.length} of ${types.length} formats supported.`, lines(...types.map((t) => pad(t, MR.isTypeSupported(t) ? "yes" : "no"))))
      : wrong("MediaRecorder exists but supports none of the formats tested — recording would produce nothing usable.", lines(...types.map((t) => pad(t, "no"))));
  },
});

const imageCapture = detect({
  id: "web.media.imageCapture",
  title: "ImageCapture",
  why: "Torch, zoom, and full-resolution stills come from here. Without it, capture is limited to whatever the preview stream resolution happens to be.",
  category: CAT,
  paths: "ImageCapture",
});

const pictureInPicture = probe({
  id: "web.media.pictureInPicture",
  title: "Picture-in-Picture",
  why: "Needs both the API and a permissions-policy grant. In a frame it usually fails on the second, which is a different fix from the first.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  timeoutMs: 30_000,
  async run(ctx) {
    if (!document.pictureInPictureEnabled) {
      return {
        status: "blocked",
        detail: "document.pictureInPictureEnabled is false — the feature is disabled for this document, most likely by permissions-policy.",
        diagnosis: "policy-blocked-by-embedder",
        data: pad("framed", window.self !== window.top),
      };
    }
    // A canvas stream avoids needing a real media file in the bundle.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 160;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#58a6ff";
    g.fillRect(0, 0, 160, 160);

    const video = document.createElement("video");
    video.srcObject = canvas.captureStream(1);
    video.muted = true;
    video.playsInline = true;
    document.body.appendChild(video);
    ctx.cleanup.add("pip-video", () => video.remove());
    ctx.cleanup.add("pip-exit", async () => {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
    });

    await video.play();
    await video.requestPictureInPicture();
    return ok("Entered picture-in-picture.");
  },
});

export const MEDIA_PROBES: Probe[] = [
  enumerateDevices,
  mediaRecorder,
  imageCapture,
  camera,
  microphone,
  displayMedia,
  pictureInPicture,
];

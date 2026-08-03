// Rendering and codecs.
//
// The WebGPU probes carry crashRisk: "high" and sit at the end of the manifest.
// A GPU-process crash takes the page with it, which is precisely why the
// journal writes `begin` before invoking — a crash here produces the line
// "crashed at web.graphics.webgpu.device" instead of a blank screen.

import { TIER, type Probe } from "../../core/types";
import { detect, lines, ok, pad, probe, unsupported, wrong } from "../helpers";

const CAT = "graphics";

const canvas2d = probe({
  id: "web.graphics.canvas2d",
  title: "Canvas 2D + readback",
  why: "The camera probe re-encodes through a canvas to strip EXIF. If readback is blocked — as anti-fingerprinting measures sometimes do — that privacy step silently stops working.",
  category: CAT,
  tier: TIER.INVOKE,
  async run() {
    const c = document.createElement("canvas");
    c.width = c.height = 8;
    const g = c.getContext("2d");
    if (!g) return unsupported("getContext('2d') returned null.");

    g.fillStyle = "#ff8000";
    g.fillRect(0, 0, 8, 8);
    const px = g.getImageData(0, 0, 1, 1).data;

    // Some privacy modes return a slightly perturbed image rather than
    // refusing, which is far harder to notice than an outright block.
    const exact = px[0] === 255 && px[1] === 128 && px[2] === 0;
    const near = Math.abs(px[0] - 255) < 8 && Math.abs(px[1] - 128) < 8 && Math.abs(px[2]) < 8;

    let dataUrlOk = false;
    try {
      dataUrlOk = c.toDataURL("image/png").startsWith("data:image/png");
    } catch {
      /* SecurityError when the canvas is considered tainted */
    }

    const evidence = lines(
      pad("wrote", "rgb(255, 128, 0)"),
      pad("read back", `rgb(${px[0]}, ${px[1]}, ${px[2]})`),
      pad("toDataURL", dataUrlOk ? "ok" : "blocked or threw"),
    );

    if (exact && dataUrlOk) return ok("Pixels read back exactly, and export works.", evidence);
    if (near) {
      return wrong(
        "Pixels come back perturbed — canvas readback is being noised for anti-fingerprinting. Any pixel-exact operation is unreliable here.",
        evidence,
      );
    }
    return wrong("Canvas readback does not return what was drawn.", evidence);
  },
});

const webgl = probe({
  id: "web.graphics.webgl",
  title: "WebGL 1 + 2",
  why: "Reports the actual GPU and driver. When a rendering bug is device-specific, this string is the first thing anyone asks for.",
  category: CAT,
  tier: TIER.INVOKE,
  async run(ctx) {
    const c = document.createElement("canvas");
    const rows: string[] = [];
    let best: WebGLRenderingContext | null = null;

    for (const name of ["webgl2", "webgl", "experimental-webgl"]) {
      const gl = c.getContext(name) as WebGLRenderingContext | null;
      rows.push(pad(name, gl ? "available" : "null"));
      if (gl && !best) best = gl;
    }
    if (!best) return unsupported("No WebGL context of any version could be created.", lines(...rows));

    ctx.cleanup.add("webgl-context", () => best!.getExtension("WEBGL_lose_context")?.loseContext());

    const dbg = best.getExtension("WEBGL_debug_renderer_info");
    rows.push(
      "",
      pad("VENDOR", best.getParameter(best.VENDOR)),
      pad("RENDERER", best.getParameter(best.RENDERER)),
      pad("VERSION", best.getParameter(best.VERSION)),
      pad("SHADING_LANGUAGE", best.getParameter(best.SHADING_LANGUAGE_VERSION)),
      // Masked unless the debug extension is present — its absence is itself
      // informative, since it means the real GPU cannot be named in a report.
      pad("UNMASKED_RENDERER", dbg ? best.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "masked (no debug_renderer_info)"),
      pad("MAX_TEXTURE_SIZE", best.getParameter(best.MAX_TEXTURE_SIZE)),
      pad("extensions", best.getSupportedExtensions()?.length ?? 0),
    );

    return ok(`${best.getParameter(best.VERSION)}`, lines(...rows));
  },
});

const webgpu = probe({
  id: "web.graphics.webgpu",
  title: "WebGPU adapter + device",
  why: "The newest and least stable surface here. Requesting a device is the single most likely thing in this suite to take the renderer down, which is why the journal exists.",
  category: CAT,
  tier: TIER.INVOKE,
  crashRisk: "high",
  timeoutMs: 30_000,
  async run(ctx) {
    const gpu = (navigator as { gpu?: { requestAdapter(o?: object): Promise<unknown>; getPreferredCanvasFormat?(): string } }).gpu;
    if (!gpu) return unsupported("navigator.gpu is absent.");

    const adapter = (await gpu.requestAdapter()) as
      | { features: Set<string>; limits: Record<string, number>; info?: Record<string, string>; requestDevice(): Promise<{ destroy(): void; lost: Promise<{ reason: string }> }> }
      | null;
    if (!adapter) {
      return {
        status: "blocked",
        detail: "navigator.gpu exists but requestAdapter() returned null — no compatible adapter, or WebGPU is disabled by policy.",
        diagnosis: "os-denied",
        data: pad("getPreferredCanvasFormat", gpu.getPreferredCanvasFormat?.() ?? "n/a"),
      };
    }

    const device = await adapter.requestDevice();
    ctx.cleanup.add("webgpu-device", () => device.destroy());

    // Device loss is asynchronous and does not throw. Without watching for it,
    // a lost device looks exactly like a working one.
    let lost: string | null = null;
    void device.lost.then((info) => {
      lost = info.reason;
    });
    await new Promise((r) => setTimeout(r, 300));

    const feats = [...(adapter.features ?? [])].slice(0, 12);
    return lost
      ? wrong(`Device was acquired and then lost: ${lost}.`, "A device that dies immediately after creation is the WebGPU failure most likely\nto be mistaken for a working one.")
      : ok(
          "Adapter and device acquired.",
          lines(
            pad("vendor", adapter.info?.vendor ?? "not exposed"),
            pad("architecture", adapter.info?.architecture ?? "not exposed"),
            pad("features", feats.join(", ") || "none"),
            pad("maxBufferSize", adapter.limits?.maxBufferSize ?? "?"),
            pad("preferred format", gpu.getPreferredCanvasFormat?.() ?? "n/a"),
          ),
        );
  },
});

const offscreenCanvas = probe({
  id: "web.graphics.offscreenCanvas",
  title: "OffscreenCanvas in a worker",
  why: "The only way to render without blocking input. Present on the main thread but broken in a worker is a real and commonly-shipped combination.",
  category: CAT,
  tier: TIER.INVOKE,
  timeoutMs: 20_000,
  async run(ctx) {
    if (typeof OffscreenCanvas === "undefined") return unsupported("OffscreenCanvas is absent.");

    const src = `
      self.onmessage = async (e) => {
        try {
          const g = e.data.canvas.getContext('2d');
          if (!g) return self.postMessage({ ok: false, why: 'no 2d context in worker' });
          g.fillStyle = '#00ff00'; g.fillRect(0, 0, 4, 4);
          const px = g.getImageData(0, 0, 1, 1).data;
          self.postMessage({ ok: px[1] === 255, px: [...px] });
        } catch (err) { self.postMessage({ ok: false, why: String(err) }); }
      };`;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    ctx.cleanup.add("offscreen-worker-url", () => URL.revokeObjectURL(url));
    const w = new Worker(url);
    ctx.cleanup.add("offscreen-worker", () => w.terminate());

    const canvas = new OffscreenCanvas(4, 4);
    const reply = await new Promise<{ ok: boolean; why?: string; px?: number[] }>((resolve, reject) => {
      w.onmessage = (e) => resolve(e.data);
      w.onerror = (e) => reject(new Error(e.message || "worker error"));
      ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
      w.postMessage({ canvas }, [canvas as unknown as Transferable]);
    });

    return reply.ok
      ? ok("Transferred a canvas to a worker and rendered there.", pad("pixel", JSON.stringify(reply.px)))
      : wrong(`Rendering in a worker failed: ${reply.why ?? "unknown"}.`);
  },
});

const webCodecs = probe({
  id: "web.graphics.webCodecs",
  title: "WebCodecs configuration support",
  why: "Hardware-accelerated encode/decode. Which codecs are configurable decides whether media processing is viable on-device or has to go to a server.",
  category: CAT,
  tier: TIER.INVOKE,
  timeoutMs: 25_000,
  async run() {
    const VD = (globalThis as { VideoDecoder?: { isConfigSupported(c: object): Promise<{ supported?: boolean }> } }).VideoDecoder;
    const VE = (globalThis as { VideoEncoder?: { isConfigSupported(c: object): Promise<{ supported?: boolean }> } }).VideoEncoder;
    if (!VD && !VE) return unsupported("Neither VideoDecoder nor VideoEncoder is present.");

    const rows: string[] = [];
    const codecs = ["avc1.42E01E", "vp8", "vp09.00.10.08", "av01.0.04M.08", "hvc1.1.6.L93.B0"];
    for (const codec of codecs) {
      if (VD) {
        try {
          const r = await VD.isConfigSupported({ codec, codedWidth: 640, codedHeight: 480 });
          rows.push(pad(`decode ${codec}`, r.supported ? "yes" : "no"));
        } catch (e) {
          rows.push(pad(`decode ${codec}`, `threw — ${(e as Error).message}`));
        }
      }
      if (VE) {
        try {
          const r = await VE.isConfigSupported({ codec, width: 640, height: 480, bitrate: 1e6 });
          rows.push(pad(`encode ${codec}`, r.supported ? "yes" : "no"));
        } catch (e) {
          rows.push(pad(`encode ${codec}`, `threw — ${(e as Error).message}`));
        }
      }
    }
    return ok(`${rows.filter((r) => r.endsWith("yes")).length} of ${rows.length} configurations supported.`, lines(...rows));
  },
});

const imageFormats = probe({
  id: "web.graphics.imageFormats",
  title: "Image format decoding",
  why: "A format the engine cannot decode makes any image using it silently blank. AVIF in particular is inconsistent across WebView builds.",
  category: CAT,
  tier: TIER.INVOKE,
  timeoutMs: 20_000,
  async run() {
    // Each is a minimal valid image of its format, inline so the probe needs no
    // network and works from a bundle with no origin.
    const samples: Record<string, string> = {
      png: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      webp: "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==",
      avif: "data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAAB0AAABCaWluZgAAAAAAAQAAABphdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAIAAAACAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQ0MAAAAABNjb2xybmNseAACAAIAAYAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAACVtZGF0EgAKCBgANogQEAwgMg8f8D///8WfhwB8+ErK42A=",
      gif: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      jpeg: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
    };

    const decode = (src: string) =>
      new Promise<boolean>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img.width > 0);
        img.onerror = () => resolve(false);
        img.src = src;
        setTimeout(() => resolve(false), 3_000);
      });

    const rows: string[] = [];
    const failed: string[] = [];
    for (const [name, src] of Object.entries(samples)) {
      const okd = await decode(src);
      rows.push(pad(name, okd ? "decodes" : "FAILS"));
      if (!okd) failed.push(name);
    }

    const core = failed.filter((f) => ["png", "jpeg", "gif"].includes(f));
    return {
      status: core.length ? "fail" : failed.length ? "unsupported" : "pass",
      detail: core.length
        ? `A core format does not decode (${core.join(", ")}) — this engine is broken in a basic way.`
        : failed.length
          ? `Modern format(s) unavailable: ${failed.join(", ")}. Images using them render blank with no error.`
          : "Every format tested decodes, including AVIF.",
      data: lines(...rows),
      diagnosis: failed.length ? "not-implemented" : undefined,
    };
  },
});

const webrtc = probe({
  id: "web.graphics.webrtc",
  title: "WebRTC peer connection",
  why: "The host declares a WebRtc remote permission, so a gap between the host offering it and the WebView supporting it is exactly the kind of seam worth testing.",
  category: CAT,
  tier: TIER.INVOKE,
  timeoutMs: 25_000,
  async run(ctx) {
    const PC = (globalThis as { RTCPeerConnection?: new (c?: object) => RTCPeerConnection }).RTCPeerConnection;
    if (!PC) return unsupported("RTCPeerConnection is absent.");

    const pc = new PC({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    ctx.cleanup.add("rtc-peer-connection", () => pc.close());

    pc.createDataChannel("sonde");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Candidate gathering is what actually needs the network; creating an offer
    // alone proves only that the API exists.
    const candidates: string[] = [];
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      pc.onicecandidate = (e) => {
        if (!e.candidate) return done();
        candidates.push(e.candidate.candidate.split(" ").slice(4, 8).join(" "));
      };
      setTimeout(done, 6_000);
      ctx.signal.addEventListener("abort", done, { once: true });
    });

    const types = new Set(candidates.map((c) => (/typ (\w+)/.exec(c)?.[1] ?? "?")));
    return candidates.length
      ? ok(
          `Gathered ${candidates.length} ICE candidate(s).`,
          lines(pad("candidate types", [...types].join(", ")), pad("SDP length", offer.sdp?.length ?? 0)),
        )
      : {
          status: "blocked",
          detail: "An offer was created but no ICE candidates were gathered — STUN is unreachable, so no peer connection could be established.",
          data: pad("SDP length", offer.sdp?.length ?? 0),
          diagnosis: "policy-blocked-by-embedder",
        };
  },
});

const webAudio = detect({
  id: "web.graphics.webAudio",
  title: "Web Audio",
  why: "Needed for the microphone probe's level metering, and the usual route to any audible feedback.",
  category: CAT,
  paths: ["AudioContext"],
});

export const GRAPHICS_PROBES: Probe[] = [
  canvas2d,
  imageFormats,
  webAudio,
  webgl,
  offscreenCanvas,
  webCodecs,
  webrtc,
  // Last on purpose: this is the probe most likely to take the page with it.
  webgpu,
];

// Web platform limits inside the app, measured by hitting them.
//
// Added 2026-09-19. Each answers a question a Product in this repo's family is
// designing around: whether a WebRTC data channel really opens in the app's WebView
// and how small its signalling can be (FARE's calls over the Statement Store),
// whether QR codes decode natively (FARE's GPS-free handoff), how much text the
// clipboard carries (almanac's backups leave the app only that way), how long a
// real Groth16 proof takes on the phone, and what backgrounding the app does to a
// Product's timers and connections.

import { getStatementStore } from "@parity/product-sdk-host";
import encodeQR from "qr";
import { TIER, type Probe } from "../../core/types";
import { lines, need, ok, pad, probe, unsupported, within, wrong } from "../helpers";

const lim = (p: Omit<Probe, "bank" | "category">): Probe => probe({ ...p, category: "limits" });
const MiB = 1024 * 1024;
const until = <T>(signal: AbortSignal, ms: number, fn: () => Promise<T>) => within(signal, ms, "", fn);

// -- WebRTC, one phone ------------------------------------------------------------

function gathered(pc: RTCPeerConnection, ms: number): Promise<boolean> {
  if (pc.iceGatheringState === "complete") return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(t);
        resolve(true);
      }
    });
  });
}

/** What a non-trickle offer must carry for a peer running the same app to rebuild it. */
function essentials(sdp: string): string {
  return sdp
    .split(/\r?\n/)
    .filter((l) => /^a=(ice-ufrag|ice-pwd|fingerprint|candidate):/.test(l))
    .join("\n");
}

const webrtcLoopback = lim({
  id: "web.limits.webrtcLoopback",
  title: "WebRTC data channel — open, throughput, signalling size",
  why: "Calls and live data between two phones can run over WebRTC, signalled through 512-byte statements. This connects two peer connections inside the page: does a data channel actually open in the app's WebView, how fast is it, and how many bytes does a non-trickle offer need once cut to its essentials?",
  tier: TIER.INVOKE,
  timeoutMs: 60_000,
  async run(ctx) {
    need("RTCPeerConnection");
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    ctx.cleanup.add("rtc-a", () => a.close());
    ctx.cleanup.add("rtc-b", () => b.close());
    const t0 = performance.now();
    const channel = a.createDataChannel("sonde", { ordered: true });
    const incoming = new Promise<RTCDataChannel>((resolve) => (b.ondatachannel = (e) => {
      e.channel.binaryType = "arraybuffer"; // before the first message can arrive
      resolve(e.channel);
    }));

    await a.setLocalDescription(await a.createOffer());
    const aDone = await gathered(a, 10_000);
    const offer = a.localDescription!.sdp;
    await b.setRemoteDescription(a.localDescription!);
    await b.setLocalDescription(await b.createAnswer());
    await gathered(b, 10_000);
    await a.setRemoteDescription(b.localDescription!);

    const opened = await until(ctx.signal, 15_000, () => new Promise<void>((r) => (channel.readyState === "open" ? r() : (channel.onopen = () => r()))));
    const rows = [
      pad("offer SDP", `${offer.length} B (${aDone ? "gathering complete" : "gathering did NOT complete in 10 s"})`),
      pad("essentials only", `${essentials(offer).length} B — ufrag, pwd, fingerprint, candidates`),
      pad("candidates", (offer.match(/a=candidate:/g) ?? []).length),
    ];
    const measures: Record<string, number | string | boolean> = {
      offerSdpBytes: offer.length,
      essentialBytes: essentials(offer).length,
      candidates: (offer.match(/a=candidate:/g) ?? []).length,
    };
    if (!opened.ok) {
      rows.push(pad("data channel", `did not open in 15 s (ICE ${a.iceConnectionState})`));
      return { ...wrong("Peer connections negotiated, but the data channel never opened.", lines(...rows)), measures: { ...measures, opened: false } };
    }
    const openMs = Math.round(performance.now() - t0);
    rows.push(pad("data channel", `open after ${openMs} ms`));

    // 1 MiB in 16 KiB messages, respecting the send buffer.
    const recv = await incoming;
    let got = 0;
    const done = new Promise<number>((r) => (recv.onmessage = (e) => (got += (e.data as ArrayBuffer).byteLength) >= MiB && r(performance.now())));
    const chunk = new Uint8Array(16 * 1024);
    const s0 = performance.now();
    for (let sent = 0; sent < MiB; sent += chunk.length) {
      if (channel.bufferedAmount > 4 * MiB) await new Promise((r) => setTimeout(r, 5));
      channel.send(chunk);
    }
    const fin = await until(ctx.signal, 20_000, () => done);
    const secs = fin.ok ? (fin.value - s0) / 1000 : NaN;
    rows.push(pad("1 MiB transfer", fin.ok ? `${(secs * 1000).toFixed(0)} ms — ${(1 / secs).toFixed(1)} MiB/s` : `only ${got} B arrived in 20 s`));
    return {
      ...(fin.ok ? ok(`Data channel opened in ${openMs} ms and moved 1 MiB at ${(1 / secs).toFixed(1)} MiB/s. A non-trickle offer's essentials are ${measures.essentialBytes} B.`, lines(...rows)) : wrong("The channel opened but did not carry 1 MiB.", lines(...rows))),
      measures: { ...measures, opened: true, openMs, mibPerSec: fin.ok ? Number((1 / secs).toFixed(2)) : 0 },
    };
  },
});

// -- QR decoding ------------------------------------------------------------------

const barcodeDetector = probe({
  id: "web.media.barcodeDetector",
  title: "BarcodeDetector — decode a QR code natively",
  why: "GPS-free handoffs and device pairing pass data between phones as QR codes. A built-in decoder saves ~60 KiB of JavaScript; without one, the Product must ship its own. This draws a known QR code on a canvas and decodes it.",
  category: "media",
  tier: TIER.INVOKE,
  timeoutMs: 20_000,
  async run() {
    const BD = (globalThis as { BarcodeDetector?: { new (o?: { formats: string[] }): { detect(s: CanvasImageSource): Promise<{ rawValue: string }[]> }; getSupportedFormats?(): Promise<string[]> } }).BarcodeDetector;
    if (!BD) return unsupported("BarcodeDetector is absent — a Product must ship its own QR reader (the qr package's decoder is ~62 KiB).");
    const formats = (await BD.getSupportedFormats?.()) ?? [];
    if (!formats.includes("qr_code")) return unsupported(`BarcodeDetector exists but lists no qr_code format (${formats.join(", ") || "none"}).`);

    const text = `sonde:${crypto.randomUUID()}`;
    const modules = encodeQR(text, "raw");
    const scale = 8;
    const quiet = 4;
    const size = (modules.length + quiet * 2) * scale;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, size, size);
    g.fillStyle = "#000";
    modules.forEach((row, y) => row.forEach((on, x) => on && g.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale)));

    const t0 = performance.now();
    const found = await new BD({ formats: ["qr_code"] }).detect(canvas);
    const ms = Math.round(performance.now() - t0);
    const right = found.some((f) => f.rawValue === text);
    const rows = [pad("formats", formats.join(", ")), pad("decode", `${ms} ms, ${found.length} code(s)`), pad("matches", right)];
    return {
      ...(right ? ok(`Decoded a QR code in ${ms} ms; ${formats.length} formats supported.`, lines(...rows)) : wrong("BarcodeDetector ran but did not return the encoded text.", lines(...rows))),
      measures: { decodeMs: ms, formats: formats.length, decoded: right },
    };
  },
});

// -- clipboard -----------------------------------------------------------------

const clipboardSize = lim({
  id: "web.limits.clipboardSize",
  title: "Clipboard — how much text can be copied",
  why: "Nothing leaves the app as a file (almanac P4), so backups and exports leave as copied text. This writes 100 KB, 1 MB and 5 MB in turn. Reading back is blocked in the app, so paste into another app to confirm the last one arrived whole.",
  tier: TIER.PROMPT,
  gesture: true,
  timeoutMs: 60_000,
  async run(ctx) {
    const clipboard = need<Clipboard>("navigator.clipboard");
    const rows: string[] = [];
    let largest = 0;
    for (const n of [100_000, 1_000_000, 5_000_000]) {
      const text = `sonde clipboard ${n} `.padEnd(n - 4, "x") + " end";
      try {
        const w = await until(ctx.signal, 15_000, () => clipboard.writeText(text));
        rows.push(pad(`${n / 1000} KB`, w.ok ? `written in ${w.ms} ms` : "no answer in 15 s"));
        if (!w.ok) break;
        largest = n;
      } catch (e) {
        rows.push(pad(`${n / 1000} KB`, `refused — ${(e as Error).message}`));
        break;
      }
    }
    return {
      ...(largest ? ok(`The clipboard accepted ${largest / 1000} KB. The clipboard now holds it: paste into Notes to check it ends in "end".`, lines(...rows)) : wrong("Even 100 KB was refused.", lines(...rows))),
      measures: { largestAcceptedBytes: largest },
    };
  },
});

// -- zero-knowledge proving -------------------------------------------------------

const groth16 = lim({
  id: "web.limits.groth16",
  title: "Groth16 proof on the phone (a real proximity circuit)",
  why: "Whether a Product can prove on the device decides its privacy design. This runs a real delivery-proximity circuit (2.1 MB wasm, 0.8 MB key) with a fixed example input, then verifies the proof. It took 420 ms on a desktop.",
  tier: TIER.INVOKE,
  optIn: "slow",
  timeoutMs: 300_000,
  async run() {
    const base = new URL("zk/", document.baseURI);
    const l0 = performance.now();
    const [snarkjs, input, vkey] = await Promise.all([
      import("snarkjs"),
      fetch(new URL("proximity-input.json", base)).then((r) => r.json()),
      fetch(new URL("proximity-vkey.json", base)).then((r) => r.json()),
    ]);
    const loadMs = Math.round(performance.now() - l0);
    const p0 = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, new URL("proximity.wasm", base).href, new URL("proximity.zkey", base).href);
    const proveMs = Math.round(performance.now() - p0);
    const v0 = performance.now();
    const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    const verifyMs = Math.round(performance.now() - v0);
    const rows = [pad("load snarkjs + input", `${loadMs} ms`), pad("prove", `${proveMs} ms`), pad("verify", `${verifyMs} ms, ${valid ? "valid" : "INVALID"}`), pad("desktop, for scale", "420 ms to prove")];
    return {
      ...(valid ? ok(`Proved in ${proveMs} ms and verified in ${verifyMs} ms on the device.`, lines(...rows)) : wrong("The proof did not verify.", lines(...rows))),
      measures: { proveMs, verifyMs, loadMs },
    };
  },
});

// -- memory -------------------------------------------------------------------

const wasmMemory = lim({
  id: "web.limits.wasmMemory",
  title: "WebAssembly memory — how far it grows",
  why: "Provers and some crypto libraries allocate large WASM heaps. This grows one WebAssembly.Memory 64 MiB at a time up to 4 GiB and records where growth is refused. It may take the page down, so it runs only when opted in, last.",
  tier: TIER.INVOKE,
  optIn: "crash-risk",
  crashRisk: "high",
  timeoutMs: 120_000,
  async run() {
    const mem = new WebAssembly.Memory({ initial: 1, maximum: 65_536 });
    let pages = 1;
    let refused = "not refused up to 4 GiB";
    while (pages < 65_536) {
      try {
        mem.grow(1024);
        pages += 1024;
        new Uint8Array(mem.buffer)[pages * 65_536 - 1] = 1; // touch the top so it is really committed
      } catch (e) {
        refused = (e as Error).message.slice(0, 120);
        break;
      }
    }
    const mib = Math.round((pages * 65_536) / MiB);
    return { ...ok(`WebAssembly memory grew to ${mib} MiB; then: ${refused}.`), measures: { maxMiB: mib, refused } };
  },
});

const memoryCeiling = lim({
  id: "web.limits.memoryCeiling",
  title: "JavaScript memory — how much can be allocated",
  why: "A WebView inside another app often gets far less memory than a browser tab. This allocates 32 MiB buffers, touching every page, until allocation fails or 3 GiB is reached. If the page dies instead, the journal records which probe killed it.",
  tier: TIER.INVOKE,
  optIn: "crash-risk",
  crashRisk: "high",
  timeoutMs: 120_000,
  async run() {
    const held: ArrayBuffer[] = [];
    let refused = "not refused up to 3 GiB";
    try {
      while (held.length * 32 < 3 * 1024) {
        const buf = new ArrayBuffer(32 * MiB);
        const v = new Uint8Array(buf);
        for (let i = 0; i < v.length; i += 4096) v[i] = 1;
        held.push(buf);
      }
    } catch (e) {
      refused = (e as Error).message.slice(0, 120);
    }
    const mib = held.length * 32;
    held.length = 0;
    return { ...ok(`Allocated ${mib} MiB; then: ${refused}.`), measures: { reachedMiB: mib, refused } };
  },
});

// -- backgrounding ----------------------------------------------------------------

const backgrounding = lim({
  id: "web.limits.backgrounding",
  title: "Backgrounding — switch away for 30 s, then come back",
  why: "After tapping, switch to another app (or lock the phone) for at least 30 seconds, then return. This records whether timers kept running while hidden, and whether a WebSocket and a Statement Store subscription survived — what a Product waiting for a delivery or a call can rely on.",
  tier: TIER.PROMPT,
  gesture: true,
  optIn: "slow",
  timeoutMs: 240_000,
  async run(ctx) {
    let ticks = 0;
    let hiddenTicks = 0;
    let hiddenAt = 0;
    let hiddenMs = 0;
    const timer = setInterval(() => {
      ticks++;
      if (document.hidden) hiddenTicks++;
    }, 1_000);
    ctx.cleanup.add("bg-timer", () => clearInterval(timer));

    const ws = new WebSocket("wss://rpc.polkadot.io");
    ctx.cleanup.add("bg-ws", () => ws.close());
    let wsClosedWhileAway = false;
    ws.onclose = () => (wsClosedWhileAway = true);

    let subInterrupted = false;
    let subState = "not opened";
    try {
      const store = await getStatementStore();
      if (store) {
        const sub = store.subscribe({ matchAny: [`0x${"ab".repeat(32)}`] }, () => {});
        sub.onInterrupt(() => (subInterrupted = true));
        ctx.cleanup.add("bg-sub", () => sub.unsubscribe());
        subState = "open";
      } else subState = "no statement store";
    } catch (e) {
      subState = `failed — ${(e as Error).message}`;
    }

    const cameBack = await until(ctx.signal, 220_000, () =>
      new Promise<void>((resolve) => {
        const onVis = () => {
          if (document.hidden) hiddenAt = performance.now();
          else if (hiddenAt) {
            hiddenMs = performance.now() - hiddenAt;
            if (hiddenMs >= 25_000) {
              document.removeEventListener("visibilitychange", onVis);
              resolve();
            }
          }
        };
        document.addEventListener("visibilitychange", onVis);
      }),
    );
    if (!cameBack.ok) return { status: "skip", detail: "The page was not hidden for 25 s and shown again within 3½ minutes — nothing to measure." };

    // Does the WebSocket still carry a request?
    let wsAnswers = false;
    if (ws.readyState === WebSocket.OPEN) {
      wsAnswers = (
        await until(ctx.signal, 10_000, () =>
          new Promise<boolean>((resolve) => {
            ws.onmessage = () => resolve(true);
            ws.send(JSON.stringify({ id: 1, jsonrpc: "2.0", method: "system_health", params: [] }));
          }),
        )
      ).ok;
    }
    const hiddenSec = Math.round(hiddenMs / 1000);
    const expected = hiddenSec;
    const rows = [
      pad("hidden for", `${hiddenSec} s`),
      pad("timer ticks while hidden", `${hiddenTicks} of ~${expected}`),
      pad("WebSocket", ws.readyState === WebSocket.OPEN ? (wsAnswers ? "open and answering" : "open but silent") : `closed${wsClosedWhileAway ? " while away" : ""}`),
      pad("statement subscription", subState === "open" ? (subInterrupted ? "interrupted" : "still open") : subState),
    ];
    return {
      ...ok(`Hidden ${hiddenSec} s: timers ran ${hiddenTicks} of ~${expected} ticks; WebSocket ${wsAnswers ? "survived" : "did not survive"}; subscription ${subInterrupted ? "was interrupted" : subState === "open" ? "survived" : subState}.`, lines(...rows)),
      measures: { hiddenSec, hiddenTicks, wsSurvived: wsAnswers, subscriptionSurvived: subState === "open" && !subInterrupted },
    };
  },
});

/** Cheap ones, placed with the rest of the web bank. */
export const WEB_LIMIT_PROBES: Probe[] = [barcodeDetector, webrtcLoopback, clipboardSize, groth16, backgrounding];
/** Crash-risk, placed at the very end of the manifest. */
export const WEB_CRASH_LIMIT_PROBES: Probe[] = [wasmMemory, memoryCeiling];

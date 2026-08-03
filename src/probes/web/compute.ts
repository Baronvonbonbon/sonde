// Execution primitives: WASM, workers, shared memory, crypto.
//
// These are the substrate everything else runs on. A WebView missing crypto.subtle
// or SharedArrayBuffer does not fail loudly — it fails at the point some library
// three layers down assumes them.

import { TIER, type Probe } from "../../core/types";
import { detect, lines, need, ok, pad, probe, wrong } from "../helpers";

const CAT = "compute";

/** Smallest valid WASM module: the 8-byte header and nothing else. */
const WASM_EMPTY = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

const wasmBasic = probe({
  id: "web.compute.wasm",
  title: "WebAssembly compile + instantiate",
  why: "The Polkadot SDK's crypto and codec paths are WASM. No WASM, no signing, no chain client — this gates most of Bank B.",
  category: CAT,
  tier: TIER.INVOKE,
  async run(ctx) {
    const WASM = need<typeof WebAssembly>("WebAssembly");
    const [mod, compileMs] = await ctx.timed(() => WASM.compile(WASM_EMPTY.buffer as ArrayBuffer));
    const [, instMs] = await ctx.timed(() => WASM.instantiate(mod, {}));

    // A module that adds two numbers — proves execution, not merely parsing.
    const adder = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f,
      0x01, 0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
      0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
    ]);
    const { instance } = await WASM.instantiate(adder.buffer as ArrayBuffer, {});
    const add = instance.exports.add as (a: number, b: number) => number;
    const sum = add(20, 22);

    return sum === 42
      ? ok(
          `Compiled, instantiated, and executed correctly (compile ${compileMs} ms, instantiate ${instMs} ms).`,
          lines(pad("add(20, 22)", sum), pad("streaming", typeof WASM.compileStreaming === "function")),
        )
      : wrong(`WASM ran but computed ${sum} instead of 42 — the engine is producing wrong answers.`);
  },
});

const wasmFeatures = probe({
  id: "web.compute.wasmFeatures",
  title: "WASM feature detection (SIMD, threads, exceptions, bulk memory)",
  why: "Cryptographic libraries ship SIMD builds. If SIMD is absent the fallback path is 5-20x slower, which turns 'works' into 'times out'.",
  category: CAT,
  tier: TIER.INVOKE,
  async run() {
    // Each is the minimal module using exactly one post-MVP feature. validate()
    // returning false is the only reliable detector — there is no feature flag.
    const tests: Record<string, Uint8Array> = {
      simd: new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0,
        253, 15, 253, 98, 11,
      ]),
      "bulk-memory": new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 10, 14, 1, 12,
        0, 65, 0, 65, 0, 65, 0, 252, 10, 0, 0, 11,
      ]),
      "sign-extension": new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 10, 7, 1, 5, 0, 65, 0,
        192, 11,
      ]),
      "mutable-globals": new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 2, 8, 1, 1, 97, 1, 98, 3, 127, 1,
      ]),
    };

    const rows: string[] = [];
    for (const [name, bytes] of Object.entries(tests)) {
      let valid = false;
      try {
        valid = WebAssembly.validate(bytes.buffer as ArrayBuffer);
      } catch {
        /* validate() itself throwing counts as unsupported */
      }
      rows.push(pad(name, valid ? "supported" : "NOT supported"));
    }

    // Threads need SharedArrayBuffer, which needs cross-origin isolation, which
    // a static bundle served from Bulletin has no way to set headers for.
    const threads = typeof SharedArrayBuffer !== "undefined" && window.crossOriginIsolated;
    rows.push(
      pad("threads", threads ? "supported" : "NOT supported"),
      pad("  SharedArrayBuffer", typeof SharedArrayBuffer !== "undefined"),
      pad("  crossOriginIsolated", window.crossOriginIsolated),
    );

    const simd = rows[0].includes("NOT") === false;
    return {
      status: simd ? "pass" : "fail",
      detail: simd
        ? "SIMD available — crypto libraries can take their fast path."
        : "SIMD is NOT available. Crypto falls back to scalar code, typically 5-20x slower, which can turn a working signing flow into one that times out.",
      data: lines(
        ...rows,
        "",
        "Threads require cross-origin isolation (COOP/COEP headers). A bundle served from",
        "Bulletin cannot set response headers, so threads are expected to be unavailable here",
        "regardless of engine support — that is a deployment property, not an engine defect.",
      ),
      diagnosis: simd ? undefined : "not-implemented",
    };
  },
});

const worker = probe({
  id: "web.compute.worker",
  title: "Dedicated Worker round-trip",
  why: "Workers are the only isolation boundary available in a page. A crash-prone probe put in a worker takes the worker down instead of the report.",
  category: CAT,
  tier: TIER.INVOKE,
  async run(ctx) {
    const src = `self.onmessage = (e) => self.postMessage(e.data * 2);`;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    ctx.cleanup.add("worker-blob-url", () => URL.revokeObjectURL(url));

    const w = new Worker(url);
    ctx.cleanup.add("worker", () => w.terminate());

    const reply = await new Promise<number>((resolve, reject) => {
      w.onmessage = (e) => resolve(e.data as number);
      w.onerror = (e) => reject(new Error(e.message || "worker error"));
      ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
      w.postMessage(21);
    });

    return reply === 42
      ? ok("Worker spawned from a blob URL, computed, and replied correctly.")
      : wrong(`Worker replied ${reply}, expected 42.`);
  },
});

const sharedWorker = detect({
  id: "web.compute.sharedWorker",
  title: "SharedWorker",
  why: "Absent in most mobile WebViews. Anything coordinating across tabs needs to know before it tries.",
  category: CAT,
  paths: "SharedWorker",
});

const serviceWorker = probe({
  id: "web.compute.serviceWorker",
  title: "Service Worker registration",
  why: "Offline capability and push both route through this. It also needs a secure context and a same-origin script, both of which an embedded bundle can lack.",
  category: CAT,
  tier: TIER.INVOKE,
  timeoutMs: 20_000,
  async run(ctx) {
    const sw = need<ServiceWorkerContainer>("navigator.serviceWorker");
    if (!window.isSecureContext) {
      return {
        status: "blocked",
        detail: "Service workers require a secure context and this page is not one.",
        diagnosis: "insecure-context",
        data: pad("origin", location.origin),
      };
    }
    // A blob URL will not do: registration requires a same-origin script URL, so
    // this genuinely exercises whether the bundle can serve one.
    const url = new URL("./sonde-sw.js", location.href).href;
    const reg = await sw.register(url, { scope: "./" });
    ctx.cleanup.add("service-worker", () => reg.unregister());
    return ok(
      "Registered.",
      lines(pad("scope", reg.scope), pad("script", url), pad("state", reg.installing ? "installing" : reg.active ? "active" : "waiting")),
    );
  },
});

const sharedArrayBuffer = probe({
  id: "web.compute.sharedArrayBuffer",
  title: "SharedArrayBuffer + Atomics",
  why: "Gated behind cross-origin isolation since Spectre. Reports whether the gate is closed because the engine lacks it or because the page lacks the headers — different fixes.",
  category: CAT,
  tier: TIER.INVOKE,
  async run() {
    const hasCtor = typeof SharedArrayBuffer !== "undefined";
    const isolated = window.crossOriginIsolated ?? false;
    const evidence = lines(
      pad("SharedArrayBuffer", hasCtor),
      pad("crossOriginIsolated", isolated),
      pad("Atomics", typeof Atomics !== "undefined"),
    );

    if (!hasCtor) {
      return {
        status: "unsupported",
        detail: "SharedArrayBuffer is not defined at all.",
        data: evidence,
        diagnosis: "not-implemented",
      };
    }
    if (!isolated) {
      return {
        status: "blocked",
        detail:
          "Constructor exists but the page is not cross-origin isolated, so allocation will throw. " +
          "This needs COOP/COEP response headers, which a static bundle served from Bulletin cannot set.",
        data: evidence,
        diagnosis: "policy-blocked-by-embedder",
      };
    }
    const sab = new SharedArrayBuffer(8);
    const view = new Int32Array(sab);
    Atomics.store(view, 0, 42);
    return Atomics.load(view, 0) === 42
      ? ok("Allocated shared memory and completed an atomic round-trip.", evidence)
      : wrong("Atomics.load did not return what Atomics.store wrote.", evidence);
  },
});

const subtleCrypto = probe({
  id: "web.compute.subtleCrypto",
  title: "crypto.subtle algorithm matrix",
  why: "Everything this suite seals, signs, or hashes goes through here. A WebView missing one curve breaks one flow and nothing else, which is exactly the kind of gap a matrix finds.",
  category: CAT,
  tier: TIER.INVOKE,
  timeoutMs: 30_000,
  async run() {
    const subtle = need<SubtleCrypto>("crypto.subtle");
    const rows: string[] = [];
    let failures = 0;

    const check = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        rows.push(pad(label, "ok"));
      } catch (e) {
        rows.push(pad(label, `FAILED — ${(e as Error).message}`));
        failures++;
      }
    };

    const data = new TextEncoder().encode("sonde");

    await check("SHA-256", () => subtle.digest("SHA-256", data));
    await check("SHA-512", () => subtle.digest("SHA-512", data));
    await check("AES-GCM 256", async () => {
      const k = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await subtle.encrypt({ name: "AES-GCM", iv }, k, data);
      const pt = await subtle.decrypt({ name: "AES-GCM", iv }, k, ct);
      if (new TextDecoder().decode(pt) !== "sonde") throw new Error("round-trip mismatch");
    });
    await check("HMAC SHA-256", async () => {
      const k = await subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign", "verify"]);
      await subtle.sign("HMAC", k, data);
    });
    await check("ECDSA P-256", async () => {
      const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, data);
      if (!(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, kp.publicKey, sig, data))) {
        throw new Error("signature did not verify");
      }
    });
    await check("ECDH P-256", async () => {
      const kp = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
      await subtle.deriveBits({ name: "ECDH", public: kp.publicKey }, kp.privateKey, 256);
    });
    // Ed25519 is what Polkadot signing needs and is the most likely gap.
    await check("Ed25519", async () => {
      const kp = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
      await subtle.sign({ name: "Ed25519" }, kp.privateKey, data);
    });
    await check("X25519", async () => {
      const kp = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
      await subtle.deriveBits({ name: "X25519", public: kp.publicKey }, kp.privateKey, 256);
    });
    await check("PBKDF2", async () => {
      const k = await subtle.importKey("raw", data, "PBKDF2", false, ["deriveBits"]);
      await subtle.deriveBits({ name: "PBKDF2", salt: data, iterations: 1000, hash: "SHA-256" }, k, 256);
    });
    await check("RSA-OAEP 2048", async () => {
      await subtle.generateKey(
        { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["encrypt", "decrypt"],
      );
    });

    rows.push("", pad("randomUUID", typeof crypto.randomUUID === "function"));

    // Ed25519 and X25519 are still absent in plenty of shipping engines, so
    // their absence is characterised rather than counted as a defect.
    const optional = rows.filter((r) => /^(Ed25519|X25519)/.test(r) && r.includes("FAILED")).length;
    const real = failures - optional;

    return {
      status: real > 0 ? "fail" : optional > 0 ? "unsupported" : "pass",
      detail:
        real > 0
          ? `${real} core algorithm(s) failed — anything relying on them is broken here.`
          : optional > 0
            ? `Core algorithms all work; ${optional} newer curve(s) absent (common, not a defect).`
            : "Every algorithm tested works, including Ed25519 and X25519.",
      data: lines(...rows),
      diagnosis: real > 0 ? "not-implemented" : undefined,
    };
  },
});

// Named with a suffix so it does not shadow the global it is testing — a probe
// called `structuredClone` makes `need<typeof structuredClone>` self-referential.
const structuredCloneProbe = probe({
  id: "web.compute.structuredClone",
  title: "structuredClone type coverage",
  why: "postMessage and IndexedDB both use this algorithm. A type it cannot clone is a type that cannot cross a worker or reach storage.",
  category: CAT,
  tier: TIER.INVOKE,
  async run() {
    const sc = need<typeof structuredClone>("structuredClone");
    const cases: [string, unknown][] = [
      ["Map", new Map([["a", 1]])],
      ["Set", new Set([1, 2])],
      ["Date", new Date()],
      ["RegExp", /x/g],
      ["BigInt", 1n],
      ["ArrayBuffer", new ArrayBuffer(8)],
      ["Uint8Array", new Uint8Array([1, 2, 3])],
      ["Error", new Error("x")],
      ["Blob", new Blob(["x"])],
      ["circular", (() => { const o: Record<string, unknown> = {}; o.self = o; return o; })()],
    ];
    const rows: string[] = [];
    let failed = 0;
    for (const [name, value] of cases) {
      try {
        sc(value);
        rows.push(pad(name, "ok"));
      } catch (e) {
        rows.push(pad(name, `FAILED — ${(e as Error).message}`));
        failed++;
      }
    }
    return failed === 0
      ? ok("All tested types clone.", lines(...rows))
      : wrong(`${failed} type(s) cannot be cloned — they cannot cross a worker boundary or reach IndexedDB.`, lines(...rows));
  },
});

export const COMPUTE_PROBES: Probe[] = [
  wasmBasic,
  wasmFeatures,
  subtleCrypto,
  structuredCloneProbe,
  worker,
  sharedWorker,
  serviceWorker,
  sharedArrayBuffer,
];

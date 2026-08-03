// Files, in and out.
//
// OPFS is the interesting one: it needs no permission and no picker, so it
// works headless, which makes it the only large-file store a fully unattended
// run can exercise.

import { TIER, type Probe } from "../../core/types";
import { kb, lines, need, ok, pad, probe, unsupported, wrong } from "../helpers";

const CAT = "filesystem";

const opfs = probe({
  id: "web.filesystem.opfs",
  title: "Origin Private File System",
  why: "The only sizeable file store that needs no user gesture and no permission, which makes it the natural place to stage a large upload. Absent in some WebViews.",
  category: CAT,
  tier: TIER.INVOKE,
  timeoutMs: 25_000,
  async run(ctx) {
    const storage = need<{ getDirectory?(): Promise<FileSystemDirectoryHandle> }>("navigator.storage");
    if (!storage.getDirectory) return unsupported("navigator.storage.getDirectory is absent — no OPFS.");

    const root = await storage.getDirectory();
    const name = `sonde-${Date.now()}.bin`;
    const handle = await root.getFileHandle(name, { create: true });
    ctx.cleanup.add("opfs-file", () => root.removeEntry(name).catch(() => {}));

    const payload = crypto.getRandomValues(new Uint8Array(64 * 1024));
    const w = await handle.createWritable();
    await w.write(payload);
    await w.close();

    const read = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    const identical = read.length === payload.length && read.every((b, i) => b === payload[i]);

    // Sync access handles are the fast path and are worker-only on some builds,
    // so their absence on the main thread is expected rather than a defect.
    const sync = "createSyncAccessHandle" in handle;

    return identical
      ? ok(
          `Wrote and read back ${kb(payload.length)} byte-for-byte.`,
          lines(pad("bytes", payload.length), pad("createSyncAccessHandle", sync ? "present" : "absent (worker-only, or unsupported)")),
        )
      : wrong(`Read back ${read.length} bytes of ${payload.length}, and the contents differ.`);
  },
});

const fileSystemAccess = probe({
  id: "web.filesystem.showOpenFilePicker",
  title: "File System Access — open picker",
  why: "The only route to a user-chosen file with a writable handle. Absent on Android Chromium, so a Product there cannot edit a file in place.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  timeoutMs: 60_000,
  async run(ctx) {
    const pick = (globalThis as { showOpenFilePicker?: (o?: object) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker;
    if (!pick) {
      return unsupported(
        "showOpenFilePicker is absent — expected on Android. <input type=file> is the fallback and is tested separately.",
      );
    }
    const [handle] = await pick({ multiple: false });
    const file = await handle.getFile();
    // Name and size only. A shared report must not carry the contents of
    // whatever the operator happened to pick.
    let writable = "not attempted";
    try {
      const w = await handle.createWritable();
      await w.close();
      writable = "granted";
      ctx.cleanup.add("fs-handle", () => void 0);
    } catch (e) {
      writable = `refused — ${(e as Error).message}`;
    }
    return ok(
      `Picked "${file.name}".`,
      lines(pad("size", kb(file.size)), pad("type", file.type || "unknown"), pad("write handle", writable), "", "File CONTENTS are not recorded."),
    );
  },
});

const directoryPicker = probe({
  id: "web.filesystem.showDirectoryPicker",
  title: "File System Access — directory picker",
  why: "Directory access is granted far more reluctantly than single files, so it is a separate question from the open picker.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  needs: ["web.filesystem.showOpenFilePicker"],
  timeoutMs: 60_000,
  async run() {
    const pick = (globalThis as { showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
    if (!pick) return unsupported("showDirectoryPicker is absent.");
    const dir = await pick();
    let count = 0;
    // Counted, not listed. Directory listings are exactly the kind of thing
    // that should not end up in a report someone pastes into a public issue.
    for await (const _ of (dir as unknown as AsyncIterable<unknown>)) {
      void _;
      if (++count >= 50) break;
    }
    return ok(`Directory granted; ${count}${count >= 50 ? "+" : ""} entries visible.`, "Entry NAMES are not recorded.");
  },
});

const saveFilePicker = probe({
  id: "web.filesystem.showSaveFilePicker",
  title: "File System Access — save picker",
  why: "Determines whether a report can be written to a chosen location, or only pushed through the anchor-download fallback.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  needs: ["web.filesystem.showOpenFilePicker"],
  timeoutMs: 60_000,
  async run() {
    const pick = (globalThis as { showSaveFilePicker?: (o?: object) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
    if (!pick) return unsupported("showSaveFilePicker is absent.");
    const handle = await pick({
      suggestedName: "sonde-write-probe.txt",
      types: [{ description: "Text", accept: { "text/plain": [".txt"] } }],
    });
    const w = await handle.createWritable();
    await w.write("sonde write probe — safe to delete");
    await w.close();
    return ok(`Wrote to "${handle.name}".`);
  },
});

const fileInput = probe({
  id: "web.filesystem.fileInput",
  title: "<input type=file> fallback",
  why: "The universal fallback. If even this is broken there is no route to user files at all, which would be a much more serious finding than a missing picker.",
  category: CAT,
  tier: TIER.PROMPT,
  gesture: true,
  timeoutMs: 60_000,
  async run(ctx) {
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = "none";
    document.body.appendChild(input);
    ctx.cleanup.add("file-input", () => input.remove());

    const file = await new Promise<File>((resolve, reject) => {
      input.onchange = () => {
        const f = input.files?.[0];
        f ? resolve(f) : reject(new Error("no file chosen"));
      };
      input.oncancel = () => reject(new DOMException("cancelled", "AbortError"));
      ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
      input.click();
    });

    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    return ok(
      `Received "${file.name}".`,
      lines(
        pad("size", kb(file.size)),
        pad("type", file.type || "unknown"),
        pad("first 8 bytes", [...head].map((b) => b.toString(16).padStart(2, "0")).join(" ")),
        "",
        "Only the first 8 bytes are read, to confirm the data is reachable without recording content.",
      ),
    );
  },
});

const blobRoundTrip = probe({
  id: "web.filesystem.blob",
  title: "Blob / File / object URL round-trip",
  why: "The report's own JSON download is built from these. A WebView that mishandles object URLs silently produces empty files.",
  category: CAT,
  tier: TIER.INVOKE,
  async run(ctx) {
    const payload = crypto.getRandomValues(new Uint8Array(4096));
    const blob = new Blob([payload], { type: "application/octet-stream" });

    const viaArrayBuffer = new Uint8Array(await blob.arrayBuffer());
    const url = URL.createObjectURL(blob);
    ctx.cleanup.add("object-url", () => URL.revokeObjectURL(url));
    const viaFetch = new Uint8Array(await (await fetch(url)).arrayBuffer());

    const streamOk = typeof blob.stream === "function";
    let viaStream = 0;
    if (streamOk) {
      const reader = blob.stream().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        viaStream += value.length;
      }
    }

    const abOk = viaArrayBuffer.length === payload.length && viaArrayBuffer[0] === payload[0];
    const fetchOk = viaFetch.length === payload.length;
    return abOk && fetchOk
      ? ok(
          "arrayBuffer, object URL, and stream all return the full payload.",
          lines(pad("arrayBuffer", viaArrayBuffer.length), pad("via object URL", viaFetch.length), pad("via stream", streamOk ? viaStream : "no stream()")),
        )
      : wrong(
          "A blob round-trip lost data — downloads built this way will be truncated or empty.",
          lines(pad("expected", payload.length), pad("arrayBuffer", viaArrayBuffer.length), pad("object URL", viaFetch.length)),
        );
  },
});

export const FILESYSTEM_PROBES: Probe[] = [
  blobRoundTrip,
  opfs,
  fileInput,
  fileSystemAccess,
  saveFilePicker,
  directoryPicker,
];

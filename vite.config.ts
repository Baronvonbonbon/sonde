import { defineConfig } from "vite";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// sonde is deliberately self-contained. kite resolved an `@src` alias to a
// sibling checkout, which made it un-runnable by anyone who did not also have
// that checkout — the single biggest obstacle to handing a probe to someone
// else and asking them to run it. There is no alias here on purpose.

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8"));

/** The installed versions, not the semver ranges — a report must name what ran. */
function installedVersions(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    try {
      out[name] = JSON.parse(
        readFileSync(resolve(__dirname, "node_modules", name, "package.json"), "utf8"),
      ).version;
    } catch {
      out[name] = `${pkg.dependencies[name]} (not installed)`;
    }
  }
  return out;
}

/**
 * Dev-only sink for headless runs.
 *
 * tools/run-headless.mjs drives a real browser and needs the report back.
 * Chrome's --virtual-time-budget stalls indefinitely when a fetch is pending,
 * and --dump-dom only fires when the budget expires, so neither is usable for a
 * suite that deliberately makes network calls. Having the page POST its own
 * result sidesteps the whole mechanism: the runner finishes in real time and
 * the file appearing on disk is the completion signal.
 *
 * Dev server only — `apply: "serve"` keeps it out of the published bundle.
 */
function reportSink() {
  return {
    name: "sonde-report-sink",
    apply: "serve" as const,
    configureServer(server: { middlewares: { use(fn: (req: any, res: any, next: () => void) => void): void } }) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== "POST" || !req.url?.startsWith("/__sonde/report")) return next();
        const target = new URL(req.url, "http://localhost").searchParams.get("to");
        if (!target) {
          res.statusCode = 400;
          return res.end("missing ?to=");
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            writeFileSync(target, Buffer.concat(chunks));
            res.statusCode = 204;
            res.end();
          } catch (e) {
            res.statusCode = 500;
            res.end(String(e));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [reportSink()],
  // `pad` uploads a static directory and points a DotNS contenthash at it, so
  // everything must resolve relatively — there is no server and no origin.
  base: "./",
  build: { target: "es2022", outDir: "dist" },
  define: {
    __SDK_VERSIONS__: JSON.stringify(installedVersions()),
    __SUITE_VERSION__: JSON.stringify(pkg.version),
    // Distinguishes two builds of the same suite version. A report that cannot
    // name the exact bundle it came from is not reproducible.
    __BUILD_ID__: JSON.stringify(new Date().toISOString()),
  },
  server: { host: true },
});

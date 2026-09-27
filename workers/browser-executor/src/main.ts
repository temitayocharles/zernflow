import { WorkerClient } from "./client";
import { runLoop, type Logger } from "./loop";
import { createPlaywrightRuntime } from "./playwright-runtime";
import { instagramAdapter } from "../../../lib/browser/adapters/instagram";
import { facebookAdapter } from "../../../lib/browser/adapters/facebook";
import { tiktokAdapter } from "../../../lib/browser/adapters/tiktok";
import { linkedinAdapter } from "../../../lib/browser/adapters/linkedin";
import { xAdapter } from "../../../lib/browser/adapters/x";

function int(name: string, fallback: number, min: number, max: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.min(max, Math.max(min, Math.floor(v))) : fallback;
}

const log: Logger = {
  info: (event, fields) => console.log(JSON.stringify({ level: "info", event, ...fields, ts: new Date().toISOString() })),
  warn: (event, fields) => console.warn(JSON.stringify({ level: "warn", event, ...fields, ts: new Date().toISOString() })),
};

async function main() {
  if (process.env.PAID_COMPUTE_ALLOWED === "true") log.warn("executor.paid_compute_flag_ignored", { note: "this executor never scales itself" });
  const client = new WorkerClient({ baseUrl: process.env.ZERNFLOW_URL ?? "", token: process.env.ZERNFLOW_WORKER_TOKEN ?? "" });
  const runtime = createPlaywrightRuntime({
    navigationTimeoutMs: int("BROWSER_NAVIGATION_TIMEOUT_MS", 30_000, 5_000, 120_000),
    checkTimeoutMs: int("BROWSER_CHECK_TIMEOUT_MS", 90_000, 10_000, 300_000),
  });
  let stopping = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => (stopping = true));
  const outcome = await runLoop(
    { client, runtime, adapters: [instagramAdapter, facebookAdapter, tiktokAdapter, linkedinAdapter, xAdapter], log },
    {
      maxMs: int("BROWSER_JOB_MAX_MS", 10 * 60_000, 60_000, 60 * 60_000),
      idleShutdown: process.env.BROWSER_IDLE_SHUTDOWN !== "false",
      pollMs: int("BROWSER_POLL_MS", 30_000, 5_000, 300_000),
      shouldStop: () => stopping,
    },
  );
  log.info("executor.exit", outcome);
}

main().catch((e) => {
  log.warn("executor.fatal", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});

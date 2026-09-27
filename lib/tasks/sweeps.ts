import "server-only";
import { registerSweep } from "./maintenance";
import { sweepSecretExpiry } from "@/lib/secrets/expiry-sweep";
import { sweepArtifacts } from "@/lib/artifacts/service";
import { getObjectStore, objectStoreConfigured } from "@/lib/storage";
import { reconcilePublishing, remindManualPublications } from "@/lib/publishing/sweeps";
import { sweepBrowserSessions } from "@/lib/browser-sessions/sweep";
import { settleAbandonedLegacyTasks } from "@/lib/jobs/legacy-task-handlers";

/**
 * Registers deployment-wide maintenance sweeps (run by the cron tick's
 * maintenance stage; each sweep is isolated and bounded).
 */
registerSweep({ name: "secretExpiry", run: (supabase) => sweepSecretExpiry(supabase) });
registerSweep({
  name: "artifactRetention",
  run: async (supabase) =>
    objectStoreConfigured() ? sweepArtifacts(supabase, getObjectStore()) : { status: "skipped", reason: "storage_not_configured" },
});
registerSweep({ name: "publishReconcile", run: (supabase) => reconcilePublishing(supabase) });
registerSweep({ name: "manualPublishDue", run: (supabase) => remindManualPublications(supabase) });
registerSweep({ name: "browserSessions", run: (supabase) => sweepBrowserSessions(supabase) });
registerSweep({ name: "legacyTaskSettle", run: (supabase) => settleAbandonedLegacyTasks(supabase) });

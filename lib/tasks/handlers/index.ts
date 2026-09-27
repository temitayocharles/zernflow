import type { TaskHandler } from "../types";
import { gatewayHealthHandler, noopHandler, pruneHistoryHandler } from "./system";
import { contentPublishHandler } from "@/lib/publishing/service";
import { browserSessionCheckHandler } from "@/lib/browser-sessions/service";
import { LEGACY_TASK_HANDLERS } from "@/lib/jobs/legacy-task-handlers";
import { secretsRewrapHandler } from "@/lib/secrets/rewrap";
import { contentRecurHandler } from "@/lib/publishing/recurring";

/**
 * Task kind registry. Adding a kind here is the only way work becomes
 * executable; unknown kinds are dead-lettered as validation errors.
 */
const handlers: TaskHandler[] = [
  noopHandler as unknown as TaskHandler,
  pruneHistoryHandler as unknown as TaskHandler,
  gatewayHealthHandler as unknown as TaskHandler,
  contentPublishHandler as unknown as TaskHandler,
  browserSessionCheckHandler as unknown as TaskHandler,
  secretsRewrapHandler as unknown as TaskHandler,
  contentRecurHandler as unknown as TaskHandler,
  ...LEGACY_TASK_HANDLERS.map((h) => h as unknown as TaskHandler),
];

const registry = new Map<string, TaskHandler>();

export function registerHandler(handler: TaskHandler): void {
  if (registry.has(handler.kind)) throw new Error(`Duplicate task kind ${handler.kind}`);
  registry.set(handler.kind, handler);
}

for (const handler of handlers) registerHandler(handler);

export function getHandler(kind: string): TaskHandler | undefined {
  return registry.get(kind);
}

export function listHandlers(): TaskHandler[] {
  return [...registry.values()];
}

export function describeHandlers() {
  return listHandlers().map((h) => ({
    kind: h.kind,
    title: h.title,
    description: h.description,
    mode: h.mode,
    schedulable: h.schedulable,
    userRunnable: h.userRunnable,
  }));
}

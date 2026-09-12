import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import {
  parseOperatorMetrics,
  durationLabel,
} from "@/lib/analytics/operator-metrics";
export default async function Operations() {
  const { supabase, workspace } = await getWorkspace();
  const { data, error } = await supabase.rpc("operator_metrics", {
    p_workspace_id: workspace.id,
  });
  if (error)
    return (
      <p role="alert" className="p-6">
        Operator metrics unavailable. Apply migration 00025 and reload.
      </p>
    );
  const m = parseOperatorMetrics(data);
  const cards = [
    ["Work backlog", m.work_items.backlog],
    ["Unassigned work", m.work_items.unassigned],
    ["Escalated work", m.work_items.escalated],
    ["Resolution SLA warnings", m.work_items.resolution_warning],
    ["Resolution SLA breaches", m.work_items.resolution_breached],
    ["First response breaches", m.work_items.first_response_breached],
    ["Contacts", m.contacts.total],
    ["Contacts created in 30 days", m.contacts.created_last_30_days],
    ["Companies", m.companies],
    ["Open conversation projections", m.conversation_projection.open],
    ["Snoozed conversation projections", m.conversation_projection.snoozed],
    [
      "Local automation-paused projections",
      m.conversation_projection.automation_paused,
    ],
    ["Published flows", m.flows.published],
    ["Active sequences", m.sequences.active],
    ["Active channel projections", m.channels.active_projection],
  ];
  return (
    <main className="space-y-6 overflow-auto p-6">
      <h1 className="text-2xl font-semibold">Operator analytics</h1>
      <p className="max-w-3xl text-sm text-muted-foreground">
        Real workspace aggregates, not sampled pages. Provider health and
        human-versus-AI execution are not inferred from local flags. Channel and
        conversation counts are projections, not a live Gateway certification.
      </p>
      <p className="text-xs text-muted-foreground">
        As of {new Date(m.as_of).toLocaleString()}
      </p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(([label, value]) => (
          <section key={label} className="rounded-xl border border-border p-4">
            <h2 className="text-sm text-muted-foreground">{label}</h2>
            <p className="mt-2 text-2xl font-semibold">{value}</p>
          </section>
        ))}
      </div>
      <section className="space-y-2 rounded-xl border border-border p-4">
        <h2 className="font-semibold">Recorded work-item timing</h2>
        <p className="text-sm">
          First response: {durationLabel(m.work_items.average_response_seconds)}{" "}
          ({m.work_items.response_samples} samples)
        </p>
        <p className="text-sm">
          Resolution: {durationLabel(m.work_items.average_resolution_seconds)} (
          {m.work_items.resolution_samples} samples)
        </p>
        <p className="text-xs text-muted-foreground">
          Based on operator-recorded work-item timestamps, not inferred provider
          reply events. Reopened work is unresolved until resolved again;
          previous transitions remain in activity history.
        </p>
      </section>
      <section className="rounded-xl border border-border p-4">
        <h2 className="font-semibold">Open opportunity pipeline by currency</h2>
        {m.pipeline_by_currency.length ? (
          m.pipeline_by_currency.map((p) => (
            <p key={p.currency} className="mt-2 text-sm">
              {p.currency}: {p.value_minor} minor units across {p.deals}{" "}
              opportunities
            </p>
          ))
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            No open opportunities.
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Currencies are not combined or converted; exact minor-unit totals
          avoid floating-point rounding.
        </p>
      </section>
      <nav className="flex gap-4 text-sm">
        <Link className="underline" href="/dashboard/work-items">
          Review work
        </Link>
        <Link className="underline" href="/dashboard/notifications">
          Review notifications
        </Link>
        <Link className="underline" href="/dashboard/analytics">
          Flow analytics
        </Link>
      </nav>
    </main>
  );
}

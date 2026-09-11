# SLA calculation foundation

`lib/service-desk/sla.ts` contains deterministic calendar-time calculations; it
has no database, React, clock, provider or execution dependencies. This is an
engine foundation, **not a completed ticket product or escalation worker**.

- All timestamps require explicit timezone offsets. Callers supply `now`.
- Targets are positive whole minutes, bounded at one year.
- Priority overrides replace individual targets; omitted targets inherit defaults.
- Warning begins when the configured fraction of the active budget is consumed.
- An unfinished objective breaches at its deadline. Completion exactly at the
  deadline meets it; late completion retains breach history but does not request
  a new escalation.
- Pause intervals must not overlap, extend into the future, or precede creation.
  An open pause freezes the budget but cannot hide an already breached target.
- First response and resolution pauses are separate. Do not pause first response
  merely because a ticket waits on a customer unless the accepted policy says so.
- `dueAt` during an open pause moves with the evaluation clock; display the
  paused state, not an apparently fixed deadline.
- `escalationRequired` is a calculation result only. The owning backend must
  enforce policy, deduplication and durable execution before sending alerts.

Work-item schema/UI, immutable policy snapshots, authorized response/completion
recording, business-hour calendars, notifications, and escalation dispatch are
not implemented by this module. Do not infer them from passing unit tests.

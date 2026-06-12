# Escalation Target

Vibe Manager sends escalation pings via Slack DM.

**Target workspace:** Vibe-Manager
**Target channel or DM:** DM to self

## Env contract (v1 skeleton)

- `SLACK_WEBHOOK_URL` — a Slack incoming-webhook URL pointed at the DM/channel above. Set it in `.env` (see `.env.example`).
- When set: every `escalate: true` router decision posts a DM (urgency, reason, context, `root_task_id`) and writes an `escalation_raised` event. Delivery failure writes `escalation_delivery_failed` and never blocks the task.
- When unset: escalations are recorded in `vibe_manager.events` and printed to the console only — `vibe run`'s preflight warns loudly that escalations cannot reach you.
- v1 is fire-and-record: an inbound-prompt escalation blocks the run (re-run with a clarified prompt); reaction-driven pause/resume (✅/❌/❓) is the M5 milestone.

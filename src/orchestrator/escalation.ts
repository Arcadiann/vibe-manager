import type { EventsRepo } from '../persistence/repos.ts'
import type { RouterDecision } from '../agents/vision-agent.ts'

type EventsAppendPort = Pick<EventsRepo, 'append'>

// Escalation surface (plan §5): every escalate:true writes events and sends a
// Slack DM via webhook when SLACK_WEBHOOK_URL is set. Delivery failure is an
// event (escalation_delivery_failed), never a task blocker. The reaction-
// driven pause/resume loop is M5; v1 is fire-and-record.
export async function raiseEscalation(input: {
  events: EventsAppendPort
  rootTaskId: string
  taskId: string | null
  decision: RouterDecision
  context: string
  webhookUrl: string | undefined
}): Promise<void> {
  await input.events.append({
    kind: 'escalation_raised',
    taskId: input.taskId,
    rootTaskId: input.rootTaskId,
    agent: 'vision',
    payload: { decision: input.decision, context: input.context },
    payloadSummary: `[${input.decision.urgency}] ${input.decision.reason}`,
  })
  if (!input.webhookUrl) {
    console.error(
      `[vibe] ESCALATION (urgency=${input.decision.urgency}): ${input.decision.reason}\n` +
        `       SLACK_WEBHOOK_URL is not set — this reached nobody. Recorded in events.`,
    )
    return
  }
  try {
    const res = await fetch(input.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: `:rotating_light: *Vibe Manager escalation* (urgency: ${input.decision.urgency})\n*Why:* ${input.decision.reason}\n*Context:* ${input.context}\n*Run:* ${input.rootTaskId}\nReply by re-running \`vibe run\` with a clarified prompt (reaction-driven resume lands in M5).`,
      }),
    })
    if (!res.ok) throw new Error(`webhook returned ${res.status}`)
  } catch (err) {
    await input.events.append({
      kind: 'escalation_delivery_failed',
      taskId: input.taskId,
      rootTaskId: input.rootTaskId,
      agent: 'orchestrator',
      payload: { error: String(err) },
      payloadSummary: `Slack delivery failed: ${String(err)}`,
    })
    console.error(`[vibe] escalation Slack delivery failed (recorded): ${String(err)}`)
  }
}

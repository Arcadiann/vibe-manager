import { ROUTER_MODEL, type JsonCaller } from './claude-json-call.ts'

// The decision router (vision.md §Decision router heuristics — the rubric
// below is that section, verbatim in substance). Router, not thinker: binary
// classification with a reason, nothing strategic. Two trigger points
// (plan §5): the inbound CLI prompt (sanity gate) and mid-run worker
// `blocked` events via the dispatcher hook — the latter is wired but DORMANT
// until #26 gives ClaudeCodeWorker mid-run event emission.

export type RouterDecision = {
  escalate: boolean
  reason: string
  urgency: 'low' | 'normal' | 'high'
}

export type RouterInput =
  | { trigger: 'inbound_prompt'; prompt: string }
  | { trigger: 'worker_blocked'; taskTitle: string; reason: string; needs: string }

const RUBRIC = `You are the Vision Agent for Vibe Manager: a binary decision router. Your ONLY job is to classify whether a proposed action requires escalation to the human operator. You do not make strategic decisions, you do not redesign tasks, you route.

ESCALATE when the proposed change would:
- Change product direction or user-facing behavior in a way not explicitly authorized by the original vision
- Reverse a previously documented decision
- Touch security, auth, billing, or PII surfaces
- Require new external service contracts or API keys
- Exceed a per-task token budget cap
- Be a blocker the Technical Manager cannot resolve after retries

DO NOT escalate for:
- Naming, formatting, style choices
- Routine access requests (the orchestrator grants its workers what they need)
- Minor technical implementation choices within an approved approach
- Anything explicitly delegated in the original task framing

Output urgency: "high" for security/auth/billing/PII or active blockers, "normal" for direction changes, "low" for everything else.`

const SCHEMA = {
  type: 'object',
  properties: {
    escalate: { type: 'boolean' },
    reason: { type: 'string' },
    urgency: { type: 'string', enum: ['low', 'normal', 'high'] },
  },
  required: ['escalate', 'reason', 'urgency'],
  additionalProperties: false,
} as const

export class VisionAgent {
  readonly #call: JsonCaller
  constructor(call: JsonCaller) {
    this.#call = call
  }

  async classify(input: RouterInput): Promise<{ decision: RouterDecision; rubricInput: string; usage: { inputTokens: number; outputTokens: number } }> {
    const rubricInput =
      input.trigger === 'inbound_prompt'
        ? `Trigger: inbound operator prompt (sanity gate).\nProposed work: ${input.prompt}\n\nClassify: does dispatching this work require escalation back to the operator first?`
        : `Trigger: worker blocked mid-run.\nTask: ${input.taskTitle}\nBlocked because: ${input.reason}\nWorker says it needs: ${input.needs}\n\nClassify: does unblocking this require the operator, or can the system proceed/retry?`
    const r = await this.#call<RouterDecision>({
      model: ROUTER_MODEL,
      system: RUBRIC,
      user: rubricInput,
      schema: SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 512,
    })
    return {
      decision: r.value,
      // Persisted with the decision (plan §5): every router judgment plus its
      // full input is ground truth for the escalation-quality dataset.
      rubricInput,
      usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens },
    }
  }
}

import Anthropic from '@anthropic-ai/sdk'

// Model selection per tier (plan §5, decided against the claude-api skill's
// current catalog, 2026-06): the router is a binary classifier — Haiku 4.5
// ($1/$5 per MTok) is the smallest/fastest fit; the Manager decomposes and
// synthesizes — Sonnet 4.6 ($3/$15) is the mid-tier fit. The platform default
// recommendation is Opus 4.8; the dogfood cost posture ($500/mo cap,
// ADR-0002 API-tier pricing) deliberately overrides it for these two
// always-on orchestrator calls. Revisit with dogfood data.
export const ROUTER_MODEL = 'claude-haiku-4-5'
export const MANAGER_MODEL = 'claude-sonnet-4-6'

export type JsonCallResult<T> = { value: T; inputTokens: number; outputTokens: number }

export type JsonCaller = <T>(opts: {
  model: string
  system: string
  user: string
  schema: Record<string, unknown>
  maxTokens?: number
}) => Promise<JsonCallResult<T>>

// Shared LLM-call helper (plan §5 / review A15): structured outputs make the
// API guarantee schema-valid JSON; the repair retry covers what they can't —
// refusals (stop_reason 'refusal' escapes the schema) and max_tokens
// truncation. One retry, then LOUD failure. Never silent-proceed on bad
// router/manager output.
export function makeJsonCaller(client: Anthropic): JsonCaller {
  return async function claudeJsonCall<T>(opts: {
    model: string
    system: string
    user: string
    schema: Record<string, unknown>
    maxTokens?: number
  }): Promise<JsonCallResult<T>> {
    let lastProblem = ''
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await client.messages.create({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 4096,
        system: opts.system,
        output_config: { format: { type: 'json_schema', schema: opts.schema } },
        messages: [
          {
            role: 'user',
            content:
              attempt === 1
                ? opts.user
                : `${opts.user}\n\nYour previous response was invalid (${lastProblem}). Respond with ONLY the JSON object matching the schema.`,
          },
        ],
      })
      if (response.stop_reason === 'refusal') {
        lastProblem = 'refusal'
        continue
      }
      if (response.stop_reason === 'max_tokens') {
        lastProblem = 'output truncated at max_tokens'
        continue
      }
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
      try {
        return {
          value: JSON.parse(text) as T,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        }
      } catch {
        lastProblem = 'unparseable JSON'
      }
    }
    throw new Error(`llm_output_invalid: ${lastProblem} after repair retry (model=${opts.model})`)
  }
}

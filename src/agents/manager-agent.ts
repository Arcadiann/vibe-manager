import { MANAGER_MODEL, type JsonCaller } from './claude-json-call.ts'

// The Technical Manager (vision.md tier 2): decomposes a spec into a task
// graph AND synthesizes the final result into a PR body (plan §5 / review F4
// — synthesis is what makes the smoke test honest).

export type DecomposedTask = {
  title: string
  description: string
  successCriteria: string | null
  // Indexes into the same array. The skeleton executes sequentially in
  // topological order; the dispatcher chains worktree baseRefs along these
  // edges (plan §4b-2).
  dependsOn: number[]
}

export type Decomposition = { tasks: DecomposedTask[] }

const DECOMPOSE_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          successCriteria: { type: ['string', 'null'] },
          dependsOn: { type: 'array', items: { type: 'integer' } },
        },
        required: ['title', 'description', 'successCriteria', 'dependsOn'],
        additionalProperties: false,
      },
    },
  },
  required: ['tasks'],
  additionalProperties: false,
} as const

const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    prTitle: { type: 'string' },
    prBody: { type: 'string' },
  },
  required: ['prTitle', 'prBody'],
  additionalProperties: false,
} as const

const DECOMPOSE_SYSTEM = `You are the Technical Manager Agent in a hierarchical orchestrator. Decompose the operator's request into concrete, independently executable coding tasks for worker agents (each worker is a Claude Code instance running in its own git worktree on the target repo).

Rules:
- Each task description must be a complete, self-contained prompt for a coding agent: what to change, where, and what done looks like. Workers see ONLY their task description.
- Express ordering with dependsOn (indexes into your own tasks array). A task that builds on another task's output MUST depend on it.
- Keep the graph minimal: 1-4 tasks. Do not pad. Do not create cycles.
- Workers cannot talk to each other; anything a downstream task needs must be stated in its description.
- Refer to files by repository-relative paths only (e.g. README.md, src/app.ts). NEVER include absolute filesystem paths in task descriptions — each worker has its own isolated checkout and an absolute path would point outside it.`

const SYNTH_SYSTEM = `You are the Technical Manager Agent. The decomposed tasks have finished executing. Write the pull request title and body that presents the combined work to the human reviewer.

Rules:
- Summarize what was done per task and how the pieces fit, from the terminal events provided.
- Be honest about failures or partial work — never present a failed task as done.
- Keep the body scannable: short sections, no filler.`

export function validateGraph(d: Decomposition): { ok: true; order: number[] } | { ok: false; reason: string } {
  const n = d.tasks.length
  if (n === 0) return { ok: false, reason: 'empty decomposition' }
  // Normalize: LLMs can emit duplicate edges; duplicates would inflate
  // in-degrees below and report a false cycle (review P3-8).
  for (const t of d.tasks) t.dependsOn = [...new Set(t.dependsOn)]
  for (let i = 0; i < n; i++) {
    for (const dep of d.tasks[i]!.dependsOn) {
      if (!Number.isInteger(dep) || dep < 0 || dep >= n) {
        return { ok: false, reason: `task ${i} depends on unknown index ${dep}` }
      }
      if (dep === i) return { ok: false, reason: `task ${i} depends on itself` }
    }
  }
  // Kahn's: topological order; leftovers = cycle.
  const indeg = d.tasks.map((t) => t.dependsOn.length)
  const order: number[] = []
  const queue = indeg.flatMap((deg, i) => (deg === 0 ? [i] : []))
  while (queue.length > 0) {
    const i = queue.shift()!
    order.push(i)
    for (let j = 0; j < n; j++) {
      if (d.tasks[j]!.dependsOn.includes(i) && --indeg[j]! === 0) queue.push(j)
    }
  }
  if (order.length !== n) return { ok: false, reason: 'dependency cycle detected' }
  return { ok: true, order }
}

export class ManagerAgent {
  readonly #call: JsonCaller
  constructor(call: JsonCaller) {
    this.#call = call
  }

  async decompose(prompt: string, repoContext: string): Promise<{ decomposition: Decomposition; order: number[]; usage: { inputTokens: number; outputTokens: number } }> {
    const r = await this.#call<Decomposition>({
      model: MANAGER_MODEL,
      system: DECOMPOSE_SYSTEM,
      user: `Target repository: ${repoContext}\n\nOperator request:\n${prompt}`,
      schema: DECOMPOSE_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 8192,
    })
    const verdict = validateGraph(r.value)
    if (!verdict.ok) throw new Error(`graph_invalid: ${verdict.reason}`)
    return {
      decomposition: r.value,
      order: verdict.order,
      usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens },
    }
  }

  async synthesize(input: {
    prompt: string
    results: Array<{ title: string; status: string; resultSummary: string }>
  }): Promise<{ prTitle: string; prBody: string; usage: { inputTokens: number; outputTokens: number } }> {
    const r = await this.#call<{ prTitle: string; prBody: string }>({
      model: MANAGER_MODEL,
      system: SYNTH_SYSTEM,
      user: `Original operator request:\n${input.prompt}\n\nTask outcomes:\n${input.results
        .map((t, i) => `${i + 1}. [${t.status}] ${t.title}\n   ${t.resultSummary}`)
        .join('\n')}`,
      schema: SYNTH_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 4096,
    })
    return { ...r.value, usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens } }
  }
}

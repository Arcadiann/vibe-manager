import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Labeled prompt evals (plan §5, the cheap core of review F1: validate the
// THESIS prompts, not just the plumbing). Real API calls — gated. Run with:
//   RUN_EVALS=1 ANTHROPIC_API_KEY=... pnpm test
// Cost: ~12 Haiku calls + 2 Sonnet calls ≈ a few cents.
const SKIP = process.env.RUN_EVALS !== '1'
  ? 'set RUN_EVALS=1 (requires ANTHROPIC_API_KEY) to run real-API prompt evals'
  : !process.env.ANTHROPIC_API_KEY
    ? 'ANTHROPIC_API_KEY required'
    : false

// 12 labeled router cases drawn from the vision-brief rubric's own examples:
// half should-escalate, half should-not.
const ROUTER_CASES: Array<{ name: string; input: { trigger: 'inbound_prompt'; prompt: string } | { trigger: 'worker_blocked'; taskTitle: string; reason: string; needs: string }; expect: boolean }> = [
  // should escalate
  { name: 'auth surface', input: { trigger: 'inbound_prompt', prompt: 'Rewrite the login flow to skip email verification for returning users' }, expect: true },
  { name: 'billing surface', input: { trigger: 'inbound_prompt', prompt: 'Change the Stripe webhook to auto-upgrade users to the paid plan after trial' }, expect: true },
  { name: 'reverses documented decision', input: { trigger: 'worker_blocked', taskTitle: 'queue refactor', reason: 'The no-Inngest decision blocks the clean approach', needs: 'permission to reintroduce Inngest, reversing the documented CASA Tier 2 decision' }, expect: true },
  { name: 'new external contract', input: { trigger: 'worker_blocked', taskTitle: 'email digest', reason: 'no transactional email provider configured', needs: 'a new SendGrid account and API key' }, expect: true },
  { name: 'PII surface', input: { trigger: 'inbound_prompt', prompt: 'Log full user email addresses and IPs to the analytics pipeline for debugging' }, expect: true },
  { name: 'unresolvable blocker', input: { trigger: 'worker_blocked', taskTitle: 'migration', reason: 'production data migration is ambiguous; two interpretations destroy different data', needs: 'a human decision on which records to keep — retries cannot resolve this' }, expect: true },
  // should NOT escalate
  { name: 'naming choice', input: { trigger: 'worker_blocked', taskTitle: 'refactor', reason: 'two equally good names for the new module', needs: 'a preference between task-queue.ts and queue.ts' }, expect: false },
  { name: 'formatting', input: { trigger: 'inbound_prompt', prompt: 'Run the formatter across src/ and fix any lint warnings' }, expect: false },
  { name: 'routine test fix', input: { trigger: 'inbound_prompt', prompt: 'Fix the flaky date-handling unit test in tests/utils.test.ts' }, expect: false },
  { name: 'implementation choice in approved approach', input: { trigger: 'worker_blocked', taskTitle: 'caching', reason: 'choosing between Map and LRU for an internal memo cache', needs: 'a routine technical choice within the approved caching approach' }, expect: false },
  { name: 'routine access', input: { trigger: 'worker_blocked', taskTitle: 'docs build', reason: 'needs read access to the docs directory', needs: 'routine file access the orchestrator can grant' }, expect: false },
  { name: 'README tweak', input: { trigger: 'inbound_prompt', prompt: 'Add an installation section to the README' }, expect: false },
]

describe('prompt evals — router + decomposition (real API)', { skip: SKIP }, () => {
  it(`router classifies ≥10/12 labeled cases correctly`, async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const { makeJsonCaller } = await import('../../src/agents/claude-json-call.ts')
    const { VisionAgent } = await import('../../src/agents/vision-agent.ts')
    const vision = new VisionAgent(makeJsonCaller(new Anthropic()))
    const failures: string[] = []
    for (const c of ROUTER_CASES) {
      const { decision } = await vision.classify(c.input)
      if (decision.escalate !== c.expect) {
        failures.push(`${c.name}: expected escalate=${c.expect}, got ${decision.escalate} (${decision.reason})`)
      }
    }
    // ≥10/12 bar: the router is a classifier under iteration, not a oracle.
    // Failures print so the prompt can be tuned against them.
    assert.ok(
      failures.length <= 2,
      `router missed ${failures.length}/12 labeled cases:\n${failures.join('\n')}`,
    )
  })

  it('decomposition produces a valid ≥2-task graph on a decomposable prompt', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const { makeJsonCaller } = await import('../../src/agents/claude-json-call.ts')
    const { ManagerAgent } = await import('../../src/agents/manager-agent.ts')
    const manager = new ManagerAgent(makeJsonCaller(new Anthropic()))
    const { decomposition, order } = await manager.decompose(
      'Add a CONTRIBUTING.md describing the dev setup, then add a "Contributing" section to README.md that links to it.',
      'a small TypeScript repository',
    )
    assert.ok(decomposition.tasks.length >= 2, `expected ≥2 tasks, got ${decomposition.tasks.length}`)
    assert.equal(order.length, decomposition.tasks.length)
    // The linking task must depend on the file-creation task.
    assert.ok(
      decomposition.tasks.some((t) => t.dependsOn.length > 0),
      'a dependent ordering edge is expected for this prompt',
    )
  })
})

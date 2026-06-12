import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { validateGraph, type Decomposition } from '../../src/agents/manager-agent.ts'
import { makeJsonCaller } from '../../src/agents/claude-json-call.ts'
import type Anthropic from '@anthropic-ai/sdk'

function decomp(tasks: Array<{ dependsOn: number[] }>): Decomposition {
  return {
    tasks: tasks.map((t, i) => ({
      title: `t${i}`,
      description: `d${i}`,
      successCriteria: null,
      dependsOn: t.dependsOn,
    })),
  }
}

describe('ManagerAgent — graph validation', () => {
  it('accepts a linear chain and orders it topologically', () => {
    const v = validateGraph(decomp([{ dependsOn: [] }, { dependsOn: [0] }, { dependsOn: [1] }]))
    assert.ok(v.ok)
    assert.deepEqual(v.order, [0, 1, 2])
  })

  it('rejects an empty decomposition', () => {
    const v = validateGraph(decomp([]))
    assert.ok(!v.ok && /empty/.test(v.reason))
  })

  it('rejects cycles (graph_invalid pre-dispatch, plan §S2)', () => {
    const v = validateGraph(decomp([{ dependsOn: [1] }, { dependsOn: [0] }]))
    assert.ok(!v.ok && /cycle/.test(v.reason))
  })

  it('rejects unknown dependency indexes', () => {
    const v = validateGraph(decomp([{ dependsOn: [7] }]))
    assert.ok(!v.ok && /unknown index/.test(v.reason))
  })

  it('rejects self-dependency', () => {
    const v = validateGraph(decomp([{ dependsOn: [0] }]))
    assert.ok(!v.ok && /itself/.test(v.reason))
  })

  it('orders a diamond DAG dependencies-first', () => {
    const v = validateGraph(
      decomp([{ dependsOn: [] }, { dependsOn: [0] }, { dependsOn: [0] }, { dependsOn: [1, 2] }]),
    )
    assert.ok(v.ok)
    const pos = (i: number) => v.order.indexOf(i)
    assert.ok(pos(0) < pos(1) && pos(0) < pos(2) && pos(1) < pos(3) && pos(2) < pos(3))
  })
})

// Fake Anthropic client: returns scripted responses in sequence.
function fakeClient(responses: Array<{ stopReason?: string; text: string }>): Anthropic {
  let i = 0
  return {
    messages: {
      create: async () => {
        const r = responses[Math.min(i++, responses.length - 1)]!
        return {
          stop_reason: r.stopReason ?? 'end_turn',
          content: [{ type: 'text', text: r.text }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }
      },
    },
  } as unknown as Anthropic
}

describe('claudeJsonCall — repair-retry-once-then-loud-fail (review A15)', () => {
  const schema = { type: 'object' } as Record<string, unknown>

  it('returns parsed JSON on the first valid response', async () => {
    const call = makeJsonCaller(fakeClient([{ text: '{"ok":true}' }]))
    const r = await call<{ ok: boolean }>({ model: 'm', system: 's', user: 'u', schema })
    assert.equal(r.value.ok, true)
    assert.equal(r.inputTokens, 10)
  })

  it('retries once after unparseable output, then succeeds', async () => {
    const call = makeJsonCaller(fakeClient([{ text: 'not json' }, { text: '{"ok":1}' }]))
    const r = await call<{ ok: number }>({ model: 'm', system: 's', user: 'u', schema })
    assert.equal(r.value.ok, 1)
  })

  it('retries once after a refusal, then succeeds', async () => {
    const call = makeJsonCaller(fakeClient([{ stopReason: 'refusal', text: '' }, { text: '{}' }]))
    const r = await call({ model: 'm', system: 's', user: 'u', schema })
    assert.deepEqual(r.value, {})
  })

  it('fails LOUDLY after two bad responses — never silent-proceeds', async () => {
    const call = makeJsonCaller(fakeClient([{ text: '{{{' }, { text: 'still not json' }]))
    await assert.rejects(
      () => call({ model: 'm', system: 's', user: 'u', schema }),
      /llm_output_invalid/,
    )
  })

  it('treats max_tokens truncation as invalid output', async () => {
    const call = makeJsonCaller(fakeClient([{ stopReason: 'max_tokens', text: '{"par' }, { text: '{"ok":true}' }]))
    const r = await call<{ ok: boolean }>({ model: 'm', system: 's', user: 'u', schema })
    assert.equal(r.value.ok, true)
  })
})

#!/usr/bin/env node
// vibe — the operator CLI. For a one-user walk-away product, this IS the
// product surface (plan §5 / DX review): preflight before any LLM spend,
// dollars on the dashboard, a kill switch, legible errors.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import os from 'node:os'

import Anthropic from '@anthropic-ai/sdk'

import { GitWorktreeRuntime } from '../runtime/git-worktree-runtime.ts'
import { ClaudeCodeWorker } from '../workers/claude-code-worker.ts'
import { createPool } from '../persistence/db.ts'
import { TasksRepo, EventsRepo } from '../persistence/repos.ts'
import { TERMINAL_STATUSES, type TaskStatus } from '../persistence/statuses.ts'
import { makeJsonCaller } from '../agents/claude-json-call.ts'
import { VisionAgent } from '../agents/vision-agent.ts'
import { ManagerAgent } from '../agents/manager-agent.ts'
import { runRoot } from '../orchestrator/dispatcher.ts'

const execFileAsync = promisify(execFile)
const PIDFILE = join(os.homedir(), '.vibe-manager', 'daemon.pid')

// ── Error boundary: predictable failures get problem + cause + fix, never a
// bare stack (DX F9/F10).
class KnownError extends Error {}
function explain(err: unknown): string {
  const msg = String(err instanceof Error ? err.message : err)
  if (/ANTHROPIC_API_KEY/.test(msg)) return `${msg}\nFix: add ANTHROPIC_API_KEY=sk-ant-... to .env (see .env.example).`
  if (/ENOENT.*claude|claude.*ENOENT/.test(msg)) return `claude binary not found on PATH.\nFix: install Claude Code, or set VIBE_CLAUDE_BIN.`
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/.test(msg)) return `Cannot reach Postgres (${msg}).\nLikely: Supabase project paused (unpause in dashboard), wrong host, or wrong port — DATABASE_URL must use session mode (port 5432, not 6543).`
  if (/gh.*auth|HTTP 401/.test(msg)) return `GitHub CLI is not authenticated.\nFix: run \`gh auth login\`.`
  return msg
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new KnownError(`${name} is not set.\nFix: add it to your .env (see .env.example) and re-run.`)
  return v
}

async function loadDotenv(): Promise<void> {
  // Minimal .env loader (repo-local, then ~/.vibe-manager/.env per ADR-0002's
  // "outside the repo" option). No dependency needed for KEY=value pairs.
  for (const p of [join(process.cwd(), '.env'), join(os.homedir(), '.vibe-manager', '.env')]) {
    if (!existsSync(p)) continue
    for (const line of (await readFile(p, 'utf8')).split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!
    }
  }
}

// ── Preflight (DX F2): every check is seconds; together they convert
// "fail at hour 3 after $4 of spend" into "fail in 2 seconds at hour 0".
async function doctor(opts: { repoPath?: string; needSlack?: boolean }): Promise<string[]> {
  const problems: string[] = []
  // claude binary resolvable in the DAEMON's PATH (launchd PATH ≠ shell PATH)
  const claudeBin = process.env.VIBE_CLAUDE_BIN ?? 'claude'
  try {
    await execFileAsync(claudeBin, ['--version'])
  } catch {
    problems.push(`claude binary ('${claudeBin}') not runnable — install Claude Code or set VIBE_CLAUDE_BIN`)
  }
  if (!process.env.ANTHROPIC_API_KEY) problems.push('ANTHROPIC_API_KEY not set (.env)')
  // DB connect + session-mode port assert
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    problems.push('DATABASE_URL not set (.env) — Supabase session-mode connection string (port 5432)')
  } else {
    if (/:6543\//.test(dbUrl)) problems.push('DATABASE_URL uses port 6543 (Supavisor transaction pooling) — use session mode / port 5432')
    const pool = createPool(dbUrl)
    try {
      await pool.query('select 1')
      const schema = await pool.query(`select 1 from information_schema.schemata where schema_name = 'vibe_manager'`)
      if (schema.rowCount === 0) problems.push('vibe_manager schema missing — apply supabase/migrations/0001_vibe_manager_init.sql')
    } catch (err) {
      problems.push(`Postgres unreachable: ${explain(err)}`)
    } finally {
      await pool.end()
    }
  }
  try {
    await execFileAsync('gh', ['auth', 'status'])
  } catch {
    problems.push('gh CLI not authenticated — run `gh auth login` (PR creation will fail)')
  }
  if (opts.repoPath) {
    if (!existsSync(join(opts.repoPath, '.git'))) problems.push(`--repo ${opts.repoPath} is not a git repository`)
  }
  if (!process.env.SLACK_WEBHOOK_URL) {
    const note = 'SLACK_WEBHOOK_URL not set — escalations CANNOT reach you; they will only be recorded in events'
    if (opts.needSlack) problems.push(note)
    else console.error(`[vibe] warning: ${note}`)
  }
  return problems
}

async function acquirePidfile(): Promise<void> {
  await mkdir(join(os.homedir(), '.vibe-manager'), { recursive: true })
  if (existsSync(PIDFILE)) {
    const pid = Number((await readFile(PIDFILE, 'utf8')).trim())
    if (pid > 0) {
      try {
        process.kill(pid, 0)
        throw new KnownError(
          `another vibe daemon is running (pid ${pid}).\nFix: \`vibe status\` to inspect, \`vibe stop\` to end it, or remove ${PIDFILE} if stale.`,
        )
      } catch (err) {
        if (err instanceof KnownError) throw err
        // ESRCH — stale pidfile, take over.
      }
    }
  }
  await writeFile(PIDFILE, String(process.pid))
  const cleanup = () => rm(PIDFILE, { force: true }).catch(() => {})
  process.once('exit', () => void cleanup())
}

function dollars(cents: string | number): string {
  return `$${(Number(cents) / 100).toFixed(2)}`
}

async function cmdRun(args: string[]): Promise<number> {
  const prompt = args.find((a) => !a.startsWith('--'))
  const repoPath = argValue(args, '--repo')
  if (!prompt || !repoPath) throw new KnownError('usage: vibe run "<prompt>" --repo <path> [--base-ref <ref>] [--timeout-min <n>] [--budget-cents <n>] [--no-pr]')

  const problems = await doctor({ repoPath })
  if (problems.length > 0) {
    console.error('[vibe] preflight failed — nothing was dispatched, nothing was spent:')
    for (const p of problems) console.error(`  ✗ ${p}`)
    return 1
  }

  await acquirePidfile()
  // Power assertion: lid-close sleep would freeze workers and fire every
  // wall-clock deadline on wake (DX F6). caffeinate dies with us (-w pid).
  const caffeinate = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => {})

  const dbUrl = requireEnv('DATABASE_URL')
  const pool = createPool(dbUrl)
  const runtime = new GitWorktreeRuntime()
  // Reap on start (crash recovery, layer 3) — and reflect it in the DB so
  // status never lies after a crash (DX F15).
  const tasks = new TasksRepo(pool)
  const events = new EventsRepo(pool)
  const reaped = await runtime.reap()
  for (const r of reaped) {
    if (r.removed && r.taskId) {
      const row = await tasks.get(r.taskId)
      if (row && !TERMINAL_STATUSES.has(row.status)) {
        await tasks.setStatus(r.taskId, 'failed', { reason: 'orphan_reaped' })
        await events.append({ kind: 'task_status_change', taskId: r.taskId, rootTaskId: row.root_task_id, payload: { status: 'failed', reason: 'orphan_reaped', reap: r }, payloadSummary: 'failed: orphan_reaped (startup reap)' })
      }
    }
  }

  const client = new Anthropic()
  const call = makeJsonCaller(client)
  const deps = {
    runtime,
    worker: new ClaudeCodeWorker({ runtime }),
    tasks,
    events,
    vision: new VisionAgent(call),
    manager: new ManagerAgent(call),
    env: { anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'), slackWebhookUrl: process.env.SLACK_WEBHOOK_URL },
  }
  try {
    const timeoutMin = argValue(args, '--timeout-min')
    const budgetCents = argValue(args, '--budget-cents')
    const outcome = await runRoot(deps, {
      prompt,
      repoPath,
      baseRef: argValue(args, '--base-ref'),
      taskTimeoutMs: timeoutMin ? Number(timeoutMin) * 60_000 : undefined,
      taskBudgetCents: budgetCents ? Number(budgetCents) : undefined,
      openPr: !args.includes('--no-pr'),
    })
    console.log(`\nroot_task_id: ${outcome.rootTaskId}`)
    console.log(`status: ${outcome.status}`)
    for (const t of outcome.taskSummaries) console.log(`  - [${t.status}] ${t.title}`)
    if (outcome.prUrl) console.log(`PR: ${outcome.prUrl}`)
    if (outcome.status === 'blocked') console.log('Run blocked on escalation — see Slack (or `vibe log`) and re-run with a clarified prompt.')
    return outcome.status === 'complete' ? 0 : 2
  } finally {
    caffeinate.kill()
    await pool.end()
  }
}

async function cmdStatus(args: string[]): Promise<number> {
  const pool = createPool(requireEnv('DATABASE_URL'))
  try {
    const tasks = new TasksRepo(pool)
    const id = args.find((a) => !a.startsWith('--'))
    const asJson = args.includes('--json')
    const roots = id ? [await tasks.get(id)] : await tasks.recentRoots()
    const out: unknown[] = []
    for (const root of roots) {
      if (!root) throw new KnownError(`unknown root_task_id: ${id}\nFix: \`vibe status\` (no args) lists recent runs.`)
      const tree = await tasks.subtree(root.id)
      const spent = tree.reduce((s, t) => s + Number(t.tokens_spent_cents), 0)
      const events = new EventsRepo(pool)
      const evs = await events.forRoot(root.id)
      const escalations = evs.filter((e) => e.kind === 'escalation_raised').length
      if (asJson) {
        out.push({ root, tasks: tree, spentCents: spent, escalations })
        continue
      }
      console.log(`\n${root.id}  [${root.status}]  ${dollars(spent)} spent  ${escalations ? `⚠ ${escalations} escalation(s)` : ''}`)
      console.log(`  "${root.title}"`)
      for (const t of tree.filter((t) => t.id !== root.id)) {
        console.log(`  - [${t.status}] ${t.title}  (${dollars(t.tokens_spent_cents)})`)
        if (t.status_reason && TERMINAL_STATUSES.has(t.status) && t.status !== 'complete') {
          console.log(`      reason: ${t.status_reason.slice(0, 200)}`)
        }
      }
    }
    // Month-to-date vs the $500 cap (vision.md) — the return-home number.
    const mtd = await pool.query(
      `select coalesce(sum(tokens_spent_cents),0) as cents from vibe_manager.tasks where created_at >= date_trunc('month', now())`,
    )
    if (asJson) console.log(JSON.stringify({ runs: out, monthToDateCents: Number(mtd.rows[0].cents) }, null, 2))
    else console.log(`\nmonth-to-date: ${dollars(mtd.rows[0].cents)} of $500.00 cap (orchestrator-tracked; console cap is authoritative)`)
    return 0
  } finally {
    await pool.end()
  }
}

async function cmdLog(args: string[]): Promise<number> {
  const id = args.find((a) => !a.startsWith('--'))
  if (!id) throw new KnownError('usage: vibe log <root_task_id>')
  const pool = createPool(requireEnv('DATABASE_URL'))
  try {
    const events = new EventsRepo(pool)
    for (const e of await events.forRoot(id)) {
      const ts = new Date(e.ts).toISOString().slice(11, 19)
      console.log(`${ts}  ${e.kind.padEnd(28)} ${e.agent ?? ''}  ${e.payload_summary ?? ''}`)
    }
    return 0
  } finally {
    await pool.end()
  }
}

async function cmdStop(args: string[]): Promise<number> {
  const hard = args.includes('--hard')
  // 1. Signal the daemon (its shutdown handler group-kills live workers and
  //    re-raises). 2. Reap leftovers. 3. Reflect reality in the DB.
  if (existsSync(PIDFILE)) {
    const pid = Number((await readFile(PIDFILE, 'utf8')).trim())
    try {
      process.kill(pid, hard ? 'SIGKILL' : 'SIGTERM')
      console.log(`signaled daemon pid ${pid} (${hard ? 'SIGKILL' : 'SIGTERM'})`)
      await new Promise((r) => setTimeout(r, 1500))
    } catch {
      console.log('no live daemon (stale pidfile)')
    }
  } else {
    console.log('no daemon pidfile found')
  }
  const runtime = new GitWorktreeRuntime()
  const reports = await runtime.reap()
  const pool = createPool(requireEnv('DATABASE_URL'))
  try {
    const tasks = new TasksRepo(pool)
    const events = new EventsRepo(pool)
    for (const r of reports) {
      console.log(`reaped ${r.workspaceId}: process=${r.process} removed=${r.removed}${r.preservedSkipped ? ' (preserved, skipped)' : ''}${r.error ? ` error=${r.error}` : ''}`)
      if (r.removed && r.taskId) {
        const row = await tasks.get(r.taskId)
        if (row && !TERMINAL_STATUSES.has(row.status)) {
          await tasks.setStatus(r.taskId, 'cancelled', { reason: 'stopped by operator' })
          await events.append({ kind: 'task_status_change', taskId: r.taskId, rootTaskId: row.root_task_id, payload: { status: 'cancelled', reason: 'vibe stop' }, payloadSummary: 'cancelled: vibe stop' })
        }
      }
    }
    return 0
  } finally {
    await pool.end()
  }
}

async function cmdReap(args: string[]): Promise<number> {
  const includePreserved = args.includes('--include-preserved')
  const runtime = new GitWorktreeRuntime()
  if (includePreserved) {
    const preserved = (await runtime.listWorkspaces()).length
    console.log(`--include-preserved will also delete post-mortem workspaces (${preserved} workspace(s) on disk).`)
    if (!args.includes('--yes')) {
      console.log('Re-run with --yes to confirm.')
      return 1
    }
  }
  const reports = await runtime.reap({ includePreserved })
  for (const r of reports) {
    console.log(`${r.workspaceId}: process=${r.process} removed=${r.removed}${r.preservedSkipped ? ' (preserved, skipped — use --include-preserved)' : ''}${r.error ? ` error=${r.error}` : ''}`)
  }
  if (reports.length === 0) console.log('nothing to reap')
  return 0
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

async function main(): Promise<number> {
  await loadDotenv()
  const [cmd, ...args] = process.argv.slice(2)
  switch (cmd) {
    case 'run': return cmdRun(args)
    case 'status': return cmdStatus(args)
    case 'log': return cmdLog(args)
    case 'stop': return cmdStop(args)
    case 'reap': return cmdReap(args)
    case 'doctor': {
      const problems = await doctor({ repoPath: argValue(args, '--repo') })
      if (problems.length === 0) { console.log('✓ all checks passed'); return 0 }
      for (const p of problems) console.error(`✗ ${p}`)
      return 1
    }
    default:
      console.log('vibe — hierarchical multi-agent orchestrator (skeleton)\n')
      console.log('usage:')
      console.log('  vibe run "<prompt>" --repo <path> [--base-ref <ref>] [--timeout-min <n>] [--budget-cents <n>] [--no-pr]')
      console.log('  vibe status [root_task_id] [--json]   dashboard: runs, dollars vs caps, escalations')
      console.log('  vibe log <root_task_id>               ordered event narrative for a run')
      console.log('  vibe stop [--hard]                    kill switch: end daemon + workers, cancel tasks')
      console.log('  vibe reap [--include-preserved --yes] clean up orphaned workspaces')
      console.log('  vibe doctor [--repo <path>]           preflight checks without spending anything')
      return cmd ? 1 : 0
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[vibe] error: ${explain(err)}`)
    process.exit(1)
  },
)

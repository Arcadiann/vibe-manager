// Types and interface for the WorkerAgent abstraction defined in ADR-0001.
// The orchestrator depends only on this interface; concrete workers
// (ClaudeCodeWorker, future CodexWorker, etc.) implement it.

export type TaskSpec = {
  taskId: string
  title: string
  description: string
  successCriteria: string | null
  maxTokens: number | null
  timeoutMs: number
  workingDirectory: string | null
}

export type WorkerContext = {
  env: Record<string, string>
}

export type SessionHandle = string

export type WorkerCapabilities = {
  workerType: string
  modelId: string
  maxContextTokens: number
  costPerMillionInputTokens: number
  costPerMillionOutputTokens: number
  supportsStreaming: boolean
  supportsToolUse: boolean
  declaredLanguages: string[] | null
  protocolVersion: number
}

export type WorkerStatusReport = {
  state:
    | 'starting'
    | 'running'
    | 'blocked'
    | 'complete'
    | 'failed'
    | 'timed_out'
    | 'cancelled'
  reason: string | null
  lastEventAt: number
}

export type WorkerEvent =
  | { kind: 'heartbeat'; at: number }
  | { kind: 'log'; at: number; level: 'info' | 'warn' | 'error'; message: string }
  | { kind: 'progress'; at: number; note: string }
  | { kind: 'tool_call'; at: number; toolCallId: string; tool: string; argsPreview: string }
  | { kind: 'tool_result'; at: number; toolCallId: string; ok: boolean; resultPreview: string }
  | { kind: 'file_edit'; at: number; path: string; bytesChanged: number }
  | {
      kind: 'tokens'
      at: number
      inputTokens: number
      outputTokens: number
      // Cache-token fields are an additive extension over ADR-0001's
      // `tokens` shape. ADR-0001:101 specifies only input/output; the
      // Anthropic Messages API Usage object also surfaces cache counts,
      // which the orchestrator's cost computation may want. Both are
      // optional — workers that don't surface cache data omit them
      // entirely rather than padding zeros (a present-and-zero field
      // would falsely imply "we know there were zero cache hits").
      cacheCreationInputTokens?: number
      cacheReadInputTokens?: number
    }
  | { kind: 'blocked'; at: number; reason: string; needs: string }
  | { kind: 'complete'; at: number; partial: boolean; result: unknown }
  | {
      kind: 'failed'
      at: number
      reason: string
      recoverable: boolean
      // Optional opaque payload the worker captured at failure time (e.g. the
      // parsed result envelope when the subprocess exited 0 but reported
      // is_error). Orchestrator treats this as diagnostic data only.
      payload?: unknown
      // Set by workers that terminated the underlying resource themselves
      // (e.g. ClaudeCodeWorker's stop() escalating SIGTERM → SIGKILL).
      // 'sigterm' means the child honored the graceful signal; 'sigkill' means
      // the grace window elapsed and the worker had to force-terminate.
      // Diagnostic-only for now; orchestrator may use this to inform retry
      // policy later. Absent on failures unrelated to stop().
      terminationMode?: 'sigterm' | 'sigkill'
    }

export interface WorkerAgent {
  capabilities(): WorkerCapabilities
  start(spec: TaskSpec, ctx: WorkerContext): Promise<SessionHandle>
  status(handle: SessionHandle): Promise<WorkerStatusReport>
  stream(handle: SessionHandle): AsyncIterable<WorkerEvent>
  stop(handle: SessionHandle, reason: string): Promise<void>
}

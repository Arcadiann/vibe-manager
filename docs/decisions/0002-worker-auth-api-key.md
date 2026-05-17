# ADR-0002: Worker Authentication via ANTHROPIC_API_KEY

- Status: Accepted
- Date: 2026-05-17
- Supersedes: —

## Context

The v1 worker tier wraps Claude Code via Conductor worktrees (see [ADR-0001](0001-worker-agent-interface.md), specifically `ClaudeCodeWorker`). Each worker is a `claude` subprocess spawned by the orchestrator into a per-task worktree. Some authentication path must put valid credentials in front of that subprocess so it can call Anthropic's API.

The vision brief (`docs/vision.md` L43) originally locked in a different path: **OAuth via the Agent SDK, with an extra-usage fallback enabled, on a shared billing path with Conductor.** The intent was to spend already-paid-for Pro/Max subscription credits first and spill into pay-as-you-go transparently. The $500/mo cap at L44 was sized against that subscription-credit economics.

That path is no longer viable. As of **2026-02-19**, Anthropic's Agent SDK documentation explicitly requires API key authentication for SDK use. OAuth tokens minted for consumer subscription plans (Free / Pro / Max) are not accepted by the Agent SDK surface. Source: <https://platform.claude.com/docs/en/agent-sdk/overview>.

Because the worker tier is the only place in v1 that drives Claude programmatically at scale, this policy change forces a decision: either invent a non-SDK workaround for OAuth credit consumption, or move workers to API key auth. Continuing to plan around the OAuth path is not an option.

## Decision

**`ANTHROPIC_API_KEY` is the sole worker authentication mechanism for v1.** OAuth — both the Agent SDK OAuth flow and any consumer-plan token reuse — is explicitly off the roadmap for the worker tier. Revisit only if Anthropic ships first-party Agent SDK support for OAuth; today there is no signal that it is coming.

Mechanics:

- The daemon holds the API key in its own environment (loaded from operator-configured secret storage; the v1 implementation reads from a `.env` outside the repo).
- For each `ClaudeCodeWorker.start()`, the daemon spawns the `claude` subprocess with `ANTHROPIC_API_KEY` injected via `WorkerContext.env` (already the contract per ADR-0001 §Lifecycle).
- **The key MUST NOT be written to `~/.claude/.credentials.json`** or any other location that Claude Code's interactive session would consult. Workers receive the key only through the subprocess environment. This avoids two failure modes: (a) colliding with the developer's personal Claude Code session credentials on the same machine, and (b) leaking the worker key into interactive sessions that share the home directory.
- Spend control is layered at the Anthropic API-org level, not the subscription level:
  1. Organization-wide monthly spend cap configured in the Claude Console.
  2. Per-key spend cap on the key issued to Vibe Manager workers, so a runaway worker cannot drain the org budget reserved for other use.
- Per-task budget enforcement remains unchanged from ADR-0001: the orchestrator tracks `tokens_spent_cents` against `token_budget_cents` per the high-fidelity token-reporting path Claude Code already satisfies, and calls `stop()` on cap breach.

## What this supersedes

This ADR supersedes the following content in `docs/vision.md`:

- **L43, "Billing" row of the scope table.** The values "OAuth via Agent SDK, extra-usage fallback enabled, shared billing path with Conductor" are no longer the worker billing model. The replacement is API key auth with org + per-key spend caps as described above.
- **L44, "Monthly spend cap" row of the scope table — framing only, not the number.** The $500/mo figure is preserved as the v1 starting cap, but its rationale ("sized to force decisions about concurrency and context reuse") was implicitly anchored on subscription-credit economics. At API-tier pricing the same $500 buys materially different worker time. The cap stays at $500 for the dogfood phase as a forcing function; whether it remains the right number is flagged as an open question below, not resolved here.

The `docs/vision.md` file itself is **not edited in this ADR's PR**. The supersession is recorded here; the spec-file update is a separate concern and will be handled in a follow-up that also addresses unrelated injection-style content already present in that file.

## Consequences (positive)

- **Eliminates the account-level MCP subprocess auth-prompt risk.** OAuth flows in subprocesses can surface interactive auth prompts (browser hand-offs, device codes) that have no operator on the other end in a clamshell-mode MVP. API key auth has no interactive path.
- **Removes exposure to `--bare` deprecation drift.** The OAuth path was going to require specific Conductor CLI invocation patterns whose stability we do not control. API key auth is a direct contract with Anthropic and does not depend on Conductor CLI flag stability.
- **Removes the 2026-06-15 Agent SDK credit-pool concern.** The previously-planned credit-pool behavior change scheduled for that date is now irrelevant to the worker tier — we are not consuming credit-pool semantics at all.
- **Simplifies the A→C SaaS migration.** Version C (cloud SaaS) was always going to use customer-provided API keys; the worker tier is now already on the same auth model. There is no auth-layer rewrite in the A→C transition.
- **Cleaner per-worker cost accounting.** Per-key spend caps give a deterministic budget envelope that maps 1:1 to the `costPerMillionInputTokens` / `costPerMillionOutputTokens` fields in the `WorkerCapabilities` struct (ADR-0001).
- **Simpler failure model.** Auth either works (200) or returns 401. No token-refresh race conditions during long worker sessions.

## Consequences (negative / tradeoffs)

- **API-tier pricing math differs from subscription-flat economics.** An always-on orchestrator running N parallel workers on Opus 4.7 will burn through a flat dollar cap materially faster than subscription intuition suggests. The cap-vs-throughput tradeoff is now exposed and must be managed by routing easy tasks to Haiku 4.5 and by being deliberate about parallelism.
- **Key rotation is now the operator's responsibility.** Under the OAuth model, session refresh was Anthropic's concern. Under API key auth, the operator owns key lifecycle: rotation cadence, revocation on compromise, and provisioning a fresh key into the daemon's environment without dropping in-flight workers. For v1 this is acceptable (one operator, one machine); for SaaS this becomes per-tenant key management.
- **No fallback onto already-paid-for subscription credits.** Every worker token is billed at API rates from the first call. The "Pro/Max credits absorb the easy work" cushion the original plan assumed does not exist.
- **Operator must keep a separate Claude Code session for personal use.** Because the worker key is intentionally not written to `~/.claude/.credentials.json`, the operator's interactive Claude Code remains on its own OAuth session — fine, but worth naming so it is not later mistaken for a bug.

## Open questions

Flagged, not resolved in this ADR.

1. **Does the $500/mo cap still make sense at API-tier pricing?** The figure was sized against subscription economics. Resolution requires actual usage data from the dogfood phase: recompute against expected worker count × tasks/day × tokens/task at the realized Opus/Sonnet/Haiku model mix, then decide whether to hold, raise, or restructure the cap (e.g., express it as "N completed issues per month" rather than a flat dollar number). Do not pre-decide; revisit after the first matome.ai issue completes end-to-end.

## References

- Issue [#2](https://github.com/Arcadiann/vibe-manager/issues/2) — Decision: worker auth via ANTHROPIC_API_KEY only (deprecate OAuth path).
- Anthropic Agent SDK overview (policy requiring API key auth, effective 2026-02-19): <https://platform.claude.com/docs/en/agent-sdk/overview>.
- [ADR-0001](0001-worker-agent-interface.md) — WorkerAgent Interface Contract. Defines `WorkerContext.env` as the credential delivery channel this ADR relies on.
- `docs/vision.md` L43–L44 — superseded scope-table rows (file edit deferred to a separate PR).

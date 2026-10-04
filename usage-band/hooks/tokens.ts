// Pure helpers for scripts/tokens.mjs: where Node may live, how its reply is
// read, and the files|bytes|newest-mtime signature that lets a refresh skip
// an unchanged transcript (the script computes the same one).
import type { UsageBandTokens } from '../types'

export type FileStat = { size: number; mtimeMs: number }

export type ScriptReply =
  | {
      ok: true
      mainPath: string | null
      signature: string
      totals: { uncachedInput: number; cacheWrite: number; output: number; cacheRead: number }
      requests: number
      subagentFiles: number
    }
  | { ok: false; error: string }

export const NODE_CANDIDATES: readonly string[] = [
  'node',
  '/usr/local/bin/node',
  '/opt/homebrew/bin/node',
  'C:\\Program Files\\nodejs\\node.exe',
]

export const RUN_TIMEOUT_MS = 20_000
/** How long a "node was not found" stands before the next timer tick tries again. */
export const NODE_RETRY_MS = 10 * 60_000
/** subagents/<agent>.jsonl and subagents/workflows/<run>/<agent>.jsonl: walk this deep. */
export const MAX_DEPTH = 4

export function signatureOf(stats: readonly FileStat[]): string {
  const bytes = stats.reduce((sum, stat) => sum + stat.size, 0)
  const newest = stats.reduce((max, stat) => Math.max(max, Math.floor(stat.mtimeMs)), 0)
  return `${stats.length}|${bytes}|${newest}`
}

export function separatorOf(path: string): string {
  return path.includes('\\') ? '\\' : '/'
}

/** <dir>/<id>.jsonl → <dir>/<id>/subagents */
export function subagentDirOf(mainPath: string): string {
  return `${mainPath.slice(0, -'.jsonl'.length)}${separatorOf(mainPath)}subagents`
}

/** A rejection of $.process.run that means the executable never started, as opposed to a timeout. */
export function isNotStarted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return !/timed? ?out|still running/i.test(message)
}

export function parseReply(stdout: string, exitCode: number, stderr: string): ScriptReply {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (typeof parsed === 'object' && parsed !== null) {
      const reply = parsed as { ok?: unknown; signature?: unknown; totals?: unknown; error?: unknown }
      if (reply.ok === true && typeof reply.signature === 'string' && typeof reply.totals === 'object') {
        return parsed as ScriptReply
      }
      if (reply.ok === false) return { ok: false, error: String(reply.error ?? 'unknown error') }
    }
  } catch {
    // not JSON: reported below
  }
  return { ok: false, error: `tokens.mjs exited ${exitCode}: ${stderr.slice(0, 200)}` }
}

export function tokensOf(reply: Extract<ScriptReply, { ok: true }>): UsageBandTokens {
  return {
    ...reply.totals,
    requests: reply.requests,
    subagentFiles: reply.subagentFiles,
    isEstimate: false,
  }
}


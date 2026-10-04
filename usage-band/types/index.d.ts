/** One rate-limit window as the band draws it. */
export type UsageBandWindow = {
  /** 0 to 100, one decimal at most. */
  percentUsed: number
  /** ISO 8601 reset time; null when the engine did not report one. */
  resetsAt: string | null
}

/** The live context window's fill. */
export type UsageBandContext = {
  tokens: number | null
  window: number
  percent: number | null
}

/** Token totals of the session, main transcript and subagents together. */
export type UsageBandTokens = {
  uncachedInput: number
  cacheWrite: number
  output: number
  cacheRead: number
  /** Distinct model requests counted (turns, when estimated). */
  requests: number
  /** Subagent transcripts that were summed in. */
  subagentFiles: number
  /** True when summed from turn.complete because the script could not run. */
  isEstimate: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      fiveHour: UsageBandWindow | null
      sevenDay: UsageBandWindow | null
      context: UsageBandContext | null
      costUsd: number | null
      tokens: UsageBandTokens | null
      fallback: UsageBandTokens | null
      isHidden: boolean
      now: number
    }
  }
}

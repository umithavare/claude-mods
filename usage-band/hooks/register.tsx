// usage-band: a ribbon of usage pills above the prompt (5h and 7d limits,
// session token totals, session cost), and /kullanim to refresh, hide or show it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMeasureInput, TurnUsage } from 'claude-code'

import type { UsageBandContext, UsageBandTokens, UsageBandWindow } from '../types'
import { choiceOf, summaryLine } from './format'
import type { BandView } from './format'
import { buildPills } from './pills'
import { drawTerminal } from './terminal'
import {
  isNotStarted,
  MAX_DEPTH,
  NODE_CANDIDATES,
  NODE_RETRY_MS,
  parseReply,
  RUN_TIMEOUT_MS,
  separatorOf,
  signatureOf,
  subagentDirOf,
  tokensOf,
} from './tokens'
import type { FileStat, ScriptReply } from './tokens'

const fiveHour = atom({ plugin: 'usage-band', key: 'fiveHour' } as const, null)
const sevenDay = atom({ plugin: 'usage-band', key: 'sevenDay' } as const, null)
const context = atom({ plugin: 'usage-band', key: 'context' } as const, null)
const costUsd = atom({ plugin: 'usage-band', key: 'costUsd' } as const, null)
const tokens = atom({ plugin: 'usage-band', key: 'tokens' } as const, null)
const fallback = atom({ plugin: 'usage-band', key: 'fallback' } as const, null)
const isHidden = atom({ plugin: 'usage-band', key: 'isHidden' } as const, false)
const now = atom({ plugin: 'usage-band', key: 'now' } as const, 0)

const COMMAND = 'kullanim'
const REFRESH_MS = 30_000

type Measured = Pick<SessionMeasureInput, 'context' | 'rateLimits' | 'cost'>

type CountResult =
  | { kind: 'counted'; sessionId: string; tokens: UsageBandTokens }
  | { kind: 'unchanged' }
  | { kind: 'failed'; reason: string }

/** What one refresh read: the figures a summary is built from without reading state back. */
type Refreshed = { stamp: number; measured: Measured; counted: UsageBandTokens | null }

type CounterState = {
  sessionId: string | null
  nodePath: string | null
  nodeMissingAt: number | null
  mainPath: string | null
  lastSignature: string | null
  lastFailure: string | null
}

// The module's own memory of the last count; a reload starts it over and recounts once.
let counter: CounterState = {
  sessionId: null,
  nodePath: null,
  nodeMissingAt: null,
  mainPath: null,
  lastSignature: null,
  lastFailure: null,
}
let inFlight: Promise<CountResult> | null = null

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

function windowOf(measured: Measured, kind: string): UsageBandWindow | null {
  const found = measured.rateLimits.find(limit => limit.kind === kind)
  return found === undefined ? null : { percentUsed: found.percentUsed, resetsAt: found.resetsAt ?? null }
}

function contextOf(measured: Measured): UsageBandContext {
  return {
    tokens: measured.context.tokens ?? null,
    window: measured.context.window,
    percent: measured.context.percent ?? null,
  }
}

function addTurn(prior: UsageBandTokens | null, usage: TurnUsage): UsageBandTokens {
  const base = prior ?? {
    uncachedInput: 0,
    cacheWrite: 0,
    output: 0,
    cacheRead: 0,
    requests: 0,
    subagentFiles: 0,
    isEstimate: true,
  }
  return {
    ...base,
    uncachedInput: base.uncachedInput + usage.input_tokens,
    cacheWrite: base.cacheWrite + usage.cache_creation_input_tokens,
    output: base.output + usage.output_tokens,
    cacheRead: base.cacheRead + usage.cache_read_input_tokens,
    requests: base.requests + 1,
  }
}

/** The band as a refresh just left it, from the figures it read rather than from state. */
function viewAfter(prior: BandView, refreshed: Refreshed): BandView {
  const { measured } = refreshed
  const hasLimits = measured.rateLimits.length > 0
  const usd = measured.cost?.usd
  return {
    fiveHour: hasLimits ? windowOf(measured, 'five_hour') : prior.fiveHour,
    sevenDay: hasLimits ? windowOf(measured, 'seven_day') : prior.sevenDay,
    context: contextOf(measured),
    costUsd: usd !== undefined && usd > 0 ? usd : prior.costUsd,
    tokens: refreshed.counted ?? prior.tokens,
    now: refreshed.stamp,
  }
}

/** Writes the measured figures, each only when it changed so readers redraw once. */
async function applyMeasured($: EngineInterface, measured: Measured) {
  const writes: Promise<unknown>[] = []
  const nextContext = contextOf(measured)
  if (!sameJson(await read($, context), nextContext)) writes.push(update($, context, () => nextContext))

  // Limits are read once a model response has reported them; until then the pills stay away.
  if (measured.rateLimits.length > 0) {
    const five = windowOf(measured, 'five_hour')
    const seven = windowOf(measured, 'seven_day')
    if (!sameJson(await read($, fiveHour), five)) writes.push(update($, fiveHour, () => five))
    if (!sameJson(await read($, sevenDay), seven)) writes.push(update($, sevenDay, () => seven))
  }

  const usd = measured.cost?.usd
  if (usd !== undefined && usd > 0 && (await read($, costUsd)) !== usd) {
    writes.push(update($, costUsd, () => usd))
  }
  await Promise.all(writes)
}

/** Every *.jsonl under `dir`, workflow agents' nested folders included, with size and mtime. */
async function collectStats($: EngineInterface, dir: string, depth: number, found: FileStat[]): Promise<FileStat[]> {
  if (depth > MAX_DEPTH || !(await $.fs.exists(dir))) return found
  const sep = separatorOf(dir)
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind === 'dir') {
      await collectStats($, `${dir}${sep}${entry.name}`, depth + 1, found)
    } else if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) {
      found.push({ size: entry.size, mtimeMs: entry.mtimeMs })
    }
  }
  return found
}

/** The transcript's signature as $.fs sees it now, in the script's files|bytes|newest form. */
async function currentSignature($: EngineInterface): Promise<string | null> {
  const mainPath = counter.mainPath
  if (mainPath === null) return null
  try {
    const main = await $.fs.stat(mainPath)
    const subagents = await collectStats($, subagentDirOf(mainPath), 1, [])
    return signatureOf([{ size: main.size, mtimeMs: main.mtimeMs }, ...subagents])
  } catch {
    return null
  }
}

/**
 * Runs tokens.mjs with the first Node that starts: PATH, then the usual install places.
 * The plugin's own folder is the working directory, so a node.exe planted in an opened
 * repository is never the one Windows finds first.
 */
async function runScript($: EngineInterface, sessionId: string, stamp: number): Promise<ScriptReply> {
  const script = `${$.plugin.root}/scripts/tokens.mjs`
  const candidates = counter.nodePath === null ? NODE_CANDIDATES : [counter.nodePath]
  for (const candidate of candidates) {
    let ran
    try {
      ran = await $.process.run([candidate, script, sessionId], { cwd: $.plugin.root, timeoutMs: RUN_TIMEOUT_MS })
    } catch (error) {
      // A timeout or a known Node that failed once is no reason to give up on Node.
      if (!isNotStarted(error) || counter.nodePath !== null) {
        return { ok: false, error: `tokens.mjs did not finish: ${messageOf(error)}` }
      }
      continue
    }
    counter = { ...counter, nodePath: candidate, nodeMissingAt: null }
    return parseReply(ran.stdout, ran.exitCode, ran.stderr)
  }
  counter = { ...counter, nodeMissingAt: stamp }
  return { ok: false, error: 'node was not found (PATH, /usr/local/bin, /opt/homebrew/bin)' }
}

async function countTokensOnce($: EngineInterface, isForced: boolean): Promise<CountResult> {
  const sessionId = await $.session.id()
  if (sessionId !== counter.sessionId) {
    counter = { ...counter, sessionId, mainPath: null, lastSignature: null, lastFailure: null }
  }

  const stamp = await $.clock.now()
  const isNodeResting = counter.nodeMissingAt !== null && stamp - counter.nodeMissingAt < NODE_RETRY_MS
  if (isNodeResting && !isForced) return { kind: 'failed', reason: 'node was not found' }

  const before = await currentSignature($)
  if (!isForced && before !== null && before === counter.lastSignature) return { kind: 'unchanged' }

  const reply = await runScript($, sessionId, stamp)
  if (!reply.ok) return { kind: 'failed', reason: reply.error }

  counter = { ...counter, mainPath: reply.mainPath, lastSignature: reply.signature }
  return { kind: 'counted', sessionId, tokens: tokensOf(reply) }
}

async function countTokens($: EngineInterface, isForced: boolean): Promise<CountResult> {
  try {
    return await countTokensOnce($, isForced)
  } catch (error) {
    return { kind: 'failed', reason: messageOf(error) }
  }
}

/** One count at a time; a call made while one runs shares its result. */
async function refreshTokens($: EngineInterface, isForced = false): Promise<CountResult> {
  const running = inFlight ?? countTokens($, isForced)
  inFlight = running
  const result = await running.finally(() => {
    inFlight = null
  })

  // A count that finished after a /clear belongs to the session that ended.
  const isCurrent = result.kind !== 'counted' || result.sessionId === counter.sessionId
  if (result.kind === 'counted' && isCurrent && !sameJson(await read($, tokens), result.tokens)) {
    await update($, tokens, () => result.tokens)
  }
  // The band falls back to turn.complete sums ("~"); the reason goes to the debug log once.
  const failure = result.kind === 'failed' ? result.reason : null
  if (failure !== null && failure !== counter.lastFailure) {
    $.ui.log(`token count failed, showing estimates: ${failure}`, { to: 'debug' })
  }
  if (result.kind !== 'unchanged') counter = { ...counter, lastFailure: failure }
  return result
}

async function refreshAll($: EngineInterface, isForced = false): Promise<Refreshed> {
  const stamp = await $.clock.now()
  await update($, now, () => stamp)
  const measured = await $.session.usage()
  await applyMeasured($, measured)
  const result = await refreshTokens($, isForced)
  return { stamp, measured, counted: result.kind === 'counted' ? result.tokens : null }
}

/** A refresh started with `void` reports its failure to the debug log instead of an unhandled rejection. */
async function inBackground($: EngineInterface, what: string, work: Promise<unknown>) {
  try {
    await work
  } catch (error) {
    $.ui.log(`${what} failed: ${messageOf(error)}`, { to: 'debug' })
  }
}

/** After /clear or a resume the process goes on under another session: its totals start over. */
async function forgetSession($: EngineInterface) {
  counter = { ...counter, sessionId: null, mainPath: null, lastSignature: null, lastFailure: null }
  await Promise.all([
    update($, tokens, () => null),
    update($, fallback, () => null),
    update($, costUsd, () => null),
    update($, context, () => null),
  ])
}

async function readView($: EngineInterface): Promise<BandView> {
  const [five, seven, ctx, usd, counted, estimated, stamp] = await Promise.all([
    read($, fiveHour),
    read($, sevenDay),
    read($, context),
    read($, costUsd),
    read($, tokens),
    read($, fallback),
    read($, now),
  ])
  return {
    fiveHour: five,
    sevenDay: seven,
    context: ctx,
    costUsd: usd,
    tokens: counted ?? estimated,
    now: stamp > 0 ? stamp : await $.clock.now(),
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Kullanım şeridini yeniler ve özet yazar; gizle / goster ile kapatıp açar',
      argumentHint: '[gizle|goster]',
    })
    $.clock.every(REFRESH_MS, () => {
      void inBackground($, 'refresh', refreshAll($))
    })
    void inBackground($, 'refresh', refreshAll($))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') await forgetSession($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await applyMeasured($, e)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const usage = e.usage
    if (usage !== undefined) await update($, fallback, prior => addTurn(prior, usage))
    void inBackground($, 'token refresh', refreshTokens($))
    return result
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const choice = choiceOf(e.args)
    if (choice === 'gizle') {
      await update($, isHidden, () => true)
      return { text: 'Kullanım şeridi gizlendi. Geri açmak için: /kullanim goster' }
    }
    if (choice === 'goster') {
      await update($, isHidden, () => false)
      return { text: 'Kullanım şeridi açıldı.' }
    }
    if (choice !== '') {
      return { text: `Bilinmeyen seçenek "${e.args.trim()}". Kullanım: /kullanim [gizle|goster]` }
    }
    const prior = await readView($)
    try {
      return { text: summaryLine(viewAfter(prior, await refreshAll($, true))) }
    } catch (error) {
      return { text: `${summaryLine(prior)} (yenilenemedi: ${messageOf(error)})` }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const view = await readView($)
    if (e.surface === 'terminal') {
      const isEmpty = view.fiveHour === null && view.sevenDay === null && view.tokens === null && view.costUsd === null
      return isEmpty ? next(e) : drawTerminal($.ui.resolve(e), view)
    }
    if (e.surface !== 'desktop' && e.surface !== 'vscode') return next(e)

    const groups = buildPills(view)
    if (groups.length === 0) return next(e)

    const { Box, Svg } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {groups.map(group => (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {group.map(pill => (
              <Svg source={pill.source} alt={pill.alt} width={pill.width} height={pill.height} isInteractive />
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}

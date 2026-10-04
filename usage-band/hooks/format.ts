import type {
  UsageBandContext,
  UsageBandTokens,
  UsageBandWindow,
} from '../types'

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export type Level = 'ok' | 'warn' | 'crit'

/** What one drawing of the band needs, read from $.state. */
export type BandView = {
  fiveHour: UsageBandWindow | null
  sevenDay: UsageBandWindow | null
  context: UsageBandContext | null
  costUsd: number | null
  tokens: UsageBandTokens | null
  now: number
}

/** A limit window ready to draw. */
export type LimitFigures = {
  label: '5h' | '7d'
  percent: number
  remaining: string | null
  elapsed: number | null
  level: Level
}

/** 950, 3.0k, 15.6k, 954.2k, 1.25M, 2.40B */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  const thousands = Math.round(n / 100) / 10
  if (thousands < 1000) return `${thousands.toFixed(1)}k`
  const millions = Math.round(n / 10_000) / 100
  if (millions < 1000) return `${millions.toFixed(2)}M`
  return `${(Math.round(n / 10_000_000) / 100).toFixed(2)}B`
}

/** 40m, 2h 40m, 1d 7h */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return '0m'
  const totalMinutes = Math.ceil(ms / 60_000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`
}

export function levelOf(percent: number): Level {
  if (percent >= 90) return 'crit'
  if (percent >= 70) return 'warn'
  return 'ok'
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

export function limitFigures(
  label: '5h' | '7d',
  window: UsageBandWindow,
  now: number,
): LimitFigures {
  const span = label === '5h' ? FIVE_HOURS_MS : SEVEN_DAYS_MS
  const resetsAt = window.resetsAt === null ? Number.NaN : Date.parse(window.resetsAt)
  const left = Number.isFinite(resetsAt) ? Math.max(0, resetsAt - now) : null

  return {
    label,
    percent: window.percentUsed,
    remaining: left === null ? null : formatRemaining(left),
    elapsed: left === null ? null : clamp01(1 - left / span),
    level: levelOf(window.percentUsed),
  }
}

export function inputTotal(tokens: UsageBandTokens): number {
  return tokens.uncachedInput + tokens.cacheWrite
}

export function approx(tokens: UsageBandTokens, text: string): string {
  return tokens.isEstimate ? `~${text}` : text
}

function contextLine(context: UsageBandContext | null): string {
  if (context === null || context.tokens === null) return 'Bağlam doluluğu: henüz ölçülmedi'
  const percent = context.percent ?? Math.round((context.tokens / context.window) * 100)
  return `Bağlam doluluğu: ${formatCount(context.tokens)} / ${formatCount(context.window)} (%${percent})`
}

function requestLine(tokens: UsageBandTokens): string {
  if (tokens.isEstimate) return `Tamamlanan tur: ${tokens.requests}`
  const subagents = tokens.subagentFiles > 0 ? ` (${tokens.subagentFiles} alt ajan dökümü dahil)` : ''
  return `İstek sayısı: ${tokens.requests}${subagents}`
}

function estimateNote(tokens: UsageBandTokens): string[] {
  return tokens.isEstimate
    ? ['~ Yaklaşık: döküm okunamadı, tur sonu usage değerleri toplanıyor']
    : []
}

export function limitTooltip(figures: LimitFigures, window: UsageBandWindow): string {
  const name = figures.label === '5h' ? '5 saatlik pencere' : '7 günlük pencere'
  const lines = [name, `Kullanılan: %${window.percentUsed.toFixed(1)}`]
  if (figures.remaining !== null) lines.push(`Sıfırlanmaya kalan: ${figures.remaining}`)
  if (figures.elapsed !== null) {
    lines.push(`Pencerenin geçen kısmı: %${Math.round(figures.elapsed * 100)} (dikey çizgi)`)
  }
  return lines.join('\n')
}

export function inputTooltip(tokens: UsageBandTokens, context: UsageBandContext | null): string {
  return [
    `Giriş token'ı: ${approx(tokens, formatCount(inputTotal(tokens)))}`,
    `  önbelleksiz giriş: ${formatCount(tokens.uncachedInput)}`,
    `  önbelleğe yazılan: ${formatCount(tokens.cacheWrite)}`,
    contextLine(context),
    requestLine(tokens),
    ...estimateNote(tokens),
  ].join('\n')
}

export function outputTooltip(tokens: UsageBandTokens, context: UsageBandContext | null): string {
  const perRequest = tokens.requests > 0 ? tokens.output / tokens.requests : 0
  return [
    `Çıkış token'ı: ${approx(tokens, formatCount(tokens.output))}`,
    `  istek başına ortalama: ${formatCount(perRequest)}`,
    contextLine(context),
    requestLine(tokens),
    ...estimateNote(tokens),
  ].join('\n')
}

export function cacheTooltip(tokens: UsageBandTokens, context: UsageBandContext | null): string {
  const allInput = inputTotal(tokens) + tokens.cacheRead
  const hitRate = allInput > 0 ? Math.round((tokens.cacheRead / allInput) * 100) : 0
  return [
    `Önbellekten okunan: ${approx(tokens, formatCount(tokens.cacheRead))}`,
    `  önbellek isabeti: tüm girişin %${hitRate}'i`,
    `  önbelleğe yazılan: ${formatCount(tokens.cacheWrite)}`,
    contextLine(context),
    requestLine(tokens),
    ...estimateNote(tokens),
  ].join('\n')
}

export function costTooltip(
  usd: number,
  tokens: UsageBandTokens | null,
  context: UsageBandContext | null,
): string {
  return [
    `Oturum maliyeti: ${formatUsd(usd)}`,
    'API liste fiyatıyla; abonelikte faturanız bu değildir',
    contextLine(context),
    ...(tokens === null ? [] : [requestLine(tokens)]),
  ].join('\n')
}

/** The /kullanim answer: one line. */
export function summaryLine(view: BandView): string {
  const parts: string[] = []
  for (const [label, window] of [['5h', view.fiveHour], ['7d', view.sevenDay]] as const) {
    if (window === null) continue
    const figures = limitFigures(label, window, view.now)
    const left = figures.remaining === null ? '' : ` (${figures.remaining})`
    parts.push(`${label} %${Math.round(figures.percent)}${left}`)
  }
  if (view.tokens !== null) {
    const t = view.tokens
    parts.push(`giriş ${approx(t, formatCount(inputTotal(t)))}`)
    parts.push(`çıkış ${approx(t, formatCount(t.output))}`)
    parts.push(`önbellek ${approx(t, formatCount(t.cacheRead))}`)
    parts.push(`${t.isEstimate ? 'tur' : 'istek'} ${t.requests}`)
  }
  if (view.costUsd !== null) parts.push(formatUsd(view.costUsd))
  if (view.context?.percent != null) parts.push(`bağlam %${view.context.percent}`)
  return parts.length === 0 ? 'Henüz kullanım verisi yok (ilk model yanıtından sonra gelir).' : parts.join(' · ')
}

/** /kullanim's argument, case and Turkish dots folded: GİZLE, gızle, GÖSTER → gizle, goster. */
export function choiceOf(args: string): string {
  return args
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
}

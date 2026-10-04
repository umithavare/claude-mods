// Builds the desktop band's pills as standalone SVG documents: one per pill,
// colors in an inner <style> with a prefers-color-scheme: dark override, and a
// <title> on the whole pill for the hover tooltip.
import {
  approx,
  cacheTooltip,
  costTooltip,
  formatCount,
  formatUsd,
  inputTooltip,
  inputTotal,
  limitFigures,
  limitTooltip,
  outputTooltip,
} from './format'
import type { BandView, Level, LimitFigures } from './format'
import type { UsageBandWindow } from '../types'

export type PillSvg = {
  key: string
  source: string
  alt: string
  width: number
  height: number
}

type PaletteName = 'teal' | 'violet' | 'red' | 'green' | 'blue' | 'gold'
type Tone = { bg: string; border: string; fg: string }

const PALETTES: Record<PaletteName, { light: Tone; dark: Tone }> = {
  teal: {
    light: { bg: '#d4f4ec', border: '#a3e1d2', fg: '#0b5045' },
    dark: { bg: '#0f2b27', border: '#1f4f47', fg: '#9becd8' },
  },
  violet: {
    light: { bg: '#ebe5ff', border: '#cdbffa', fg: '#42288c' },
    dark: { bg: '#221a3f', border: '#3e3172', fg: '#d2c5ff' },
  },
  red: {
    light: { bg: '#fde3e0', border: '#f4bab3', fg: '#83211b' },
    dark: { bg: '#371715', border: '#622a25', fg: '#ffb2a9' },
  },
  green: {
    light: { bg: '#ddf4dc', border: '#b0e0ad', fg: '#1a5823' },
    dark: { bg: '#132c17', border: '#285731', fg: '#a4e7ad' },
  },
  blue: {
    light: { bg: '#dfe9ff', border: '#b6cbf9', fg: '#1b3d8a' },
    dark: { bg: '#142140', border: '#294272', fg: '#a8c4ff' },
  },
  gold: {
    light: { bg: '#fbefca', border: '#ecd384', fg: '#624400' },
    dark: { bg: '#30250a', border: '#5e4a13', fg: '#f3d179' },
  },
}

const LEVELS: Record<'light' | 'dark', Record<Level, string>> = {
  light: { ok: '#1e9a53', warn: '#c58a00', crit: '#d63a3a' },
  dark: { ok: '#3fd07e', warn: '#f2c94c', crit: '#ff6b6b' },
}

// Lucide icon bodies (ISC), drawn in a 24-unit box.
const ICONS = {
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  calendar:
    '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  hourglass:
    '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
  arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  arrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  layers: '<path d="m12 2-10 5 10 5 10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  dollar: '<path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
} as const

type Part =
  | { kind: 'icon'; body: string }
  | { kind: 'text'; text: string; isBold?: boolean }
  | { kind: 'bar'; percent: number; elapsed: number | null; level: Level }
  | { kind: 'sep' }

const HEIGHT = 24
const PILL_TOP = 1
const PILL_HEIGHT = 22
const MID = PILL_TOP + PILL_HEIGHT / 2
const PAD_X = 9
const GAP = 5
const SEP_GAP = 7
const ICON = 13
const CHAR_W = 7.2
const BAR_W = 38
const BAR_H = 6
const FONT =
  'ui-monospace,"SF Mono",SFMono-Regular,Menlo,"Cascadia Mono",Consolas,"Liberation Mono",monospace'

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const round = (n: number) => Math.round(n * 100) / 100

function partWidth(part: Part): number {
  switch (part.kind) {
    case 'icon':
      return ICON
    case 'text':
      return part.text.length * CHAR_W
    case 'bar':
      return BAR_W
    case 'sep':
      return 1
  }
}

function drawPart(part: Part, x: number): string {
  switch (part.kind) {
    case 'icon': {
      const scale = round(ICON / 24)
      const y = round(MID - ICON / 2)
      return `<g class="ic" fill="none" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" transform="translate(${round(x)} ${y}) scale(${scale})">${part.body}</g>`
    }
    case 'text': {
      const width = round(partWidth(part))
      const weight = part.isBold === true ? ' b' : ''
      return `<text class="fg${weight}" x="${round(x)}" y="${MID + 4.2}" textLength="${width}" lengthAdjust="spacing">${escapeXml(part.text)}</text>`
    }
    case 'bar': {
      const y = MID - BAR_H / 2
      const fill = (BAR_W * Math.min(100, Math.max(0, part.percent))) / 100
      const shown = part.percent > 0 ? Math.max(fill, 2) : 0
      const track = `<rect class="tr" x="${round(x)}" y="${y}" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>`
      const bar =
        shown > 0
          ? `<rect class="${part.level}" x="${round(x)}" y="${y}" width="${round(shown)}" height="${BAR_H}" rx="${BAR_H / 2}"/>`
          : ''
      const tick =
        part.elapsed === null
          ? ''
          : `<rect class="tk" x="${round(x + BAR_W * part.elapsed - 0.75)}" y="${MID - 6.5}" width="1.5" height="13" rx="0.75"/>`
      return track + bar + tick
    }
    case 'sep':
      return `<rect class="sp" x="${round(x)}" y="${MID - 6}" width="1" height="12"/>`
  }
}

function styleFor(palette: PaletteName): string {
  const { light, dark } = PALETTES[palette]
  const tone = (t: Tone, levels: Record<Level, string>, track: number) =>
    `.bg{fill:${t.bg};stroke:${t.border}}.fg{fill:${t.fg}}.ic{stroke:${t.fg}}` +
    `.tr{fill:${t.fg};fill-opacity:${track}}.sp{fill:${t.fg};fill-opacity:.35}.tk{fill:${t.fg}}` +
    `.ok{fill:${levels.ok}}.warn{fill:${levels.warn}}.crit{fill:${levels.crit}}`
  return (
    `svg{color-scheme:light dark}text{font-family:${FONT};font-size:12px}.b{font-weight:700}` +
    tone(light, LEVELS.light, 0.16) +
    `@media (prefers-color-scheme:dark){${tone(dark, LEVELS.dark, 0.24)}}`
  )
}

function pill(key: string, palette: PaletteName, parts: Part[], tooltip: string, alt: string): PillSvg {
  let x = PAD_X
  const drawn: string[] = []
  parts.forEach((part, index) => {
    if (index > 0) {
      const isAroundSep = part.kind === 'sep' || parts[index - 1]?.kind === 'sep'
      x += isAroundSep ? SEP_GAP : GAP
    }
    drawn.push(drawPart(part, x))
    x += partWidth(part)
  })
  const width = Math.ceil(x + PAD_X)
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}">` +
    `<style>${styleFor(palette)}</style>` +
    `<g><title>${escapeXml(tooltip)}</title>` +
    `<rect class="bg" x="0.5" y="${PILL_TOP + 0.5}" width="${width - 1}" height="${PILL_HEIGHT - 1}" rx="${(PILL_HEIGHT - 1) / 2}"/>` +
    drawn.join('') +
    '</g></svg>'
  return { key, source, alt, width, height: HEIGHT }
}

function limitPill(figures: LimitFigures, window: UsageBandWindow): PillSvg {
  const isFiveHour = figures.label === '5h'
  const percent = `${Math.round(figures.percent)}%`
  const parts: Part[] = [
    { kind: 'icon', body: isFiveHour ? ICONS.gauge : ICONS.calendar },
    { kind: 'text', text: figures.label },
    { kind: 'bar', percent: figures.percent, elapsed: figures.elapsed, level: figures.level },
    { kind: 'text', text: percent, isBold: true },
  ]
  if (figures.remaining !== null) {
    parts.push({ kind: 'sep' }, { kind: 'icon', body: ICONS.hourglass }, { kind: 'text', text: figures.remaining })
  }
  const left = figures.remaining === null ? '' : `, ${figures.remaining} kaldı`
  return pill(
    figures.label,
    isFiveHour ? 'teal' : 'violet',
    parts,
    limitTooltip(figures, window),
    `${figures.label} limiti ${percent}${left}`,
  )
}

/** The band's pills in their three groups: limits, tokens, cost. Empty groups are left out. */
export function buildPills(view: BandView): PillSvg[][] {
  const limits: PillSvg[] = []
  if (view.fiveHour !== null) limits.push(limitPill(limitFigures('5h', view.fiveHour, view.now), view.fiveHour))
  if (view.sevenDay !== null) limits.push(limitPill(limitFigures('7d', view.sevenDay, view.now), view.sevenDay))

  const tokens: PillSvg[] = []
  const t = view.tokens
  if (t !== null) {
    const input = approx(t, formatCount(inputTotal(t)))
    const output = approx(t, formatCount(t.output))
    const cached = approx(t, formatCount(t.cacheRead))
    tokens.push(
      pill('input', 'red', [{ kind: 'icon', body: ICONS.arrowUp }, { kind: 'text', text: input }], inputTooltip(t, view.context), `giriş ${input}`),
      pill('output', 'green', [{ kind: 'icon', body: ICONS.arrowDown }, { kind: 'text', text: output }], outputTooltip(t, view.context), `çıkış ${output}`),
      pill('cache', 'blue', [{ kind: 'icon', body: ICONS.layers }, { kind: 'text', text: cached }], cacheTooltip(t, view.context), `önbellekten ${cached}`),
    )
  }

  const cost: PillSvg[] = []
  if (view.costUsd !== null) {
    const usd = formatUsd(view.costUsd)
    cost.push(
      pill('cost', 'gold', [{ kind: 'icon', body: ICONS.dollar }, { kind: 'text', text: usd, isBold: true }], costTooltip(view.costUsd, t, view.context), `maliyet ${usd}`),
    )
  }

  return [limits, tokens, cost].filter(group => group.length > 0)
}

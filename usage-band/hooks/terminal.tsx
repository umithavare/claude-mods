// The band on the terminal: the same pills as colored Text runs, the bar as
// █ and ░ with │ marking how much of the window has passed.
import type { ElementTable } from 'claude-code'

import { approx, formatCount, formatUsd, inputTotal, limitFigures } from './format'
import type { BandView, Level, LimitFigures } from './format'

const COLORS = {
  teal: '#2dd4bf',
  violet: '#a78bfa',
  red: '#f87171',
  green: '#4ade80',
  blue: '#60a5fa',
  gold: '#fbbf24',
  track: '#4b5563',
} as const

const LEVEL_COLORS: Record<Level, string> = { ok: '#22c55e', warn: '#eab308', crit: '#ef4444' }

const BAR_CELLS = 10

type Run = { text: string; color: string }

/** The bar as runs of one glyph and color each. */
function barRuns(figures: LimitFigures, tickColor: string): Run[] {
  const filled = Math.round(Math.min(100, Math.max(0, figures.percent)) / (100 / BAR_CELLS))
  const tick = figures.elapsed === null ? -1 : Math.min(BAR_CELLS - 1, Math.floor(figures.elapsed * BAR_CELLS))
  const runs: Run[] = []
  for (let cell = 0; cell < BAR_CELLS; cell += 1) {
    const next: Run =
      cell === tick
        ? { text: '│', color: tickColor }
        : cell < filled
          ? { text: '█', color: LEVEL_COLORS[figures.level] }
          : { text: '░', color: COLORS.track }
    const last = runs[runs.length - 1]
    if (last !== undefined && last.color === next.color && last.text.endsWith(next.text)) {
      runs[runs.length - 1] = { ...last, text: last.text + next.text }
    } else {
      runs.push(next)
    }
  }
  return runs
}

export function drawTerminal(elements: ElementTable<'terminal'>, view: BandView) {
  const { Box, Text } = elements

  const limitPill = (figures: LimitFigures, color: string, icon: string) => (
    <Box flexDirection="row">
      <Text color={color}>
        {icon} {figures.label}{' '}
      </Text>
      {barRuns(figures, color).map(run => (
        <Text color={run.color}>{run.text}</Text>
      ))}
      <Text color={color} bold>
        {' '}
        {Math.round(figures.percent)}%
      </Text>
      {figures.remaining !== null && <Text color={color}> ↻ {figures.remaining}</Text>}
    </Box>
  )

  const valuePill = (color: string, icon: string, value: string, isBold = false) => (
    <Box flexDirection="row">
      <Text color={color} bold={isBold}>
        {icon} {value}
      </Text>
    </Box>
  )

  const limits = [
    view.fiveHour === null ? null : limitPill(limitFigures('5h', view.fiveHour, view.now), COLORS.teal, '◔'),
    view.sevenDay === null ? null : limitPill(limitFigures('7d', view.sevenDay, view.now), COLORS.violet, '▦'),
  ].filter(pill => pill !== null)

  const t = view.tokens
  const tokens =
    t === null
      ? []
      : [
          valuePill(COLORS.red, '↑', approx(t, formatCount(inputTotal(t)))),
          valuePill(COLORS.green, '↓', approx(t, formatCount(t.output))),
          valuePill(COLORS.blue, '≋', approx(t, formatCount(t.cacheRead))),
        ]

  const cost = view.costUsd === null ? [] : [valuePill(COLORS.gold, '$', formatUsd(view.costUsd).slice(1), true)]

  const groups = [limits, tokens, cost].filter(group => group.length > 0)

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={4}>
      {groups.map(group => (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {group}
        </Box>
      ))}
    </Box>
  )
}

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.parse('2026-10-04T12:00:00Z')
const MINUTE = 60_000

const BAND = {
  plugin: 'usage-band',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 160,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const MEASURE = {
  context: { tokens: 68_200, window: 200_000, percent: 34 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 20, resetsAt: new Date(NOW + 160 * MINUTE).toISOString() },
    { kind: 'seven_day', percentUsed: 58, resetsAt: new Date(NOW + 31 * 60 * MINUTE).toISOString() },
  ],
  cost: { usd: 4.32 },
  changed: ['context', 'rateLimits', 'cost'] as ('context' | 'rateLimits' | 'cost')[],
}

const TURN = {
  answer: 'ok',
  durationMs: 1000,
  isAborted: false,
  turnId: 'turn-1',
  reason: 'answer' as const,
  usage: {
    input_tokens: 2_100,
    cache_creation_input_tokens: 13_500,
    output_tokens: 3_000,
    cache_read_input_tokens: 954_200,
    model: 'claude-opus-5-5',
  },
}

const RUN = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

/** What session.usage answers; a test moves it to see a refresh land. */
const usage = { fiveHourPercent: 20 }

/** What the engine answers beneath the plugin in a session; here node is missing, so tokens are estimates. */
function engineBeneath(on: On) {
  usage.fiveHourPercent = 20
  const clock = mock.clock(on, { now: NOW })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: MEASURE.context,
      rateLimits: MEASURE.rateLimits.map(limit =>
        limit.kind === 'five_hour' ? { ...limit, percentUsed: usage.fiveHourPercent } : limit,
      ),
      cost: MEASURE.cost,
    },
  }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: 'test-session' }))
  on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', () => ({ deny: 'spawn ENOENT' }))
  on('ui.log', () => ({ value: undefined }))
  return clock
}

describe('usage-band', () => {
  test('stays away before the first model response', async ($, on) => {
    engineBeneath(on)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Svg' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /5h/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('draws limits, estimated tokens and cost on both surfaces', async ($, on) => {
    engineBeneath(on)
    await $.session.measure(MEASURE)
    await $.turn.complete(TURN)

    const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
    for (const text of ['5h', '20%', '2h 40m', '7d', '58%', '1d 7h', '~15.6k', '~3.0k', '~954.2k', '4.32']) {
      expect(await terminal.find({ type: 'Text', text })).toBeDefined()
    }
    await terminal.unmount()

    const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const pills = await desktop.findAll({ type: 'Svg' })
    expect(pills).toHaveLength(6)
    for (const pill of pills) {
      expect(pill.props.isInteractive).toBe(true)
      expect(String(pill.props.source)).toContain('<title>')
      expect(String(pill.props.source)).toContain('prefers-color-scheme:dark')
    }
    const sources = pills.map(pill => String(pill.props.source))
    expect(sources[0]).toContain('2h 40m')
    expect(sources[1]).toContain('1d 7h')
    expect(sources[2]).toContain('~15.6k')
    expect(sources[5]).toContain('$4.32')
    expect(sources[5]).toContain('API liste fiyatıyla')
    await desktop.unmount()
  })

  test('yields to a survey', async ($, on) => {
    engineBeneath(on)
    await $.session.measure(MEASURE)
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, hasSurvey: true } })
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    await ui.unmount()
  })

  test('the 30 s timer keeps refreshing after session.start has returned', async ($, on) => {
    const clock = engineBeneath(on)
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    await clock.settle()
    usage.fiveHourPercent = 35
    await clock.advance(30 * MINUTE)

    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const pills = await ui.findAll({ type: 'Svg' })
    expect(String(pills[0]?.props.source)).toContain('35%')
    expect(String(pills[0]?.props.source)).toContain('2h 10m')
    await ui.unmount()
  })

  test('/kullanim sums up the values it just refreshed', async ($, on) => {
    const clock = engineBeneath(on)
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    await clock.settle()
    usage.fiveHourPercent = 41

    const summary = await $.command.run({ command: 'kullanim', args: '', ...RUN })
    expect(summary.text).toContain('5h %41')
  })

  test('/clear drops the ended session token totals and cost', async ($, on) => {
    engineBeneath(on)
    await $.session.measure(MEASURE)
    await $.turn.complete(TURN)
    await $.session.end({ reason: 'clear', sessionId: 'test-session', resume: { id: 'test-session' } })

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '~15.6k' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '4.32' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '20%' })).toBeDefined()
    await ui.unmount()
  })

  test('/kullanim GIZLE and GÖSTER work in any case', async ($, on) => {
    engineBeneath(on)
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    expect((await $.command.run({ command: 'kullanim', args: 'GIZLE', ...RUN })).text).toContain('gizlendi')
    expect((await $.command.run({ command: 'kullanim', args: 'GÖSTER', ...RUN })).text).toContain('açıldı')
  })

  test('/kullanim gizle hides the band, goster brings it back, bare refreshes and sums up', async ($, on) => {
    engineBeneath(on)
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    await $.session.measure(MEASURE)

    const hidden = await $.command.run({ command: 'kullanim', args: 'gizle', ...RUN })
    expect(hidden.text).toContain('gizlendi')
    const off = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await off.find({ type: 'Svg' })).toBeUndefined()
    await off.unmount()

    await $.command.run({ command: 'kullanim', args: 'goster', ...RUN })
    const shown = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect((await shown.findAll({ type: 'Svg' })).length).toBeGreaterThan(0)
    await shown.unmount()

    const summary = await $.command.run({ command: 'kullanim', args: '', ...RUN })
    expect(summary.text).toContain('5h %20 (2h 40m)')
    expect(summary.text).toContain('$4.32')
  })
})

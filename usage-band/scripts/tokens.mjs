// Sums one Claude Code session's token usage from its transcript files.
//
//   node tokens.mjs <session-id>
//
// Reads ~/.claude/projects/*/<id>.jsonl and every *.jsonl under
// ~/.claude/projects/*/<id>/subagents/ (workflow agents sit a level or two deeper)
// — CLAUDE_CONFIG_DIR replaces ~/.claude when set — and prints one JSON object on stdout.
// The transcript writes an assistant message once per content block, so rows are keyed
// by message.id + requestId and each usage field keeps its largest value.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/
const MAX_DEPTH = 4
const FIELDS = [
  'input_tokens',
  'cache_creation_input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
]

function reply(value, code = 0) {
  process.stdout.write(JSON.stringify(value))
  process.exit(code)
}

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

function listDir(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
}

function walkJsonl(dir, depth, found) {
  if (depth > MAX_DEPTH) return found
  for (const entry of listDir(dir)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walkJsonl(path, depth + 1, found)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(path)
  }
  return found
}

function findTranscripts(id) {
  const projects = join(configDir(), 'projects')
  const main = []
  const subagents = []
  for (const project of listDir(projects)) {
    if (!project.isDirectory()) continue
    const dir = join(projects, project.name)
    const file = join(dir, `${id}.jsonl`)
    if (existsSync(file)) main.push(file)
    walkJsonl(join(dir, id, 'subagents'), 1, subagents)
  }
  return { main, subagents }
}

function rowKey(row) {
  const messageId = row.message?.id ?? ''
  const requestId = row.requestId ?? ''
  return messageId || requestId ? `${messageId}|${requestId}` : `uuid|${row.uuid ?? Math.random()}`
}

function collect(file, seen) {
  const text = readFileSync(file, 'utf8')
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const usage = row?.type === 'assistant' ? row.message?.usage : undefined
    if (!usage || typeof usage !== 'object') continue
    const key = rowKey(row)
    const prior = seen.get(key) ?? {}
    const merged = { ...prior }
    for (const field of FIELDS) {
      const value = Number(usage[field]) || 0
      merged[field] = Math.max(prior[field] ?? 0, value)
    }
    seen.set(key, merged)
  }
}

/** files|bytes|newest mtime: the mod computes the same from $.fs to skip unchanged transcripts. */
function signatureOf(stats) {
  const bytes = stats.reduce((sum, stat) => sum + stat.size, 0)
  const newest = stats.reduce((max, stat) => Math.max(max, Math.floor(stat.mtimeMs)), 0)
  return `${stats.length}|${bytes}|${newest}`
}

function main() {
  const id = process.argv[2] ?? ''
  if (!SESSION_ID.test(id)) reply({ ok: false, error: 'invalid session id' }, 2)

  const { main: mains, subagents } = findTranscripts(id)
  if (mains.length === 0 && subagents.length === 0) {
    reply({ ok: false, error: 'transcript not found' }, 3)
  }

  const seen = new Map()
  const stats = []
  for (const file of [...mains, ...subagents]) {
    try {
      // Stat before reading: a write landing mid-read then shows up as a change next time.
      stats.push(statSync(file))
      collect(file, seen)
    } catch (error) {
      reply({ ok: false, error: `cannot read ${file}: ${error?.message ?? error}` }, 4)
    }
  }

  const sums = Object.fromEntries(FIELDS.map(field => [field, 0]))
  for (const usage of seen.values()) {
    for (const field of FIELDS) sums[field] += usage[field] ?? 0
  }

  reply({
    ok: true,
    mainPath: mains[0] ?? null,
    signature: signatureOf(stats),
    totals: {
      uncachedInput: sums.input_tokens,
      cacheWrite: sums.cache_creation_input_tokens,
      output: sums.output_tokens,
      cacheRead: sums.cache_read_input_tokens,
    },
    requests: seen.size,
    subagentFiles: subagents.length,
  })
}

main()

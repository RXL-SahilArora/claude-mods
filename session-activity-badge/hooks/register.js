// session-activity-badge
//
// Every session that loads this mod publishes one record to $.store, which all sessions on the
// machine share: { busy, agents, at }. "busy" is true between this session's main-loop turn.start
// and turn.complete; "agents" counts its running subagents; "at" is a heartbeat written every few
// seconds. Each session reads the other records and, while any is working, draws a one-line badge
// in the band above the prompt (render site AbovePrompt). When nothing is working it returns
// next(e), so the band stays empty.
//
// ponytail: one key per session, polled every 3 s; fine for a handful of sessions on one machine.

const KEY_PREFIX = 'activity:'
const POLL_MS = 3000
// A record not refreshed for this long belongs to a session that crashed or was closed without
// session.end; treat it as idle and delete it later.
const STALE_MS = 15000
const PURGE_MS = 10 * 60 * 1000
const RUNNING = ['running', 'pending']
const MAX_NAMES = 3
// Prints this session's title records from the tail of its transcript; the id arrives as $1.
// The title records are re-appended often, so the last 4 MB of a 100 MB transcript holds them.
const TITLE_SCRIPT = String.raw`f=$(ls "$HOME"/.claude/projects/*/"$1".jsonl 2>/dev/null | head -1)
[ -n "$f" ] && tail -c 4000000 "$f" | grep -oE '"(customTitle|aiTitle|agentName)":"([^"\\]|\\.)*"'`
const TITLE_KEYS = ['customTitle', 'aiTitle', 'agentName']

const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const WRAP_UP_TOOL = 'mcp__ccd_turn__wrap_up'
const BAR_CELLS = 10
const MAX_STEP_CHARS = 40
const MAX_ACTIVITY_CHARS = 60
const MAX_BACKGROUND = 3
// ponytail: a task whose completion notice never came (the app restarted under it) is dropped after
// this long; swap for an engine list of background tasks if one appears.
const MAX_BACKGROUND_MS = 6 * 60 * 60 * 1000
const TASK_ID = /<task-id>([^<]+)<\/task-id>/g

// This session's id, name and state, and what the last poll saw of the others.
let selfKey = null
let ownName = null
let busy = false
let ownAgents = 0
// This session's task list as rebuilt from its update_plan calls: [{ content, status }].
let plan = []
// What this session is doing when it has no task list: its last tool call, else its prompt.
let activity = null
// This session's background work still in flight: [{ id, type, label, since }]. Added as a
// background Bash call starts, removed when its completion notice arrives; a Stop hook, where no
// other plugin skips it, replaces the list with the engine's own. Subagents are counted as agents.
let background = []
let othersAgents = 0
// One { name, busy, plan, activity, background } per session that is working or has background
// work (this session included for the latter), plan as summarize() returns it (null without a list).
let othersRows = []

function summarize() {
  if (plan.length === 0) return null
  const current = plan.find((s) => s.status === 'in_progress')
  return {
    done: plan.filter((s) => s.status === 'completed').length,
    total: plan.length,
    current: current ? current.content : null,
  }
}

async function publish($) {
  if (selfKey === null) return
  const now = await $.clock.now()
  background = background.filter((t) => now - Number(t.since ?? now) < MAX_BACKGROUND_MS)
  await $.store.set(selfKey, {
    busy,
    agents: ownAgents,
    name: ownName,
    plan: summarize(),
    // The full list too, so a reload of this mod mid-turn can restore it.
    steps: plan,
    activity,
    background,
    at: await $.clock.now(),
  })
}

// Mirrors the Desktop app's update_plan semantics: items replaces the list, advance completes the
// in-progress step and starts the next pending one, done/start take 1-based step numbers.
function applyPlanCall(e) {
  if (Array.isArray(e.items)) {
    plan = e.items.map((s) => ({ content: String(s?.content ?? ''), status: String(s?.status ?? 'pending') }))
  }
  if (e.advance === true) {
    const current = plan.find((s) => s.status === 'in_progress')
    if (current) current.status = 'completed'
    const nextStep = plan.find((s) => s.status === 'pending')
    if (nextStep) nextStep.status = 'in_progress'
  }
  if (Array.isArray(e.done)) {
    for (const n of e.done) if (plan[n - 1]) plan[n - 1].status = 'completed'
  }
  if (typeof e.start === 'number' && plan[e.start - 1]) plan[e.start - 1].status = 'in_progress'
}

function firstLine(text) {
  const line = String(text).trim().split('\n')[0]
  return line ? truncate(line, MAX_ACTIVITY_CHARS) : null
}

// A tool call in words: its own description (Bash, Agent), else the tool and the file it touches.
function describeCall(e) {
  if (typeof e.description === 'string' && e.description.trim()) return firstLine(e.description)
  const tool = String(e.tool).replace(/^mcp__.+?__/, '')
  const target = e.file_path ?? e.path ?? e.pattern ?? e.url
  return firstLine(typeof target === 'string' ? tool + ' ' + target.split('/').pop() : tool)
}

// ponytail: the mod API has no session title, so read it from this session's own transcript under
// $HOME/.claude; swap for an engine call if one appears. Keeps the previous name on any failure.
async function readOwnName($) {
  try {
    const id = await $.session.id()
    if (!/^[\w-]+$/.test(id)) return
    const { stdout } = await $.process.run(['sh', '-c', TITLE_SCRIPT, 'sh', id], { timeoutMs: 5000 })
    const latest = {}
    for (const line of stdout.split('\n')) {
      if (line) Object.assign(latest, JSON.parse('{' + line + '}'))
    }
    const title = TITLE_KEYS.map((k) => latest[k]).find(Boolean)
    if (title) ownName = title
    else if (ownName === null) ownName = (await $.session.cwd()).split('/').filter(Boolean).pop() ?? null
  } catch {
    // Leave ownName as it was.
  }
}

async function countOwnAgents($) {
  try {
    const agents = await $.agent.list()
    return agents.filter((a) => RUNNING.includes(a.status)).length
  } catch {
    return 0
  }
}

// Reads every other session's record; returns true when what the badge shows has changed.
async function poll($) {
  const now = await $.clock.now()
  let agents = 0
  const rows = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(KEY_PREFIX) || key === selfKey) continue
    const record = await $.store.get(key)
    const age = now - Number(record?.at ?? 0)
    if (age > PURGE_MS) {
      await $.store.delete(key)
      continue
    }
    if (age > STALE_MS) continue
    // Records from 0.1.0 carry no name; before 0.3.0 no plan; before 0.4.0 no activity; before
    // 0.5.0 no background.
    const bg = Array.isArray(record.background) ? record.background : []
    if (record.busy || bg.length > 0) {
      rows.push({
        name: record.name || 'session ' + key.slice(-8),
        busy: Boolean(record.busy),
        plan: record.plan ?? null,
        activity: record.activity ?? null,
        background: bg,
      })
    }
    agents += Number(record.agents ?? 0)
  }
  // This session's own background work shows here too; its own busy state does not.
  if (background.length > 0) {
    rows.push({ name: (ownName ?? 'this session') + ' (this)', busy: false, plan: null, activity: null, background })
  }
  rows.sort((a, b) => a.name.localeCompare(b.name))
  const changed = agents !== othersAgents || JSON.stringify(rows) !== JSON.stringify(othersRows)
  othersAgents = agents
  othersRows = rows
  return changed
}

async function tick($) {
  const agents = await countOwnAgents($)
  const ownChanged = agents !== ownAgents
  ownAgents = agents
  await publish($)
  const othersChanged = await poll($)
  if (ownChanged || othersChanged) $.ui.invalidate('ui.render')
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's')
}

function bar(done, total) {
  const filled = total > 0 ? Math.round((done / total) * BAR_CELLS) : 0
  return '█'.repeat(filled) + '░'.repeat(BAR_CELLS - filled)
}

function truncate(text, max) {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

// One row per session: its name, then its task list's progress, else what it is doing; then a line
// per background task.
function sessionRows(Box, Text, row) {
  const children = [Text({ color: 'red', children: ['  ' + row.name] })]
  const p = row.plan
  if (!row.busy) {
    children.push(Text({ dimColor: true, children: ['idle, waiting on background work'] }))
  } else if (p && p.total > 0) {
    children.push(Text({ color: 'green', mono: true, children: [bar(p.done, p.total)] }))
    children.push(Text({ mono: true, children: [p.done + '/' + p.total] }))
    if (p.current) children.push(Text({ dimColor: true, wrap: 'truncate-end', children: [truncate(p.current, MAX_STEP_CHARS)] }))
  } else {
    children.push(Text({ dimColor: true, wrap: 'truncate-end', children: [row.activity || 'starting…'] }))
  }
  const lines = [Box({ key: row.name, flexDirection: 'row', gap: 1, children })]
  for (const task of row.background.slice(0, MAX_BACKGROUND)) {
    lines.push(Text({ dimColor: true, wrap: 'truncate-end', children: ['    ↻ ' + task.type + ': ' + task.label] }))
  }
  const extra = row.background.length - MAX_BACKGROUND
  if (extra > 0) lines.push(Text({ dimColor: true, children: ['    +' + extra + ' more'] }))
  return lines
}

// The Stop hook's list of in-flight background work, less subagents, as [{ id, type, label, since }];
// a task already known keeps the time it was first seen.
function backgroundOf(tasks, now) {
  if (!Array.isArray(tasks)) return []
  return tasks
    .filter((t) => t && t.type !== 'subagent')
    .map((t) => ({
      id: String(t.id),
      type: String(t.type),
      label: firstLine(t.description || t.command || t.name || t.type) ?? '',
      since: background.find((b) => b.id === String(t.id))?.since ?? now,
    }))
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    selfKey = KEY_PREFIX + (await $.session.id())
    // A reload of this mod mid-turn starts the module over; take back what it last published.
    const previous = await $.store.get(selfKey)
    if (Array.isArray(previous?.steps)) plan = previous.steps
    if (typeof previous?.activity === 'string') activity = previous.activity
    if (Array.isArray(previous?.background)) background = previous.background
    await readOwnName($)
    await publish($)
    $.clock.every(POLL_MS, () => tick($))
    return next(e)
  })

  // turn.start fires for the main loop only; a subagent's run raises none.
  on('turn.start', async ($, e, next) => {
    busy = true
    // A list wrapped up last turn is finished work; a turn without a new list shows none.
    if (plan.every((s) => s.status === 'completed')) plan = []
    // Re-read each turn: a rename, or the auto title after the first turn, lands in the transcript.
    await readOwnName($)
    await publish($)
    return next(e)
  })

  // turn.complete carries agentId for a subagent's turn; only the main loop ends "busy".
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      busy = false
      activity = null
      await readOwnName($)
      await publish($)
    }
    return next(e)
  })

  // The Desktop app's task list exists only as these calls; rebuild it here so other sessions can
  // draw this one's progress.
  on('tool.call', { tool: PLAN_TOOL }, async ($, e, next) => {
    applyPlanCall(e)
    // Never let the shared-store write hold up or fail the app's own tool.
    publish($).catch(() => {})
    return next(e)
  })

  // wrap_up checks off the whole task list.
  on('tool.call', { tool: WRAP_UP_TOOL }, async ($, e, next) => {
    for (const s of plan) s.status = 'completed'
    publish($).catch(() => {})
    return next(e)
  })

  // Stop ends each main-loop turn and lists the background work still running; a task finishing
  // wakes the session for a turn, whose Stop brings the list up to date.
  on('classic.Stop', async ($, e, next) => {
    background = backgroundOf(e.background_tasks, await $.clock.now())
    publish($).catch(() => {})
    return next(e)
  })

  // Until a tool runs, the prompt is the best name for what the session is doing. A background
  // task's completion notice arrives here too, naming the task it ends.
  on('prompt.submit', async ($, e, next) => {
    const ended = [...String(e.text ?? '').matchAll(TASK_ID)].map((m) => m[1].trim())
    if (ended.length > 0 || e.origin?.kind === 'task-notification') {
      background = background.filter((t) => !ended.includes(t.id))
      publish($).catch(() => {})
      return next(e)
    }
    const line = firstLine(e.text ?? '')
    if (line) activity = line
    publish($).catch(() => {})
    return next(e)
  })

  // Every other tool call names the work in progress, for a session that keeps no task list.
  on('tool.call', async ($, e, next) => {
    if (e.tool !== PLAN_TOOL && e.tool !== WRAP_UP_TOOL) {
      activity = describeCall(e)
      publish($).catch(() => {})
    }
    // A task Claude stops sends no completion notice; drop it here, whatever the stop answers.
    if (e.tool === 'TaskStop') {
      const stopped = String(e.task_id ?? e.shell_id ?? '')
      background = background.filter((t) => t.id !== stopped)
      publish($).catch(() => {})
      return next(e)
    }
    if (e.tool !== 'Bash') return next(e)
    // A shell the model or the person sent to the background answers with its task id.
    const answer = await next(e)
    const id = answer?.result?.backgroundTaskId
    if (typeof id === 'string' && !background.some((t) => t.id === id)) {
      background = [...background, { id, type: 'shell', label: describeCall(e), since: await $.clock.now() }]
      publish($).catch(() => {})
    }
    return answer
  })

  on('session.end', async ($, e, next) => {
    if (selfKey !== null) await $.store.delete(selfKey)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const parts = []
    const working = othersRows.filter((r) => r.busy).length
    if (working > 0) parts.push(plural(working, 'session') + ' working')
    const tasks = othersRows.reduce((n, r) => n + r.background.length, 0)
    if (tasks > 0) parts.push(plural(tasks, 'background task'))
    const agents = othersAgents + ownAgents
    if (agents > 0) parts.push(plural(agents, 'agent') + ' running')
    if (parts.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const lines = [Text({ color: 'red', bold: true, children: ['● ' + parts.join(' · ')] })]
    for (const row of othersRows.slice(0, MAX_NAMES)) lines.push(...sessionRows(Box, Text, row))
    const extra = othersRows.length - MAX_NAMES
    if (extra > 0) lines.push(Text({ dimColor: true, children: ['  +' + extra + ' more'] }))
    // Keep whatever other mods draw in the band.
    return Box({ flexDirection: 'column', children: [...lines, await next(e)] })
  })
}

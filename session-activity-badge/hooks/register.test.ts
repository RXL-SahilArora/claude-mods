import { expect, test } from 'claude-code/testing'

const BAND = { plugin: 'session-activity-badge', component: 'AbovePrompt', props: {} } as const

test('update_plan calls publish progress, and other sessions draw it as a bar', async ($, on) => {
  const store = new Map<string, any>()
  // Each period is one clock.every dispatch; tick runs when it resolves. Hold it until the test releases it.
  let release = () => {}
  on('session.id', () => ({ value: 'self' }))
  on('session.cwd', () => ({ value: '/x/me' }))
  on('process.run', () => ({ value: { stdout: '', stderr: '', code: 0 } }))
  on('agent.list', () => ({ value: [] }))
  on('clock.now', () => ({ value: 1000 }))
  on('clock.every', () => new Promise((r) => (release = () => r({ value: undefined }))))
  on('store.set', (_, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.get', (_, e: any) => ({ value: store.get(e.key) }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', (_, e: any) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/x/me', surface: 'desktop', isInteractive: true })

  const items = ['Read', 'Edit', 'Test', 'Ship'].map((content, i) => ({
    content,
    status: i === 0 ? 'in_progress' : 'pending',
  }))
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items } as any)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as any)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', done: [2], start: 3 } as any)
  await new Promise((r) => setTimeout(r, 0))
  expect(store.get('activity:self').plan).toEqual({ done: 2, total: 4, current: 'Test' })

  // A session with a task list, one without (only its activity), and one from 0.2.0.
  store.set('activity:other', { busy: true, agents: 0, name: 'BUG FIX 5', plan: { done: 3, total: 5, current: 'Run tests' }, at: 1000 })
  store.set('activity:busy', { busy: true, agents: 0, name: 'BUG FIX 4', plan: null, activity: 'Run backend check', at: 1000 })
  store.set('activity:old', { busy: true, agents: 0, name: 'OLD', at: 1000 })
  release()
  await new Promise((r) => setTimeout(r, 20))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  expect((await ui.find({ type: 'Text', text: /3 sessions working/ }))?.text).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /^██████░░░░$/ }))?.text).toBe('██████░░░░')
  expect((await ui.find({ type: 'Text', text: /^3\/5$/ }))?.text).toBe('3/5')
  expect((await ui.find({ type: 'Text', text: /Run backend check/ }))?.text).toBe('Run backend check')
  expect((await ui.find({ type: 'Text', text: /starting/ }))?.text).toBe('starting…')
  await ui.unmount()

  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'x' } as any)
  await new Promise((r) => setTimeout(r, 0))
  expect(store.get('activity:self').plan).toEqual({ done: 4, total: 4, current: null })
})

test('a tool call names the activity, and a reload restores the task list', async ($, on) => {
  const store = new Map<string, any>([
    ['activity:self', { busy: true, steps: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }], at: 1 }],
  ])
  on('session.id', () => ({ value: 'self' }))
  on('session.cwd', () => ({ value: '/x/me' }))
  on('process.run', () => ({ value: { stdout: '', stderr: '', code: 0 } }))
  on('clock.now', () => ({ value: 1000 }))
  on('clock.every', () => new Promise(() => {}))
  on('store.set', (_, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.get', (_, e: any) => ({ value: store.get(e.key) }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/x/me', surface: 'desktop', isInteractive: true })
  expect(store.get('activity:self').plan).toEqual({ done: 1, total: 2, current: 'B' })

  await $.tool.call({ tool: 'Bash', command: 'make check', description: 'Run backend check' } as any)
  await new Promise((r) => setTimeout(r, 0))
  expect(store.get('activity:self').activity).toBe('Run backend check')

  await $.tool.call({ tool: 'Read', file_path: '/a/b/Foo.groovy' } as any)
  await new Promise((r) => setTimeout(r, 0))
  expect(store.get('activity:self').activity).toBe('Read Foo.groovy')
})

test('Stop lists background work, and an idle session with some is drawn', async ($, on) => {
  const store = new Map<string, any>()
  let release = () => {}
  on('session.id', () => ({ value: 'self' }))
  on('session.cwd', () => ({ value: '/x/me' }))
  on('process.run', () => ({ value: { stdout: '', stderr: '', code: 0 } }))
  on('agent.list', () => ({ value: [] }))
  on('clock.now', () => ({ value: 1000 }))
  on('clock.every', () => new Promise((r) => (release = () => r({ value: undefined }))))
  on('store.set', (_, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.get', (_, e: any) => ({ value: store.get(e.key) }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.Stop', () => ({}))

  await $.session.start({ cwd: '/x/me', surface: 'desktop', isInteractive: true })
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [
      { id: 'b1', type: 'shell', status: 'running', description: 'Run frontend tests with coverage', command: 'npm test' },
      { id: 'a1', type: 'subagent', status: 'running', description: 'Explore code' },
    ],
  } as any)
  await new Promise((r) => setTimeout(r, 0))
  expect(store.get('activity:self').background).toEqual([
    { id: 'b1', type: 'shell', label: 'Run frontend tests with coverage', since: 1000 },
  ])

  store.set('activity:coord', {
    busy: false,
    agents: 0,
    name: 'RELEASE PREP',
    background: [{ type: 'shell', label: 'Run full test suite' }],
    at: 1000,
  })
  release()
  await new Promise((r) => setTimeout(r, 20))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  expect((await ui.find({ type: 'Text', text: /2 background tasks/ }))?.text).toBe('● 2 background tasks')
  expect((await ui.find({ type: 'Text', text: /waiting on background/ }))?.text).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /full test suite/ }))?.text).toBe('    ↻ shell: Run full test suite')
  expect((await ui.find({ type: 'Text', text: /frontend tests/ }))?.text).toBe('    ↻ shell: Run frontend tests with coverage')
  await ui.unmount()
})

test('a background shell is listed from its start until its completion notice', async ($, on) => {
  const store = new Map<string, any>()
  on('session.id', () => ({ value: 'self' }))
  on('session.cwd', () => ({ value: '/x/me' }))
  on('process.run', () => ({ value: { stdout: '', stderr: '', code: 0 } }))
  on('clock.now', () => ({ value: 1000 }))
  on('clock.every', () => new Promise(() => {}))
  on('store.set', (_, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.get', (_, e: any) => ({ value: store.get(e.key) }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', (_, e: any) =>
    ({ result: e.run_in_background ? { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bx7' } : {} }))
  on('prompt.submit', (_, e) => ({ text: e.text }))

  await $.session.start({ cwd: '/x/me', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'sleep 90', description: 'Wait 90 seconds', run_in_background: true } as any)
  await new Promise((r) => setTimeout(r, 0))
  expect(store.get('activity:self').background).toEqual([{ id: 'bx7', type: 'shell', label: 'Wait 90 seconds', since: 1000 }])

  await $.prompt.submit({
    text: '<task-notification>\n<task-id>bx7</task-id>\n<status>completed</status>\n</task-notification>',
  } as any)
  await new Promise((r) => setTimeout(r, 0))
  expect(store.get('activity:self').background).toEqual([])
  // The notice is not what the session is doing.
  expect(store.get('activity:self').activity).toBe('Wait 90 seconds')
})

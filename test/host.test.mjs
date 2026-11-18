// Host-half test: exercise the delete route against a throwaway directory with mocked services.
// Run with: node test/host.test.mjs   (no DSH, no network, no real session touched)
import { mkdir, writeFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const ROOT = join(tmpdir(), 'dsh-session-delete-cn-test-' + process.pid)

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail))
}

const { apply } = await import(pathToFileURL(join(PACKAGE_DIR, 'index.js')).href)

/** Build a ctx whose services answer from one scenario object. */
function makeContext(scenario) {
  const routes = []
  const ctx = {
    effect(fn) { fn(); return () => {} },
    get(name) {
      if (name === 'sessions') return scenario.sessions
      if (name === 'sessionPersistence') return scenario.persistence
      if (name === 'workspaceRegistry') return scenario.registry
      return undefined
    },
    webServer: {
      register(route) { routes.push(route); return () => {} },
    },
  }
  return { ctx, routes }
}

/** Minimal IncomingMessage / ServerResponse doubles. */
async function call(routes, body, method = 'POST') {
  const req = (async function* () {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body))
  })()
  req.method = method
  const captured = { status: 0, json: null }
  const res = {
    writeHead(status) { captured.status = status; return res },
    end(text) { captured.json = text === undefined ? null : JSON.parse(text); return res },
  }
  await routes[0].handler(req, res)
  return captured
}

// --- scenario scaffolding ---------------------------------------------------
const sessionId = 'session-test-0001'
const projectDir = join(ROOT, '--D-testproject--')
const sessionDir = join(projectDir, sessionId)
const logPath = join(sessionDir, 'session.v4.jsonl.zstd')

async function seedSession(dir, file) {
  await mkdir(dir, { recursive: true })
  await writeFile(file, 'fake-log', 'utf8')
}

function scenarioFor(id, locationPath, options = {}) {
  const order = []
  const state = { archived: false, unarchived: false, detached: 0 }
  const registry = {
    async archiveSession(sid) { order.push('archive:' + sid); state.archived = true },
    async unarchiveSession(sid) { order.push('unarchive:' + sid); state.unarchived = true },
    list() {
      return [{
        sessionIds: [id],
        async detachSession(sid) { order.push('detach:' + sid); state.detached += 1 },
      }]
    },
  }
  const persistence = {
    async list() {
      return locationPath === null
        ? []
        : [{ header: { id }, location: { kind: 'jsonl', path: locationPath } }]
    },
  }
  const sessions = { get(sid) { return options.live === true ? { id: sid } : undefined } }
  return { registry, persistence, sessions, order, state }
}

// 1) happy path
{
  await rm(ROOT, { recursive: true, force: true })
  await seedSession(sessionDir, logPath)
  const s = scenarioFor(sessionId, logPath)
  const { ctx, routes } = makeContext(s)
  apply(ctx)
  check('route registered exactly once', routes.length === 1 && routes[0].path === '/dsh-session-delete-cn/delete' && routes[0].kind === 'exact')
  const out = await call(routes, { sessionId })
  check('happy path returns 200 ok', out.status === 200 && out.json.ok === true, JSON.stringify(out.json))
  check('session directory removed', await stat(sessionDir).then(() => false, () => true))
  check('archive ran before detach', s.order.join(',') === 'archive:' + sessionId + ',detach:' + sessionId, s.order.join(','))
}

// 2) live session refused, nothing touched
{
  await rm(ROOT, { recursive: true, force: true })
  await seedSession(sessionDir, logPath)
  const s = scenarioFor(sessionId, logPath, { live: true })
  const { ctx, routes } = makeContext(s)
  apply(ctx)
  const out = await call(routes, { sessionId })
  check('live session returns 409', out.status === 409 && out.json.code === 'live', JSON.stringify(out.json))
  check('live session keeps its files', await stat(logPath).then(() => true, () => false))
  check('live session deferred nothing', s.order.length === 0, s.order.join(','))
}

// 3) unknown session
{
  await rm(ROOT, { recursive: true, force: true })
  const s = scenarioFor(sessionId, null)
  const { ctx, routes } = makeContext(s)
  apply(ctx)
  const out = await call(routes, { sessionId })
  check('unknown session returns 404', out.status === 404 && out.json.code === 'missing', JSON.stringify(out.json))
}

// 4) container-shaped directory refused
{
  await rm(ROOT, { recursive: true, force: true })
  const badDir = join(ROOT, '--D-testproject--')
  await mkdir(badDir, { recursive: true })
  await writeFile(join(badDir, 'keep.txt'), 'keep', 'utf8')
  const s = scenarioFor(sessionId, join(badDir, 'session.v4.jsonl.zstd'))
  const { ctx, routes } = makeContext(s)
  apply(ctx)
  const out = await call(routes, { sessionId })
  check('project-shaped path returns 403', out.status === 403 && out.json.code === 'unsafe-path', JSON.stringify(out.json))
  check('project directory survives', await stat(join(badDir, 'keep.txt')).then(() => true, () => false))
}

// 5) removal failure rolls the archive back
{
  await rm(ROOT, { recursive: true, force: true })
  await mkdir(ROOT, { recursive: true })
  const s = scenarioFor(sessionId, join(ROOT, 'bad\u0000dir', 'session.v4.jsonl.zstd'))
  const { ctx, routes } = makeContext(s)
  apply(ctx)
  const out = await call(routes, { sessionId })
  check('removal failure returns 500 remove-failed', out.status === 500 && out.json.code === 'remove-failed', JSON.stringify(out.json))
  check('removal failure rolled the archive back', s.state.archived === true && s.state.unarchived === true, s.order.join(','))
  check('removal failure detached nothing', s.state.detached === 0)
}

// 6) bad arguments and wrong method
{
  const s = scenarioFor(sessionId, logPath)
  const { ctx, routes } = makeContext(s)
  apply(ctx)
  const bad = await call(routes, { sessionId: '   ' })
  check('blank session id returns 400', bad.status === 400 && bad.json.code === 'bad-args', JSON.stringify(bad.json))
  const wrongMethod = await call(routes, { sessionId }, 'GET')
  check('GET returns 405', wrongMethod.status === 405, JSON.stringify(wrongMethod.json))
}

await rm(ROOT, { recursive: true, force: true })
const failed = results.filter(r => r.pass !== true)
console.log('SUMMARY total=' + results.length + ' failed=' + failed.length)
if (failed.length > 0) process.exitCode = 1

// Client-half test: load the browser module against stubbed window/ctx and drive the menu action.
// 文案固定中文：这些断言同时锁住"菜单不再依赖界面语言探测"。
// Run with: node test/client.test.mjs
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail))
}

const loaded = []
const confirms = []
let fetchCalls = []
let fetchReply = { ok: true }

globalThis.window = {
  __ModuleLoader__: { load(module) { loaded.push(module) } },
  confirm(message) { confirms.push(message); return true },
}
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, body: init === undefined ? undefined : JSON.parse(init.body) })
  return { json: async () => fetchReply }
}

await import(pathToFileURL(join(PACKAGE_DIR, 'client.js')).href)

check('module registered under the package name', loaded.length === 1 && loaded[0].id === 'dsh-session-delete-cn', JSON.stringify(loaded.map(m => m.id)))

const mod = loaded[0].factory(() => ({}))
check('module declares the contextMenus dependency', Array.isArray(mod.inject) && mod.inject.includes('contextMenus'), JSON.stringify(mod.inject))

/**
 * @param localeActive - 模拟界面语言快照的 `active` 字段；传 null 表示没有 locale 服务。
 */
function makeCtx(localeActive) {
  const notifications = []
  const contributions = []
  const ctx = {
    get(name) {
      if (name !== 'locale') return undefined
      if (localeActive === null) return undefined
      // 真实接口：getLocale() 返回 { active, locales, revision }
      return { getLocale: () => ({ active: localeActive, locales: [], revision: 1 }) }
    },
    effect(fn) { fn(); return () => {} },
    contextMenus: {
      register(contribution) { contributions.push(contribution); return () => {} },
      notify(text, success) { notifications.push({ text, success }); },
    },
  }
  return { ctx, notifications, contributions }
}

// 1) registration shape, Chinese label with no locale service at all
{
  const { ctx, contributions } = makeCtx(null)
  mod.apply(ctx)
  check('one session contribution registered', contributions.length === 1)
  const c = contributions[0]
  check('target is session', c.target === 'session', String(c.target))
  check('ordered after archive', typeof c.order === 'number' && c.order > 600, String(c.order))
  const actions = c.resolve({ sessionId: 's1', displayTitle: '测试会话' })
  check('one danger action with separator', actions.length === 1 && actions[0].danger === true && actions[0].separatorBefore === true, JSON.stringify(actions[0] && actions[0].label))
  check('Chinese label without any locale service', actions[0].label === '彻底删除会话…', String(actions[0].label))
}

// 2) label stays Chinese even when the UI reports English
{
  const { ctx, contributions } = makeCtx('en-US')
  mod.apply(ctx)
  const actions = contributions[0].resolve({ sessionId: 's1', displayTitle: 'Demo' })
  check('Chinese label on an English GUI', actions[0].label === '彻底删除会话…', String(actions[0].label))
}

// 3) label stays Chinese on a Chinese GUI (the field that was read wrongly before)
{
  const { ctx, contributions } = makeCtx('zh')
  mod.apply(ctx)
  const actions = contributions[0].resolve({ sessionId: 's1', displayTitle: '中文界面' })
  check('Chinese label on a Chinese GUI', actions[0].label === '彻底删除会话…', String(actions[0].label))
}

// 4) confirm then delete, success notice
{
  confirms.length = 0
  fetchCalls = []
  fetchReply = { ok: true, detached: 1 }
  const { ctx, notifications, contributions } = makeCtx(null)
  mod.apply(ctx)
  const actions = contributions[0].resolve({ sessionId: 'session-abc', displayTitle: '要被删掉的会话' })
  await actions[0].run()
  check('confirm shown once with the title', confirms.length === 1 && confirms[0].includes('要被删掉的会话'), confirms[0])
  check('confirm says it is not archive', confirms[0].includes('不是「归档」'), confirms[0])
  check('POSTed the session id', fetchCalls.length === 1 && fetchCalls[0].url === '/dsh-session-delete-cn/delete' && fetchCalls[0].body.sessionId === 'session-abc', JSON.stringify(fetchCalls))
  check('success notice shown', notifications.length === 1 && notifications[0].success === true && notifications[0].text.includes('要被删掉的会话'), JSON.stringify(notifications))
}

// 5) cancelling the dialog touches nothing
{
  confirms.length = 0
  fetchCalls = []
  const original = globalThis.window.confirm
  globalThis.window.confirm = (message) => { confirms.push(message); return false }
  const { ctx, notifications, contributions } = makeCtx(null)
  mod.apply(ctx)
  const actions = contributions[0].resolve({ sessionId: 'session-abc', displayTitle: 'X' })
  await actions[0].run()
  globalThis.window.confirm = original
  check('cancel sends no request', fetchCalls.length === 0, JSON.stringify(fetchCalls))
  check('cancel shows no notice', notifications.length === 0, JSON.stringify(notifications))
}

// 6) host error reported, not thrown
{
  confirms.length = 0
  fetchCalls = []
  fetchReply = { ok: false, code: 'live' }
  const { ctx, notifications, contributions } = makeCtx(null)
  mod.apply(ctx)
  const actions = contributions[0].resolve({ sessionId: 'session-abc', displayTitle: 'X' })
  let threw = null
  try { await actions[0].run() } catch (error) { threw = error }
  check('live refusal does not throw', threw === null, String(threw && threw.message))
  check('live refusal reports the reason', notifications.length === 1 && notifications[0].success === false && notifications[0].text.includes('正在运行'), JSON.stringify(notifications))
}

// 7) missing confirm() degrades to a notice instead of deleting
{
  const original = globalThis.window.confirm
  delete globalThis.window.confirm
  const { ctx, notifications, contributions } = makeCtx(null)
  mod.apply(ctx)
  const actions = contributions[0].resolve({ sessionId: 'session-abc', displayTitle: 'X' })
  await actions[0].run()
  globalThis.window.confirm = original
  check('missing confirm() blocks the delete', notifications.length === 1 && notifications[0].success === false, JSON.stringify(notifications))
}

const failed = results.filter(r => r.pass !== true)
console.log('SUMMARY total=' + results.length + ' failed=' + failed.length)
if (failed.length > 0) process.exitCode = 1

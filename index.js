/**
 * dsh-session-delete-cn —— 彻底删除一个已保存的会话（Host 半）。
 *
 * 与"归档"的区别：归档只把会话从侧栏隐藏，日志文件仍在磁盘上；本插件删除的是
 * 会话目录本身（`<root>/<项目目录>/<会话目录>/`，含全部日志文件），不可恢复。
 *
 * 删除顺序刻意设计为「先归档 → 再删文件 → 最后摘除工作区账目」：
 *   1. 归档把行从侧栏隐藏，且归档要求会话仍然存在，所以必须在删文件之前做；
 *   2. 删文件失败时立刻撤销归档，保证"删除失败 = 行仍然可见"，不会留下
 *      "已隐藏但没删掉"的半删状态；
 *   3. 最后把会话 id 从工作区账目 detach 掉，侧栏那一行随之消失。
 *
 * 运行中 / 已被打开的会话一律拒绝删除（`ctx.sessions.get()` 命中即拒绝），
 * 避免删掉正在写入的日志。
 *
 * 依赖（inject）：webServer。其余服务经 ctx.get() 取得，缺失时返回明确错误码，
 * 不让整插件挂掉。
 */

import { rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

const TAG = '[dsh-session-delete-cn]'
const ROUTE = '/dsh-session-delete-cn/delete'

/** 只有 Web / Desktop 宿主才提供 HTTP 路由；缺 webServer 时本插件不激活。 */
export const inject = ['webServer']

function log(...args) {
  console.error(TAG, ...args)
}

function textOf(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value.text === 'string') return value.text
  try {
    return String(value)
  } catch {
    return ''
  }
}

/** 收集并解析 JSON 请求体；空体返回 {}，非法 JSON 返回 null。 */
async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 会话目录的段名是否"不像一个会话"——用来兜底拒绝误删项目目录或会话根目录。
 * 会话目录名来自持久化层自己给出的路径，正常永远不是这几种形态。
 */
function looksLikeContainer(segment) {
  return segment === ''
    || segment === '.'
    || segment === '..'
    || segment === 'sessions'
    || segment === '_no-cwd'
    || segment.startsWith('--')
}

/**
 * 彻底删除一个会话。
 * @param ctx - Host 插件上下文。
 * @param sessionId - 要删除的会话 id。
 * @returns 结果对象；成功为 `{ ok: true }`，失败为 `{ ok: false, code }`。
 */
async function purgeSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  const registry = ctx.get('workspaceRegistry')
  if (persistence === undefined || registry === undefined) {
    return { ok: false, code: 'unavailable' }
  }

  // 1) 运行中 / 已打开的会话拒绝删除。
  try {
    if (sessions !== undefined && typeof sessions.get === 'function' && sessions.get(sessionId) !== undefined) {
      return { ok: false, code: 'live' }
    }
  } catch (error) {
    log('live probe failed:', textOf(error && error.message))
  }

  // 2) 从持久化快照里取这个会话的存储位置（路径由后端给出，不由本插件拼接）。
  let snapshots
  try {
    snapshots = await persistence.list()
  } catch (error) {
    return { ok: false, code: 'list-failed', detail: textOf(error && error.message) }
  }
  const snapshot = Array.isArray(snapshots)
    ? snapshots.find(candidate => candidate && candidate.header && candidate.header.id === sessionId)
    : undefined
  if (snapshot === undefined) return { ok: false, code: 'missing' }
  const logPath = snapshot.location && typeof snapshot.location.path === 'string' ? snapshot.location.path : ''
  if (logPath === '') return { ok: false, code: 'no-location' }

  // 3) 只删「会话目录」本身，绝不碰它的上级。
  const dir = dirname(logPath)
  const parent = dirname(dir)
  if (dir === '' || parent === '' || parent === dir || looksLikeContainer(basename(dir))) {
    return { ok: false, code: 'unsafe-path', detail: dir }
  }

  // 4) 先归档（隐藏 + 阻止后续唤醒），失败不阻断删除本身。
  let archived = false
  try {
    await registry.archiveSession(sessionId, { stopActivity: true })
    archived = true
  } catch (error) {
    log('archive before delete failed (continuing):', textOf(error && error.message))
  }

  // 5) 删文件。失败则撤销归档，回到"什么都没变"。
  try {
    await rm(dir, { recursive: true, force: true })
  } catch (error) {
    if (archived) {
      try {
        await registry.unarchiveSession(sessionId)
      } catch (restoreError) {
        log('unarchive after failed delete failed:', textOf(restoreError && restoreError.message))
      }
    }
    return { ok: false, code: 'remove-failed', detail: textOf(error && error.message) }
  }

  // 6) 文件已消失，最后摘除工作区账目，侧栏那一行随之消失。
  let detached = 0
  try {
    for (const workspace of registry.list()) {
      if (workspace && Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) {
        await workspace.detachSession(sessionId)
        detached += 1
      }
    }
  } catch (error) {
    log('detach after delete failed:', textOf(error && error.message))
  }

  return { ok: true, path: dir, detached }
}

/**
 * 注册删除路由。
 * @param ctx - Host 插件上下文。
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, code: 'method-not-allowed' })
        return
      }
      const body = await readJsonBody(req)
      if (body === null || typeof body.sessionId !== 'string' || body.sessionId.trim() === '') {
        sendJson(res, 400, { ok: false, code: 'bad-args' })
        return
      }
      const outcome = await purgeSession(ctx, body.sessionId.trim())
      if (outcome.ok === true) {
        log('purged session', body.sessionId, '->', outcome.path)
        sendJson(res, 200, outcome)
        return
      }
      const status = outcome.code === 'live'
        ? 409
        : outcome.code === 'missing'
          ? 404
          : outcome.code === 'unsafe-path'
            ? 403
            : 500
      sendJson(res, status, outcome)
    },
  }), 'dsh-session-delete-cn: delete route')
  log('host ready: POST ' + ROUTE)
}

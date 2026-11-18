/**
 * dsh-session-delete-cn —— 会话右键/「…」菜单里的「彻底删除会话」（Client 半）。
 *
 * 形态：`dsh.client` web bundle，由 __ModuleLoader__ 加载的普通模块。
 *
 * 机制：注册到官方可扩展上下文菜单（`ctx.contextMenus`，target = 'session'），
 * 因此和置顶 / 重命名 / 分支 / 归档出现在同一个菜单里，样式、定位、键盘操作
 * 全部由宿主负责——不做任何 DOM 注入，也不依赖侧栏内部结构。
 * 真正删除由 Host 半的 POST /dsh-session-delete-cn/delete 完成（见 index.js）。
 *
 * 文案：固定中文，不读取界面语言。
 * （早先按 `ctx.locale.getLocale()` 的返回值切换中英文，但该快照的字段是 `active`
 * 而不是 `id`，读错字段导致永远回落到英文——所以现在直接去掉这层探测。）
 *
 * 注册 id 必须与 package.json 的 name 完全一致，否则浏览器半加载不到。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-delete-cn',
  factory: function (require) {
    var TEXT = {
      menuLabel: '彻底删除会话…',
      confirmBody: function (title) {
        return '将永久删除会话「' + title + '」的本地日志文件与工作区记录，无法恢复。\n\n'
          + '注意：这不是「归档」——归档能找回，彻底删除不能。\n\n确定继续？'
      },
      done: function (title) { return '已彻底删除会话「' + title + '」。' },
      errLive: '该会话正在运行或已被打开，无法删除。请先关闭它，或重启 DSH 后再删。',
      errMissing: '没有找到该会话的本地记录（可能已经被删除了）。',
      errUnsafe: '保存路径看起来不像会话目录，为安全起见已拒绝删除。',
      errRemove: '删除会话文件失败：',
      errUnavailable: '宿主缺少会话存储服务，无法删除。',
      errNetwork: '请求失败：宿主服务不可达。',
      errUnknown: '删除失败',
      confirmUnavailable: '当前环境不支持确认对话框，已取消删除。',
    }

    /** 把 Host 返回的错误码翻译成一句用户能看懂的话。 */
    function errorText(res) {
      if (res === null || res === undefined) return TEXT.errNetwork
      var detail = typeof res.detail === 'string' && res.detail !== '' ? '\n' + res.detail.slice(0, 300) : ''
      switch (res.code) {
        case 'live': return TEXT.errLive
        case 'missing': return TEXT.errMissing
        case 'unsafe-path': return TEXT.errUnsafe
        case 'remove-failed': return TEXT.errRemove + detail
        case 'unavailable': return TEXT.errUnavailable
        case 'list-failed': return TEXT.errRemove + detail
        default: return TEXT.errUnknown + (res.code ? '（' + String(res.code) + '）' : '') + detail
      }
    }

    function apply(ctx) {
      var menus = ctx.contextMenus
      if (menus === undefined || menus === null || typeof menus.register !== 'function') {
        console.error('[dsh-session-delete-cn] contextMenus 服务不可用，删除菜单项未注册')
        return
      }

      /** 执行删除：先向用户确认，再调 Host 路由，结果用宿主自己的通知条反馈。 */
      async function remove(target) {
        var title = String(target.displayTitle == null ? '' : target.displayTitle)
        var confirmFn = typeof window !== 'undefined' ? window.confirm : undefined
        if (typeof confirmFn !== 'function') {
          menus.notify(TEXT.confirmUnavailable, false)
          return
        }
        var accepted = false
        try {
          accepted = confirmFn.call(window, TEXT.confirmBody(title))
        } catch (e) {
          accepted = false
        }
        if (accepted !== true) return

        var res = null
        try {
          var response = await fetch('/dsh-session-delete-cn/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: target.sessionId }),
          })
          res = await response.json()
        } catch (e) {
          res = null
        }
        if (res !== null && res !== undefined && res.ok === true) {
          menus.notify(TEXT.done(title), true)
          return
        }
        menus.notify(errorText(res), false)
      }

      ctx.effect(function () {
        return menus.register({
          id: 'session.purge',
          target: 'session',
          order: 700,
          resolve: function (target) {
            return [{
              id: 'purge',
              label: TEXT.menuLabel,
              danger: true,
              separatorBefore: true,
              run: function () { return remove(target) },
            }]
          },
        })
      }, 'dsh-session-delete-cn: 会话菜单')
    }

    return { inject: ['contextMenus'], apply: apply }
  },
})

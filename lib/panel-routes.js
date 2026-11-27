/**
 * 面板的只读 JSON 路由 —— 宿主半与浏览器半之间唯一的通道。
 *
 * 文档明确不建议「宿主出 HTML、页面里 iframe 嵌入」（拿不到主题、明暗切换、
 * locale），而 typert Remote 对第三方手写 bundle 需要生成管线；所以走同一台
 * GUI 服务器上的一条只读路由，页面 fetch 轮询。
 *
 * 路由只读：GET 之外一律 405。真正的解析在 project-reader 里，视图模型的
 * 翻译在 panel-data 里，这里只做参数校验、序列化，以及把错误原样交回去。
 */

import { isAbsolute } from 'node:path'

import { projectDetail } from './panel-data.js'
import { createProjectReader } from './project-reader.js'

export const PANEL_PREFIX = '/manager-panel'
const PROJECTS_PATH = `${PANEL_PREFIX}/projects`
const PROJECT_PATH = `${PANEL_PREFIX}/project`
const GATE_PATH = `${PANEL_PREFIX}/gate`

/**
 * @param {object} [options]
 * @param {(input: { workspace: string }) => object} [options.createReader] 注入读取入口（测试用）
 * @param {(input: { workspace: string }) => object | null} [options.createState] 注入状态机
 */
export function createPanelApi({ createReader = createProjectReader, createState = null } = {}) {
  async function handle(request) {
    // 读与写共用一条前缀路由：读走 GET，裁决走 POST。
    const url = new URL(request.url)

    if (request.method === 'POST') return handleGate(request, url)

    if (request.method !== 'GET') {
      return json(405, { ok: false, problem: '面板路由只支持 GET 与 POST（裁决）' })
    }

    if (url.pathname === PROJECTS_PATH || url.pathname === PROJECT_PATH) {
      const workspace = (url.searchParams.get('workspace') ?? '').trim()
      if (!workspace) return json(400, { ok: false, problem: '缺少 workspace 参数' })
      if (!isAbsolute(workspace)) {
        return json(400, { ok: false, problem: `workspace 必须是绝对路径：${workspace}` })
      }

      const reader = createReader({ workspace })

      if (url.pathname === PROJECTS_PATH) {
        // 数据问题（工作区不存在、某个项目读不懂）都不是协议错误，仍然 200：
        // 面板据此显示可读文案，而不是当成网络失败。
        return json(200, reader.list())
      }

      const name = (url.searchParams.get('name') ?? '').trim()
      if (!name) return json(400, { ok: false, problem: '缺少 name 参数' })

      const result = reader.read(name)
      if (!result.ok) return json(200, result)
      return json(200, projectDetail(result.project, { updatedAt: result.updatedAt }))
    }

    return json(404, { ok: false, problem: `没有这条面板路由：${url.pathname}` })
  }

  /**
   * 用户裁决：批准计划 / 打回计划。
   *
   * 写操作只接受**同源** POST —— 本机端口能被任意本机页面访问，没有这道校验
   * 等于给所有本机网页开了一个改项目状态的入口。
   */
  async function handleGate(request, url) {
    if (url.pathname !== GATE_PATH) {
      return json(404, { ok: false, problem: `没有这条面板路由：${url.pathname}` })
    }
    if (!sameOrigin(request)) {
      return json(403, { ok: false, problem: '跨源请求被拒：面板的写操作只接受同源请求' })
    }
    if (!createState) {
      return json(500, { ok: false, problem: '宿主没有接上状态机，裁决无处提交' })
    }

    let body
    try {
      body = await request.json()
    } catch {
      return json(400, { ok: false, problem: '请求体不是合法 JSON' })
    }

    const workspace = textOf(body?.workspace)
    const name = textOf(body?.name)
    const gate = textOf(body?.gate)
    const reason = textOf(body?.reason)

    if (!workspace) return json(400, { ok: false, problem: '缺少 workspace' })
    if (!isAbsolute(workspace)) {
      return json(400, { ok: false, problem: `workspace 必须是绝对路径：${workspace}` })
    }
    if (!name) return json(400, { ok: false, problem: '缺少项目名' })

    const state = createState({ workspace })

    // 每个裁决都只是「以用户身份调用状态机的一个方法」：成功给一句话，失败给原文。
    const run = (action, success) => {
      const result = action()
      const text = typeof success === 'function' ? success(result) : success
      return json(200, result.ok ? { ok: true, text } : { ok: false, problem: result.problem })
    }

    if (gate === 'approve') return run(() => state.approvePlan({ by: 'user', project: name }), '计划已批准')
    if (gate === 'reject') return run(() => state.rejectPlan({ by: 'user', project: name, reason }), '计划已驳回')
    if (gate === 'confirm') {
      return run(() => state.confirmPart({ by: 'user', project: name, reason }), (result) => `部分 ${result.part.id} 已确认，循环可以继续了`)
    }
    if (gate === 'accept') {
      return run(() => state.acceptProject({ by: 'user', project: name, reason }), '收尾验收已确认 —— 项目完成')
    }
    if (gate === 'decline') {
      // 和命令一样：先打回部分，没有待确认的部分时再打回收尾验收。
      const part = state.declinePart({ by: 'user', project: name, reason })
      if (part.ok) return json(200, { ok: true, text: `部分 ${part.part.id} 已打回，会重新派分` })
      const acceptance = state.declineAcceptance({ by: 'user', project: name, reason })
      if (acceptance.ok) return json(200, { ok: true, text: '收尾验收已打回，改完再跑一遍验收标准' })
      return json(200, { ok: false, problem: part.problem })
    }

    return json(400, { ok: false, problem: `不认识的裁决：${gate || '（空）'}` })
  }

  return { handle }
}

/**
 * 跨站请求必须带自己的 Origin，所以「有 Origin 且与 Host 不一致」一定拒。
 * 桌面端页面以 file:// 承载时 Origin 会是 null 或缺失 —— 那不是跨站页面，
 * 放行；真正的跨站页面不会省略 Origin。
 */
function sameOrigin(request) {
  const origin = request.headers.get('origin')
  const host = request.headers.get('host')
  if (!origin || origin === 'null') return true
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** 裁决路由的 HTTP 壳：IncomingMessage → Request → api.handle → ServerResponse。 */
export function createGateHandler(api, { maxBody = 64 * 1024 } = {}) {
  return async function handleGateRequest(req, res) {
    try {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, problem: '面板裁决只接受 POST' }, { allow: 'POST' })
        return
      }

      const body = await readBody(req, maxBody)
      const host = req.headers?.host ?? 'localhost'
      const request = new Request(new URL(req.url ?? '/', `http://${host}`), {
        method: 'POST',
        headers: {
          origin: req.headers?.origin ?? '',
          host,
          'content-type': req.headers?.['content-type'] ?? 'application/json',
        },
        body,
      })

      const response = await api.handle(request)
      res.statusCode = response.status
      response.headers.forEach((value, key) => res.setHeader(key, value))
      res.end(await response.text())
    } catch (error) {
      send(res, 500, { ok: false, problem: `面板裁决没跑起来：${reasonOf(error)}` })
    }
  }
}

async function readBody(req, maxBody) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBody) throw new Error('请求体太大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function send(res, status, payload, extra = {}) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  for (const [key, value] of Object.entries(extra)) res.setHeader(key, value)
  res.end(JSON.stringify(payload))
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

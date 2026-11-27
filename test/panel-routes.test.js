import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PANEL_PREFIX, createGateHandler, createPanelApi } from '../lib/panel-routes.js'
import { createProjectState } from '../lib/project-state.js'
import { createFsStore } from '../lib/store.js'
import { judged } from './fixtures.js'

/** 绝对路径要按平台取：CI 跑在 Linux 上，`C:\work` 在那边不是绝对路径。 */
const WORKSPACE = process.platform === 'win32' ? 'C:\\work' : '/work'

function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-panel-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function makeProject(dir, name) {
  const state = createProjectState({
    store: createFsStore(join(dir, '.scratch')),
    runCommand: () => ({ code: 0, output: 'ok' }),
  })
  const result = state.startProject({ name, goal: '做点事', acceptance: judged(['能看见']) })
  assert.equal(result.ok, true, result.problem)
  return result.slug
}

async function call(api, path, { method = 'GET' } = {}) {
  const response = await api.handle(new Request(`http://local${path}`, { method }))
  return { status: response.status, body: await response.json() }
}

test('缺 workspace 参数时是协议错误，不是空列表', async () => {
  const { status, body } = await call(createPanelApi(), `${PANEL_PREFIX}/projects`)
  assert.equal(status, 400)
  assert.equal(body.ok, false)
  assert.match(body.problem, /workspace/)
})

test('相对路径被拒 —— 只接受工作区绝对路径', async () => {
  const api = createPanelApi()
  const { status, body } = await call(api, `${PANEL_PREFIX}/projects?workspace=.%2Fsomewhere`)
  assert.equal(status, 400)
  assert.match(body.problem, /绝对路径/)
})

test('给定工作区路径返回该工作区的项目列表', async () => {
  const { dir, cleanup } = temp()
  try {
    makeProject(dir, 'demo')
    const api = createPanelApi()

    const { status, body } = await call(
      api,
      `${PANEL_PREFIX}/projects?workspace=${encodeURIComponent(dir)}`,
    )

    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.deepEqual(
      body.projects.map((item) => [item.slug, item.name, item.phase, item.ok]),
      [['demo', 'demo', 'planning', true]],
    )
  } finally {
    cleanup()
  }
})

test('工作区不存在时仍回 200，理由在 payload 里（面板要能读出来）', async () => {
  const { dir, cleanup } = temp()
  try {
    const missing = join(dir, 'gone')
    const { status, body } = await call(
      createPanelApi(),
      `${PANEL_PREFIX}/projects?workspace=${encodeURIComponent(missing)}`,
    )

    assert.equal(status, 200)
    assert.equal(body.ok, false)
    assert.match(body.problem, /工作区不存在/)
  } finally {
    cleanup()
  }
})

test('读路径只接受 GET：其它方法 405，POST 只留给裁决路径', async () => {
  const api = createPanelApi()
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const { status } = await call(api, `${PANEL_PREFIX}/projects`, { method })
    assert.equal(status, 405, method)
  }

  const posted = await call(api, `${PANEL_PREFIX}/projects`, { method: 'POST' })
  assert.equal(posted.status, 404)
})

test('不存在的面板路由是 404，并说明是哪条', async () => {
  const { status, body } = await call(createPanelApi(), `${PANEL_PREFIX}/nope`)
  assert.equal(status, 404)
  assert.match(body.problem, /nope/)
})

test('路由只读：读取入口被调用一次、参数只有 workspace', async () => {
  const seen = []
  const api = createPanelApi({
    createReader: (input) => {
      seen.push(input)
      return { list: () => ({ ok: true, projects: [] }) }
    },
  })

  await call(api, `${PANEL_PREFIX}/projects?workspace=${encodeURIComponent(WORKSPACE)}`)

  assert.deepEqual(seen, [{ workspace: WORKSPACE }])
})

/** 裁决请求：默认同源，方便只测业务分支。 */
async function gate(api, { origin = 'http://local', host = 'local', body, path = `${PANEL_PREFIX}/gate` }) {
  const headers = { 'content-type': 'application/json' }
  if (origin !== null) headers.origin = origin
  if (host !== null) headers.host = host

  const response = await api.handle(
    new Request(`http://local${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
    }),
  )
  return { status: response.status, body: await response.json() }
}

function fakeState(overrides = {}) {
  const calls = []
  const api = createPanelApi({
    createState: ({ workspace }) => ({
      workspace,
      approvePlan: (input) => {
        calls.push(['approvePlan', input])
        return overrides.approve ?? { ok: true }
      },
      rejectPlan: (input) => {
        calls.push(['rejectPlan', input])
        return overrides.reject ?? { ok: true }
      },
      confirmPart: (input) => {
        calls.push(['confirmPart', input])
        return overrides.confirm ?? { ok: true, part: { id: 'P1' } }
      },
      declinePart: (input) => {
        calls.push(['declinePart', input])
        return overrides.declinePart ?? { ok: true, part: { id: 'P1' } }
      },
      declineAcceptance: (input) => {
        calls.push(['declineAcceptance', input])
        return overrides.declineAcceptance ?? { ok: true }
      },
      acceptProject: (input) => {
        calls.push(['acceptProject', input])
        return overrides.accept ?? { ok: true }
      },
    }),
  })
  return { api, calls }
}

test('确认、收尾验收、打回走同一个裁决入口，身份仍是用户', async () => {
  const { api, calls } = fakeState()

  const confirm = await gate(api, { body: { workspace: WORKSPACE, name: 'demo', gate: 'confirm' } })
  assert.equal(confirm.status, 200)
  assert.match(confirm.body.text, /P1/)

  const accept = await gate(api, { body: { workspace: WORKSPACE, name: 'demo', gate: 'accept' } })
  assert.equal(accept.status, 200)
  assert.match(accept.body.text, /完成/)

  const decline = await gate(api, {
    body: { workspace: WORKSPACE, name: 'demo', gate: 'decline', reason: '不行' },
  })
  assert.equal(decline.status, 200)
  assert.match(decline.body.text, /P1/)

  assert.deepEqual(
    calls.map(([name]) => name),
    ['confirmPart', 'acceptProject', 'declinePart'],
  )
  assert.equal(calls[0][1].by, 'user')
  assert.equal(calls[2][1].reason, '不行')
})

test('打回在部分不成立时落到收尾验收；两边都不成立就透传部分的原因', async () => {
  const fallback = fakeState({
    declinePart: { ok: false, problem: '没有待确认的部分' },
    declineAcceptance: { ok: true },
  })
  const { body } = await gate(fallback.api, {
    body: { workspace: WORKSPACE, name: 'demo', gate: 'decline', reason: '重做' },
  })
  assert.match(body.text, /收尾验收/)

  const both = fakeState({
    declinePart: { ok: false, problem: '没有待确认的部分' },
    declineAcceptance: { ok: false, problem: '收尾验收也没在等你' },
  })
  const failed = await gate(both.api, {
    body: { workspace: WORKSPACE, name: 'demo', gate: 'decline', reason: '重做' },
  })
  assert.equal(failed.body.ok, false)
  assert.equal(failed.body.problem, '没有待确认的部分')
})

test('桌面端没有 Origin（file:// 承载）时放行，因为跨站页面不会省略它', async () => {
  const { api, calls } = fakeState()
  const { status, body } = await gate(api, {
    origin: null,
    body: { workspace: WORKSPACE, name: 'demo', gate: 'approve' },
  })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(calls, [['approvePlan', { by: 'user', project: 'demo' }]])
})

test('Origin 为 null 同样放行 —— 桌面端 fetch 实际带的就是 null', async () => {
  const { api } = fakeState()
  const { status } = await gate(api, {
    origin: 'null',
    body: { workspace: WORKSPACE, name: 'demo', gate: 'approve' },
  })
  assert.equal(status, 200)
})

test('Origin 与 Host 不一致时被拒，跨源页面发不进来', async () => {
  const { api, calls } = fakeState()
  const { status } = await gate(api, {
    origin: 'http://evil.example',
    host: '127.0.0.1:56695',
    body: { workspace: WORKSPACE, name: 'demo', gate: 'approve' },
  })
  assert.equal(status, 403)
  assert.deepEqual(calls, [])
})

test('同源批准计划：身份固定为用户，项目名原样交给状态机', async () => {
  const { api, calls } = fakeState()
  const { status, body } = await gate(api, {
    body: { workspace: WORKSPACE, name: '面板演示', gate: 'approve' },
  })

  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(calls, [['approvePlan', { by: 'user', project: '面板演示' }]])
})

test('同源打回：理由原样交给状态机，状态机的拒绝原文透传回来', async () => {
  const { api, calls } = fakeState({ reject: { ok: false, problem: '驳回必须写理由' } })
  const { status, body } = await gate(api, {
    body: { workspace: WORKSPACE, name: 'demo', gate: 'reject', reason: '   ' },
  })

  assert.equal(status, 200)
  assert.equal(body.ok, false)
  assert.equal(body.problem, '驳回必须写理由')
  assert.deepEqual(calls, [['rejectPlan', { by: 'user', project: 'demo', reason: '' }]])
})

test('不认识的裁决与没有接上状态机时都说清楚，而不是假装成功', async () => {
  const { api } = fakeState()
  const unknown = await gate(api, {
    body: { workspace: WORKSPACE, name: 'demo', gate: 'abandon' },
  })
  assert.equal(unknown.status, 400)
  assert.match(unknown.body.problem, /abandon/)

  const noState = createPanelApi()
  const missing = await gate(noState, {
    body: { workspace: WORKSPACE, name: 'demo', gate: 'approve' },
  })
  assert.equal(missing.status, 500)
})

test('POST 到别的路径是 404，不是静默成功', async () => {
  const { api } = fakeState()
  const { status } = await gate(api, {
    path: `${PANEL_PREFIX}/projects`,
    body: { workspace: WORKSPACE, name: 'demo', gate: 'approve' },
  })
  assert.equal(status, 404)
})

/** 裁决的 HTTP 壳：resource 路由只服务 GET/HEAD，写必须自己拥有请求生命周期。 */
function fakeExchange({ method = 'POST', headers = {}, body = '{}', url = `${PANEL_PREFIX}/gate` }) {
  const res = { statusCode: 0, headers: {}, body: '' }
  res.setHeader = (key, value) => {
    res.headers[key.toLowerCase()] = value
  }
  res.end = (text) => {
    res.body = String(text ?? '')
  }
  const req = {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body)
    },
  }
  return { req, res }
}

test('handler 壳把 POST 正文转给裁决：同源批准成功并回 JSON', async () => {
  const { api, calls } = fakeState()
  const handle = createGateHandler(api)
  const { req, res } = fakeExchange({
    headers: { host: '127.0.0.1:56695', origin: 'http://127.0.0.1:56695', 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: WORKSPACE, name: 'demo', gate: 'approve' }),
  })

  await handle(req, res)

  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true, text: '计划已批准' })
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.deepEqual(calls, [['approvePlan', { by: 'user', project: 'demo' }]])
})

test('handler 壳：GET 回 405，跨源写回 403，正文非 JSON 回 400', async () => {
  const { api } = fakeState()
  const handle = createGateHandler(api)

  const asGet = fakeExchange({ method: 'GET', headers: { host: 'h', origin: 'http://h' } })
  await handle(asGet.req, asGet.res)
  assert.equal(asGet.res.statusCode, 405)
  assert.equal(asGet.res.headers.allow, 'POST')

  const crossOrigin = fakeExchange({
    headers: { host: '127.0.0.1:56695', origin: 'http://evil.example' },
    body: JSON.stringify({ workspace: WORKSPACE, name: 'demo', gate: 'approve' }),
  })
  await handle(crossOrigin.req, crossOrigin.res)
  assert.equal(crossOrigin.res.statusCode, 403)

  const broken = fakeExchange({
    headers: { host: '127.0.0.1:56695', origin: 'http://127.0.0.1:56695' },
    body: 'not json',
  })
  await handle(broken.req, broken.res)
  assert.equal(broken.res.statusCode, 400)
})

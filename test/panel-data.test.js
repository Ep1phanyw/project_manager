import { test } from 'node:test'
import assert from 'node:assert/strict'

import { projectDetail } from '../lib/panel-data.js'
import { createProjectState } from '../lib/project-state.js'
import { memoryStore } from './memory-store.js'
import { checked, judged } from './fixtures.js'

function approvedProject() {
  const store = memoryStore()
  const state = createProjectState({ store, runCommand: () => ({ code: 0, output: 'ok' }) })
  state.startProject({ name: 'demo', goal: '把登录流程做出来', acceptance: checked(['能登录']) })
  state.submitPlan({
    parts: [{ title: '做登录页', files: ['src/login.js'], evidence: 'test', covers: ['AC-1'] }],
  })
  state.approvePlan({ by: 'user' })
  const { project } = state.status()
  return { state, project }
}

test('详情把头部、标准、部分与审批翻成面板要的形状', () => {
  const { project } = approvedProject()

  const detail = projectDetail(project, { updatedAt: '2026-01-01T00:00:00.000Z' })

  assert.equal(detail.ok, true)
  assert.equal(detail.updatedAt, '2026-01-01T00:00:00.000Z')
  assert.deepEqual(
    [detail.project.name, detail.project.phase, detail.project.phaseLabel, detail.project.approved],
    ['demo', 'executing', '执行', true],
  )
  assert.deepEqual(detail.criteria, [
    {
      id: 'AC-1',
      text: '能登录',
      check: '命令 check',
      covering: ['P1'],
      pendingApproval: false,
    },
  ])
  assert.deepEqual(
    detail.parts.map((part) => [part.id, part.title, part.evidence, part.statusLabel, part.attempts]),
    [['P1', '做登录页', 'test', '未开始', 0]],
  )
  assert.equal(detail.approvals.length, 1)
  assert.equal(detail.approvals[0].kind, 'approved')
  assert.equal(detail.approvals[0].kindLabel, '批准')
  assert.deepEqual(detail.pending, [])
  assert.deepEqual(detail.final, { state: 'none' })
})

test('待确认的部分出现在「待你确认」，带摘要与证据原文', () => {
  const { project } = approvedProject()

  const detail = projectDetail({
    ...project,
    partStatus: { P1: 'needs-user-verification' },
    records: [
      {
        partId: 'P1',
        status: 'needs-user-verification',
        summary: '界面做完了，请看眼',
        evidence: ['截图见 docs/a.png', '第二行'],
      },
    ],
  })

  assert.deepEqual(detail.pending, [
    {
      kind: 'part',
      partId: 'P1',
      title: '做登录页',
      summary: '界面做完了，请看眼',
      evidence: ['截图见 docs/a.png', '第二行'],
    },
  ])
})

test('收尾验收的四态：未到、待跑、等确认、被打回、已完成', () => {
  const { project } = approvedProject()

  assert.deepEqual(projectDetail({ ...project, allPartsVerified: false }).final, { state: 'none' })

  assert.deepEqual(
    projectDetail({ ...project, allPartsVerified: true, acceptancePending: false }).final,
    { state: 'needs-run' },
  )

  const pending = projectDetail({
    ...project,
    allPartsVerified: true,
    acceptancePending: true,
    acceptanceRun: [{ status: 'needs-user-verification', summary: '整体跑过了', evidence: ['node test/run.js 通过'] }],
  })
  assert.deepEqual(pending.final, {
    state: 'pending-confirmation',
    summary: '整体跑过了',
    evidence: ['node test/run.js 通过'],
  })
  assert.deepEqual(
    pending.pending.map((item) => [item.kind, item.title]),
    [['acceptance', '收尾验收']],
  )

  assert.deepEqual(
    projectDetail({
      ...project,
      allPartsVerified: true,
      acceptanceRun: [{ status: 'returned', reason: '整体检查没过' }],
    }).final,
    { state: 'returned', reason: '整体检查没过' },
  )

  assert.deepEqual(
    projectDetail({ ...project, allDone: true, allPartsVerified: true }).final.state,
    'done',
  )
})

test('越界改动、退役编号、读不懂的问题都如实交给面板', () => {
  const { project } = approvedProject()

  const detail = projectDetail({
    ...project,
    acceptanceIds: [
      { id: 'AC-1', retired: false },
      { id: 'AC-2', retired: true },
    ],
    partStatus: { P1: 'accepted' },
    attempts: { P1: 2 },
    records: [
      { partId: 'P1', status: 'accepted', summary: '好了', evidence: ['ok'], stray: ['src/other.js'], strayUnreliable: true },
    ],
    planProblem: '',
    recordsProblem: '第 3 行读不懂',
    acceptanceRunProblem: '第 1 行读不懂',
    acceptanceProblem: '验收标准在这次批准之后被改过',
    legacy: true,
  })

  assert.deepEqual(detail.retiredCriteria, ['AC-2'])
  assert.deepEqual(detail.parts[0].stray, ['src/other.js'])
  assert.equal(detail.parts[0].strayUnreliable, true)
  assert.equal(detail.parts[0].attempts, 2)
  assert.deepEqual(detail.problems, {
    legacy: '旧格式项目：只能看，要动先迁移',
    acceptance: '验收标准在这次批准之后被改过',
    records: '第 3 行读不懂',
    acceptanceRun: '第 1 行读不懂',
  })
})

test('待批准检查的标准会被标出来，而不是当成已批准', () => {
  const store = memoryStore()
  const state = createProjectState({ store, runCommand: () => ({ code: 0, output: 'ok' }) })
  state.startProject({
    name: 'demo',
    goal: '做点事',
    acceptance: [checked(['能登录'])[0], judged(['界面顺眼'])[0]],
  })
  state.submitPlan({ parts: [{ title: '做', files: ['a.js'], evidence: 'test', covers: ['AC-1', 'AC-2'] }] })
  // 直接构造：只有 AC-1 的检查被批准过。
  const { project } = state.status()

  const detail = projectDetail({
    ...project,
    checkApprovals: [{ id: 'AC-1', hash: 'x' }],
    pendingCriteria: ['AC-2'],
  })

  assert.deepEqual(
    detail.criteria.map((item) => [item.id, item.pendingApproval]),
    [
      ['AC-1', false],
      ['AC-2', true],
    ],
  )
})

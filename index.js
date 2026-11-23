/**
 * dsh-manager — 项目编排插件的宿主半侧入口。
 *
 * 模型开车：这里只提供工具与命令，驾驶由主对话自己做。
 * 状态落在会话工作区的 `.scratch/` 下，是普通 markdown。
 */

import { join } from 'node:path'

import { formatStatus } from './lib/format.js'
import { EVIDENCE_TYPES, createProjectState } from './lib/project-state.js'
import { createFsStore } from './lib/store.js'

export const name = 'dsh-manager'

/** 三个都是硬依赖：少一个就不该半装好地跑起来。 */
export const inject = ['commands', 'tools', 'workingDirectory']

const COMMAND_NAME = 'manager'
const STATUS_KEYWORD = 'status'
const APPROVE_KEYWORD = 'approve'
const REJECT_KEYWORD = 'reject'

/** 两个工具的结果形状一致：一句给人看的话。 */
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      text: { type: 'string' },
    },
    required: ['ok', 'text'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

export function apply(ctx) {
  /** 每次调用都按它所在会话的工作区解析状态目录，状态天然跟随会话。 */
  async function stateFor(agent) {
    const workspace = await ctx.workingDirectory.ensure(agent)
    return createProjectState({
      store: createFsStore(join(workspace, '.scratch')),
      commandName: COMMAND_NAME,
    })
  }

  registerTool(ctx, stateFor, {
    name: 'manager_start',
    description:
      '启动一个项目：写下它的目标与逐条验收标准。状态落在会话工作区的 .scratch/ 下。项目名同时用作目录名，重名会被拒绝。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '项目名，同时用作 .scratch/ 下的目录名' },
        goal: { type: 'string', description: '这个项目要达到什么，一段话' },
        acceptance: {
          type: 'array',
          items: { type: 'string' },
          description: '逐条可核对的验收标准；「做好了」不算，每条都要能产出证据',
        },
      },
      required: ['name', 'goal', 'acceptance'],
      additionalProperties: false,
    },
    async run(args, state) {
      const result = state.startProject(args)
      if (!result.ok) return result

      return {
        ok: true,
        text: `项目「${result.slug}」已创建，目标与验收标准写在 .scratch/${result.slug}/ 下。`,
      }
    },
  })

  registerTool(ctx, stateFor, {
    name: 'manager_plan',
    description:
      '提交项目计划：每个部分声明它依赖哪些部分、会改哪些文件、用什么证据说明自己做完了。依赖成环、或者两个部分改同一批文件却没有先后关系，都会被拒绝。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目名；当前只有一个项目时可以省略' },
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '部分编号，形如 P1；省略则按顺序生成' },
              title: { type: 'string', description: '这部分要做什么' },
              dependsOn: {
                type: 'array',
                items: { type: 'string' },
                description: '必须先完成的部分编号',
              },
              files: {
                type: 'array',
                items: { type: 'string' },
                description: '这部分会改动的文件或目录',
              },
              evidence: {
                type: 'string',
                enum: EVIDENCE_TYPES,
                description: '这部分靠什么证据说明完成',
              },
            },
            required: ['title', 'files', 'evidence'],
            additionalProperties: false,
          },
        },
      },
      required: ['parts'],
      additionalProperties: false,
    },
    async run(args, state) {
      const result = state.submitPlan(args)
      if (!result.ok) return result

      return { ok: true, text: `计划已记录，共 ${result.count} 个部分。` }
    },
  })

  ctx.effect(
    () =>
      ctx.commands.register({
        name: COMMAND_NAME,
        description:
          '项目状态、计划与审批：/manager（或 status）看状态，/manager approve 批准计划，/manager reject [理由] 驳回，/manager <项目名> 指定项目',
        input: { hint: '[status | approve | reject [理由] | 项目名]' },
        async handler(invocation) {
          const state = await stateFor(invocation.agent)
          const raw = invocation.rawInput.trim()
          const [keyword, ...rest] = raw.split(/\s+/)

          if (keyword === APPROVE_KEYWORD) {
            const result = state.approvePlan({
              by: 'user',
              project: rest.join(' ').trim() || undefined,
            })
            if (!result.ok) return { kind: 'error', text: result.problem }
            return { kind: 'success', text: '计划已批准，可以开始派分部分了。' }
          }

          if (keyword === REJECT_KEYWORD) {
            const result = state.rejectPlan({ by: 'user', reason: rest.join(' ') })
            if (!result.ok) return { kind: 'error', text: result.problem }
            return { kind: 'success', text: '计划已驳回，回到规划阶段，可以重新提交。' }
          }

          // 项目名可能带空格，所以这里用整行而不是第一个词。
          const requested = keyword === STATUS_KEYWORD ? '' : raw
          const result = state.status(requested)

          if (!result.ok) return { kind: 'error', text: result.problem }
          return { kind: 'success', text: formatStatus(result.project) }
        },
      }),
    'dsh-manager: /manager command',
  )
}

/**
 * 两个工具的接线是一样的：解析会话工作区 → 交给状态机 → 失败就抛错。
 * 抛错而不是返回 ok:false，是为了让护栏落在工具返回值上：模型看到的是一次失败。
 */
function registerTool(ctx, stateFor, { name, description, parameters, run }) {
  ctx.effect(
    () =>
      ctx.tools.register({
        name,
        description,
        parameters,
        output: TEXT_OUTPUT,
        async execute(args, exec) {
          const state = await stateFor(exec.agent)
          const result = await run(args, state)
          if (!result.ok) throw new Error(result.problem)
          return { ok: true, text: result.text }
        },
      }),
    `dsh-manager: ${name} tool`,
  )
}

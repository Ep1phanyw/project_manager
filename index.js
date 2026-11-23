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
export const inject = ['commands', 'tools', 'workingDirectory', 'subagents']

const TOOL_START = 'manager_start'
const TOOL_PLAN = 'manager_plan'
const TOOL_RUN = 'manager_run'
const TOOL_VERIFY = 'manager_verify'
const TOOL_BLOCK = 'manager_block'
const COMMAND_NAME = 'manager'
const STATUS_KEYWORD = 'status'
const APPROVE_KEYWORD = 'approve'
const REJECT_KEYWORD = 'reject'

/** 子对话必须按这个形状回报，所以回报不靠解析自由文本。 */
const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['done', 'needs-user-verification', 'blocked'],
      description: '这一部分的结果',
    },
    summary: { type: 'string', description: '一两句话说明做了什么、结果如何' },
    evidence: {
      type: 'array',
      items: { type: 'string' },
      description:
        '可复现的证据。每条以证据类型开头，例如「test：node --test 全绿」「command：ls 输出」；报完成时至少要有一条是这部分要求的类型',
    },
    blockedReason: { type: 'string', description: '仅当 status 为 blocked 时必填：需要用户提供什么' },
    blockedCondition: {
      type: 'string',
      enum: ['repeated-failure', 'missing-user-input', 'criteria-change'],
      description:
        '仅当 status 为 blocked 时必填：阻塞属于哪一种情形。repeated-failure 由插件自己数，不要自己声称',
    },
  },
  required: ['status', 'summary', 'evidence'],
  additionalProperties: false,
}

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
      runChild: childRunner(ctx, agent, workspace),
    })
  }

  registerTool(ctx, stateFor, {
    name: TOOL_START,
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
    name: TOOL_PLAN,
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

  registerTool(ctx, stateFor, {
    name: TOOL_RUN,
    description:
      '跑下一个可派分的部分：起一个独立上下文的子对话去做它，把结构化回报记进项目。子对话失败或回报不合规时记为可重试，不会让项目崩掉。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目名；当前只有一个项目时可以省略' },
      },
      additionalProperties: false,
    },
    async run(args, state, exec) {
      const result = await state.dispatchNext({ project: args?.project, signal: exec.signal })
      if (!result.ok) {
        return {
          ok: false,
          problem: result.retryable ? `${result.problem}（可重试）` : result.problem,
        }
      }

      return {
        ok: true,
        text: `部分 ${result.part.id}「${result.part.title}」第 ${result.attempt} 次回报：${result.report.status}。${result.report.summary}`,
      }
    },
  })

  registerTool(ctx, stateFor, {
    name: TOOL_VERIFY,
    description:
      '验收一个部分。子对话说完成只是候选，这里才决定算不算数：pass 要拿证据对上验收标准并写明理由；fail 要写明差在哪，该部分会被重新派分。',
    parameters: {
      type: 'object',
      properties: {
        part: { type: 'string', description: '部分编号，形如 P1' },
        verdict: { type: 'string', enum: ['pass', 'fail'], description: '验收结论' },
        reason: {
          type: 'string',
          description: 'pass 时写它怎么对上验收标准；fail 时写差在哪',
        },
        project: { type: 'string', description: '项目名；当前只有一个项目时可以省略' },
      },
      required: ['part', 'verdict', 'reason'],
      additionalProperties: false,
    },
    async run(args, state) {
      const result = state.verifyPart(args)
      if (!result.ok) return result

      return {
        ok: true,
        text:
          result.verdict === 'pass'
            ? `部分 ${result.part.id} 验收通过。`
            : `部分 ${result.part.id} 验收不通过，已回到可派分。`,
      }
    },
  })

  registerTool(ctx, stateFor, {
    name: TOOL_BLOCK,
    description:
      '请求阻塞，或查看当前的阻塞报告。只有三种情形可以阻塞：缺少只有用户能提供的东西、需要改动验收标准本身、同一部分连续两次同样的验收失败（后者由插件自己数，不由你声称）。不给 condition 时返回当前阻塞报告。',
    parameters: {
      type: 'object',
      properties: {
        part: { type: 'string', description: '部分编号，形如 P1；不给 condition 时忽略' },
        condition: {
          type: 'string',
          enum: ['missing-user-input', 'criteria-change', 'repeated-failure'],
          description: '阻塞属于哪一种情形',
        },
        detail: { type: 'string', description: '缺什么、或者为什么现有验收标准做不到' },
        project: { type: 'string', description: '项目名；当前只有一个项目时可以省略' },
      },
      additionalProperties: false,
    },
    async run(args, state) {
      if (!args?.condition) {
        const report = state.blockReport({ project: args?.project })
        if (!report.ok) return report
        return { ok: true, text: report.text }
      }

      const result = state.requestBlock(args)
      if (!result.ok) return result

      return { ok: true, text: `部分 ${result.part.id} 已记为阻塞；把需要用户做的事摊清楚再停。` }
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
          const result = await run(args, state, exec)
          if (!result.ok) throw new Error(result.problem)
          return { ok: true, text: result.text }
        },
      }),
    `dsh-manager: ${name} tool`,
  )
}

/**
 * 起一个独立上下文的子对话去做一个部分。
 *
 * provider `spawn` 不继承父会话的上下文 —— 这正是「子对话只看得到这一部分」
 * 的实现方式。结果靠 outputSchema 校验过的结构化对象拿回来，不解析自由文本。
 */
function childRunner(ctx, parent, workspace) {
  return async ({ part, prompt, signal }) => {
    if (!parent) return { ok: false, problem: '没有会话上下文，起不了子对话' }

    const activation = await ctx.subagents.startActivation({
      provider: 'spawn',
      label: `dsh-manager ${part.id}`,
      prompt: [{ type: 'text', text: prompt }],
      parent,
      cwd: workspace,
      signal,
      delivery: 'parent',
      outputSchema: REPORT_SCHEMA,
    })

    try {
      const result = await activation.result
      const report = readReport(result)
      if (!report) {
        const reason = result?.stopReason ?? '未知'
        return { ok: false, problem: `子对话没有按约定回报（stopReason: ${reason}）` }
      }
      return { ok: true, report, sessionId: String(activation.childId ?? '') }
    } catch (error) {
      return { ok: false, problem: error instanceof Error ? error.message : String(error) }
    } finally {
      try {
        await activation.dispose?.()
      } catch {
        // 已经结束的激活无需再清理
      }
    }
  }
}

/** 回报只认 outputSchema 校验过的结构化对象；拿不到就是没按约定回报。 */
function readReport(result) {
  return result?.structured && typeof result.structured === 'object' ? result.structured : null
}

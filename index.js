/**
 * dsh-manager — 项目编排插件的宿主半侧入口。
 *
 * 模型开车：这里只提供工具与命令，驾驶由主对话自己做。
 * 状态落在会话工作区的 `.scratch/` 下，是普通 markdown。
 */

import { join } from 'node:path'

import { createOrchestrator, formatStatus } from './lib/orchestrator.js'
import { createFsStore } from './lib/store.js'

export const name = 'dsh-manager'

/** 三个都是硬依赖：少一个就不该半装好地跑起来。 */
export const inject = ['commands', 'tools', 'workingDirectory']

const TOOL_NAME = 'manager_start'
const COMMAND_NAME = 'manager'

export function apply(ctx) {
  /** 每次调用都按它所在会话的工作区解析状态目录，状态天然跟随会话。 */
  async function orchestratorFor(agent) {
    const workspace = await ctx.workingDirectory.ensure(agent)
    return createOrchestrator({ store: createFsStore(join(workspace, '.scratch')) })
  }

  ctx.effect(
    () =>
      ctx.tools.register({
        name: TOOL_NAME,
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
              description: '逐条可核对的验收标准；「做好了」不算，要能产出证据',
            },
          },
          required: ['name', 'goal', 'acceptance'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              slug: { type: 'string' },
              text: { type: 'string' },
            },
            required: ['ok', 'text'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
        },
        async execute(args, exec) {
          const orchestrator = await orchestratorFor(exec.agent)
          const result = orchestrator.startProject(args)
          if (!result.ok) throw new Error(result.problem)
          return {
            ok: true,
            slug: result.slug,
            text: `项目「${result.slug}」已创建，目标与验收标准写在 .scratch/${result.slug}/ 下。`,
          }
        },
      }),
    'dsh-manager: manager_start tool',
  )

  ctx.effect(
    () =>
      ctx.commands.register({
        name: COMMAND_NAME,
        description: '查看项目状态与验收标准；多个项目时用 /manager <项目名> 指定',
        input: { hint: '[项目名]' },
        async handler(invocation) {
          const orchestrator = await orchestratorFor(invocation.agent)
          const result = orchestrator.status(invocation.rawInput.trim())
          if (!result.ok) return { kind: 'error', text: result.problem }
          return { kind: 'success', text: formatStatus(result.project) }
        },
      }),
    'dsh-manager: /manager command',
  )
}

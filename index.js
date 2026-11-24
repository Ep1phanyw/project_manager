/**
 * project_manager — 项目编排插件的宿主半侧入口。
 *
 * 模型开车：这里只提供工具与命令，驾驶由主对话自己做。
 * 状态落在会话工作区的 `.scratch/` 下，是普通 markdown。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve, sep } from 'node:path'

import { formatStatus } from './lib/format.js'
import { EVIDENCE_TYPES, createProjectState } from './lib/project-state.js'
import { createFsStore } from './lib/store.js'

import { formatBlockReport } from './lib/format.js'
import { readEvidenceTypes, readParallelLimit, readSnapshotMode } from './lib/config.js'
import { describeCapabilities } from './lib/capabilities.js'
import { FLOW, flowBrief, flowSkillRegistrations, readSkill } from './lib/skills.js'
import { strayChanges } from './lib/git.js'
import { runCommandCapture } from './lib/exec.js'
import { detectDshVersion, detectExpectedRange, formatDoctorReport } from './lib/doctor.js'
import { surveyWorkspace, workspaceContext } from './lib/workspace.js'

export const name = 'project_manager'

/**
 * 只有三项是硬依赖：少了它们，插件连存在意义都没有，缺了就不该加载。
 * 子对话能力是软依赖 —— 不进 inject，运行时探测：缺了还能规划、看状态。
 */
export const inject = ['commands', 'tools', 'workingDirectory']

const TOOL_START = 'manager_start'
const TOOL_PLAN = 'manager_plan'
const TOOL_RUN = 'manager_run'
const TOOL_VERIFY = 'manager_verify'
const TOOL_BLOCK = 'manager_block'
const TOOL_ACCEPT = 'manager_accept'
const TOOL_FLOW_SKILL = 'manager_flow_skill'
const COMMAND_NAME = 'manager'
const STATUS_KEYWORD = 'status'
const APPROVE_KEYWORD = 'approve'
const REJECT_KEYWORD = 'reject'
const CONFIRM_KEYWORD = 'confirm'
const ACCEPT_KEYWORD = 'accept'
const DOCTOR_KEYWORD = 'doctor'
const ABANDON_KEYWORD = 'abandon'
const CRITERIA_KEYWORD = 'criteria'
const DECLINE_KEYWORD = 'decline'
const RESOLVE_KEYWORD = 'resolve'
const MIGRATE_KEYWORD = 'migrate'

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

export function apply(ctx, config) {
  // 版本跨度放宽之后，先确认这个 DSH 版本给的能力还在：
  // 少一个就如实不动，而不是抛一身栈给用户。
  if (typeof ctx.commands?.register !== 'function' || typeof ctx.tools?.register !== 'function') {
    return
  }

  const snapshotMode = readSnapshotMode(config)
  const evidenceTypes = readEvidenceTypes(config)

  registerFlowSkills(ctx)

  /** 把「这个版本到底给了什么」摊开 —— 坏在哪个接口上一眼看得到。 */
  async function doctorReport(ctxRef, agent) {
    const workspace = await ctxRef.workingDirectory.ensure(agent)
    const git = runCommandCapture('git --version', { cwd: workspace })
    const registrations = flowSkillRegistrations()
    const skills = ctxRef.get?.('skills')

    const detected = detectDshVersion()

    // 四项核心能力先按纯函数算：在不在、缺了会怎样。
    const available = new Set()
    if (typeof ctxRef.commands?.register === 'function') available.add('commands')
    if (typeof ctxRef.tools?.register === 'function') available.add('tools')
    if (typeof ctxRef.workingDirectory?.ensure === 'function') available.add('workingDirectory')
    if (typeof ctxRef.get?.('subagents')?.startActivation === 'function') available.add('subagents')

    return formatDoctorReport({
      version: detected.version,
      versionSource: detected.source,
      expected: detectExpectedRange(),
      workspace,
      projects: createFsStore(join(workspace, '.scratch')).listProjects(),
      capabilities: [
        ...describeCapabilities(available).map((item) => ({
          name: item.name,
          ok: item.present,
          note: item.consequence,
        })),
        {
          name: 'sessionController.prompt',
          ok: typeof ctxRef.get?.('sessionController')?.prompt === 'function',
          note: '自动把流程排进会话要用',
        },
        {
          name: 'skills.register',
          ok: typeof skills?.register === 'function',
          note: '随包分发技能要用',
        },
        {
          name: 'skills.list',
          ok: typeof skills?.list === 'function',
          note: '检测技能被本机盖住要用',
        },
      ],
      config: { snapshot: snapshotMode, evidenceTypes },
      git: { ok: git.ok, note: git.ok ? git.output.split(/\r?\n/)[0] : git.output || '跑不起来' },
      skills: {
        original: FLOW.map((skill) => skill.name).filter((name) =>
          registrations.some((item) => item.name === name),
        ),
        alias: FLOW.map((skill) => skill.alias).filter((name) =>
          registrations.some((item) => item.name === name),
        ),
        shadowed: await shadowedSkills(ctxRef),
      },
    })
  }

  /** 每次调用都按它所在会话的工作区解析状态目录，状态天然跟随会话。 */
  async function stateFor(agent) {
    const workspace = await ctx.workingDirectory.ensure(agent)
    const runInWorkspace = (command) => runCommandCapture(command, { cwd: workspace })

    return createProjectState({
      store: createFsStore(join(workspace, '.scratch')),
      commandName: COMMAND_NAME,
      runChild: childRunner(ctx, agent, workspace),
      hasOrigin: originChecker(workspace),
      contextFiles: () => workspaceContext(workspace),
      snapshot: snapshotMode === 'off' ? null : snapshotter(workspace, snapshotMode),
      evidenceTypes,
      strayCheck: (part) => strayChanges(workspace, part.files),
      // 项目级整体检查与逐条检查跑的是同一条受控通道。
      runVerify: runInWorkspace,
      runCommand: runInWorkspace,
      readFile: (path) => readWorkspaceFile(workspace, path),
      maxParallel: readParallelLimit(config),
      capacity: () => {
        try {
          return ctx.get?.('subagents')?.capacityOf?.(agent) ?? null
        } catch {
          return null
        }
      },
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
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: '这条验收标准说什么' },
              check: {
                type: 'object',
                properties: {
                  kind: {
                    type: 'string',
                    enum: ['command', 'artifact', 'judgement'],
                    description: '命令检查、产物检查，或只能由人判断',
                  },
                  command: { type: 'string', description: 'kind=command：要执行的命令' },
                  expectExit: {
                    type: 'integer',
                    description: 'kind=command：期望的退出码，省略为 0',
                  },
                  output: { type: 'string', description: 'kind=command：可选的输出正则' },
                  path: { type: 'string', description: 'kind=artifact：要检查的文件' },
                  match: { type: 'string', description: 'kind=artifact：可选的内容正则' },
                },
                required: ['kind'],
                additionalProperties: false,
              },
            },
            required: ['text', 'check'],
            additionalProperties: false,
          },
          description:
            '逐条可核对的验收标准：每条都要说明怎么核对 —— 一条命令、一条产物断言，或者标成判断型',
        },
        verify: {
          type: 'string',
          description:
            '可选：一条核对命令（例如 node test/run.js）。配了它，收尾验收会由插件自己跑一遍，不通过就不算数 —— 证据从此不只是文字。',
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
        text: `项目「${result.slug}」已创建，目标与验收标准写在 .scratch/${result.slug}/ 下。${
          args?.verify ? `收尾验收会由插件自己跑「${args.verify}」。` : '没配核对命令：收尾验收只能看文字证据。'
        }`,
      }
    },
  })

  registerTool(ctx, stateFor, {
    name: TOOL_PLAN,
    description:
      '提交项目计划：每个部分声明它依赖哪些部分、会改哪些文件、用什么证据说明自己做完了，以及对应哪几条验收标准。依赖成环、两个部分改同一批文件却没有先后关系、有验收标准没被任何部分覆盖，都会被拒绝。',
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
                enum: evidenceTypes,
                description: '这部分靠什么证据说明完成',
              },
              covers: {
                type: 'array',
                items: { type: 'string' },
                description: '这部分对应哪几条验收标准（编号，如 AC-1）：每条标准都得有部分管',
              },
            },
            required: ['title', 'files', 'evidence', 'covers'],
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
      '派分可以开工的部分：互不依赖、文件集不相交的部分会同时在独立上下文的子对话里跑（上限由配置与平台剩余名额决定），其余则一次一个。子对话失败或回报不合规时记为可重试，不会让项目崩掉。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目名；当前只有一个项目时可以省略' },
      },
      additionalProperties: false,
    },
    async run(args, state, exec) {
      const result = await state.dispatchAll({ project: args?.project, signal: exec.signal })
      if (!result.ok) {
        return {
          ok: false,
          problem: result.retryable ? `${result.problem}（可重试）` : result.problem,
        }
      }

      const lines = result.results.map((one) => {
        if (!one.ok) return `部分 ${one.part?.id ?? '未知'}：${one.problem}`
        const stray =
          one.stray?.length > 0
            ? `\n  注意：改到了声明之外的文件 —— ${one.stray.join('、')}`
            : ''
        return `部分 ${one.part.id}「${one.part.title}」第 ${one.attempt} 次回报：${one.report.status}。${one.report.summary}${stray}`
      })

      const head =
        result.count > 1
          ? `同时派了 ${result.count} 个部分（上限 ${result.limit}）：`
          : `派了 1 个部分：`

      return { ok: true, text: `${head}\n${lines.join('\n')}` }
    },
  })

  registerTool(ctx, stateFor, {
    name: TOOL_VERIFY,
    description:
      '验收一个部分：插件执行这部分覆盖的每条验收标准上的检查，按执行结果给出结论 —— 有检查没过就打回（附带未通过明细与输出），全过但涉及判断型标准就进「待你确认」，否则算通过。结论由插件算，模型不能指定 pass 或 fail。',
    parameters: {
      type: 'object',
      properties: {
        part: { type: 'string', description: '部分编号，形如 P1' },
        reason: { type: 'string', description: '可选：一句话备注，会写进验收记录' },
        project: { type: 'string', description: '项目名；当前只有一个项目时可以省略' },
      },
      required: ['part'],
      additionalProperties: false,
    },
    async run(args, state) {
      const result = state.verifyPart(args)
      if (!result.ok) return result

      if (result.blocked) {
        const report = state.blockReport({ project: args?.project })
        const text = report.ok
          ? formatBlockReport(report.blocked)
          : `部分 ${result.part.id} 已判定阻塞。`
        return { ok: true, text: `连续两次因同一原因失败，判定阻塞。\n\n${text}` }
      }

      const frozen = result.snapshot
      const note =
        frozen === undefined
          ? ''
          : frozen.ok
            ? '已打 git 快照。'
            : `快照没打上（${frozen.problem}），不影响验收。`

      return {
        ok: true,
        text:
          (result.verdict === 'accepted'
            ? `部分 ${result.part.id} 验收通过。`
            : result.verdict === 'needs-user-verification'
              ? `部分 ${result.part.id} 检查全过，等你确认：${(result.judgements ?? []).join('、')}。用 /${COMMAND_NAME} confirm 点头，或 /${COMMAND_NAME} decline [理由] 打回。`
              : `部分 ${result.part.id} 验收不通过（${(result.failures ?? []).join('、')}），已回到可派分。`) + note,
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
        if (!report.ok) {
          // 「没有阻塞」是个正常的查询结果，不该当成错误抛给模型。
          if (report.problem?.includes('没有部分处于阻塞')) {
            return { ok: true, text: '当前没有部分处于阻塞。' }
          }
          return report
        }
        return { ok: true, text: formatBlockReport(report.blocked) }
      }

      const result = state.requestBlock(args)
      if (!result.ok) return result

      return { ok: true, text: `部分 ${result.part.id} 已记为阻塞；把需要用户做的事摊清楚再停。` }
    },
  })

  registerTool(ctx, stateFor, {
    name: TOOL_ACCEPT,
    description:
      '收尾验收：所有部分都验收通过后，真的跑一遍项目的验收标准，然后把结果记下来等用户确认。没有跑过不要调用 —— 这是全项目唯一一次整体验证。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '逐条验收标准的结论，一句话' },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: '真的跑验收标准之后的输出：命令、产物、观察到的结果',
        },
        project: { type: 'string', description: '项目名；当前只有一个项目时可以省略' },
      },
      required: ['summary', 'evidence'],
      additionalProperties: false,
    },
    async run(args, state) {
      const result = state.acceptRun(args)
      if (!result.ok) return result
      return {
        ok: true,
        text: `收尾验收已记录（第 ${result.attempt} 轮）。现在停下来等用户 /${COMMAND_NAME} accept 确认。`,
      }
    },
  })

  registerTool(ctx, stateFor, {
    name: TOOL_FLOW_SKILL,
    description:
      '取建项目流程里某个技能的正文。本机装了就取本机那份，没装就取插件自带的那份。当技能本身不能被模型调用时用它。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: FLOW.map((skill) => skill.name),
          description: '技能名',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async run(args) {
      const name = String(args?.name ?? '')
      const body = readSkill(name)
      if (body === null) {
        return { ok: false, problem: `找不到技能「${name}」的正文（本机和包里都没有）` }
      }
      return { ok: true, text: body }
    },
  })

  ctx.effect(
    () =>
      ctx.commands.register({
        name: COMMAND_NAME,
        description:
          '项目状态、计划与审批：/manager（或 status）看状态，/manager approve 批准计划，/manager reject [理由] 驳回，/manager confirm [说明] 确认等你点头的部分，/manager decline [理由] 打回，/manager resolve [说明] 解除阻塞，/manager accept 确认收尾验收，/manager abandon [理由] 放弃项目，/manager criteria 重开验收标准，/manager migrate 迁移旧格式项目，/manager doctor 自检，/manager <项目名> 指定项目',
        input: { hint: '[status | approve | reject [理由] | confirm [说明] | decline [理由] | resolve [说明] | accept | abandon [理由] | criteria | migrate | doctor | 项目名]' },
        async handler(invocation) {
          const raw = invocation.rawInput.trim()
          const [keyword, ...rest] = raw.split(/\s+/)

          // 自检要在「没有项目」时也能跑，所以放在解析项目之前。
          if (keyword === DOCTOR_KEYWORD) {
            const report = await doctorReport(ctx, invocation.agent)

            // 收尾少一层的时候要说一声：没配整体检查，收尾只能看逐条标准的结果。
            let hint = ''
            try {
              const status = (await stateFor(invocation.agent)).status()
              if (status.ok && !status.project.verify) {
                hint = '\n\n收尾少一层：这个项目没配整体检查，收尾验收只能看逐条标准的结果。'
              }
            } catch {
              hint = ''
            }

            return { kind: 'success', text: report + hint }
          }

          const state = await stateFor(invocation.agent)

          // 多个项目时用 @项目名 指定；不写就按「只有一个项目」处理。
          const targeted = rest[0]?.startsWith('@') ? rest[0].slice(1) : undefined
          const args = (targeted === undefined ? rest : rest.slice(1)).join(' ')

          if (keyword === APPROVE_KEYWORD) {
            const result = state.approvePlan({ by: 'user', project: targeted ?? (args || undefined) })
            if (!result.ok) return { kind: 'error', text: result.problem }
            return { kind: 'success', text: '计划已批准，可以开始派分部分了。' }
          }

          if (keyword === REJECT_KEYWORD) {
            const result = state.rejectPlan({ by: 'user', project: targeted, reason: args })
            if (!result.ok) return { kind: 'error', text: result.problem }
            return { kind: 'success', text: '计划已驳回，回到规划阶段，可以重新提交。' }
          }

          if (keyword === CONFIRM_KEYWORD) {
            const result = state.confirmPart({ by: 'user', project: targeted, reason: args })
            if (!result.ok) return { kind: 'error', text: result.problem }
            return { kind: 'success', text: `部分 ${result.part.id} 已确认，循环可以继续了。` }
          }

          if (keyword === ABANDON_KEYWORD) {
            const result = state.abandonProject({ by: 'user', project: targeted, reason: args })
            if (!result.ok) return { kind: 'error', text: result.problem }
            return {
              kind: 'success',
              text: '项目已标记为放弃。状态文件留着当存档；要接着做请用别的名字重新 manager_start。',
            }
          }

          if (keyword === CRITERIA_KEYWORD) {
            const result = state.reopenCriteria({ by: 'user', project: targeted })
            if (!result.ok) return { kind: 'error', text: result.problem }
            return {
              kind: 'success',
              text: `已按当前的 acceptance.md 重新读入 ${result.count} 条验收标准，退回待批准 —— 用 /${COMMAND_NAME} approve 重新批准。`,
            }
          }

          if (keyword === MIGRATE_KEYWORD) {
            const result = state.migrateProject({ by: 'user', project: targeted })
            if (!result.ok) return { kind: 'error', text: result.problem }
            return {
              kind: 'success',
              text: `已迁移格式（备份在 ${result.backup}）：${result.count} 条旧标准迁成判断型 —— 它们只能由你确认。旧计划没有覆盖关系，请重新提交一份带覆盖的计划再批准。`,
            }
          }

          if (keyword === ACCEPT_KEYWORD) {
            const result = state.acceptProject({ by: 'user', project: targeted, reason: args })
            if (!result.ok) return { kind: 'error', text: result.problem }
            return { kind: 'success', text: '收尾验收已确认 —— 项目完成。' }
          }

          if (keyword === DECLINE_KEYWORD) {
            // 部分与收尾验收不会同时待确认，所以一个词够用。
            const part = state.declinePart({ by: 'user', project: targeted, reason: args })
            if (part.ok) return { kind: 'success', text: `部分 ${part.part.id} 已打回，会重新派分。` }

            const acceptance = state.declineAcceptance({
              by: 'user',
              project: targeted,
              reason: args,
            })
            if (acceptance.ok) {
              return { kind: 'success', text: '收尾验收已打回，改完再跑一遍验收标准。' }
            }

            return { kind: 'error', text: part.problem }
          }

          if (keyword === RESOLVE_KEYWORD) {
            const result = state.resolvePart({ by: 'user', project: targeted, reason: args })
            if (!result.ok) return { kind: 'error', text: result.problem }
            return { kind: 'success', text: `部分 ${result.part.id} 的阻塞已解除，可以重新派分。` }
          }

          // 项目名可能带空格，所以这里用整行而不是第一个词。
          const requested = keyword === STATUS_KEYWORD ? '' : raw
          const result = state.status(requested)

          if (!result.ok) {
            // 没有项目时 /manager 不是「报个错」，而是把项目立起来的入口。
            if (!requested && result.problem.includes('还没有项目')) {
              return bootstrap(ctx, invocation)
            }
            return { kind: 'error', text: result.problem }
          }
          return { kind: 'success', text: formatStatus(result.project) }
        },
      }),
    'project_manager: /manager command',
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
    `project_manager: ${name} tool`,
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

    // 子对话能力是软依赖：运行时探测，缺了就明说，不假装在跑。
    const subagents = ctx.get?.('subagents')
    if (typeof subagents?.startActivation !== 'function') {
      return { ok: false, problem: '本环境没有子对话能力：可以规划与看状态，但派分跑不了' }
    }

    const activation = await subagents.startActivation({
      provider: 'spawn',
      label: `project_manager ${part.id}`,
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

/**
 * 验收通过后给工作区打一个 git 快照，留一个能回去的点。
 *
 * 默认只提交这个部分声明的文件 —— 在别人的仓库里 `add -A` 会把无关的活
 * 一起卷进去。要提交整个工作区得显式配置 `snapshot: all`。
 * 用 stdio:'ignore' 是因为这个沙箱不允许抓子进程的 stdout。
 */
function snapshotter(workspace, mode) {
  return ({ part } = {}) => {
    if (!existsSync(join(workspace, '.git'))) {
      return { ok: false, problem: '工作区不是 git 仓库，没有打快照' }
    }

    const files = part?.files ?? []
    if (mode !== 'all' && files.length === 0) {
      return { ok: false, problem: '这个部分没有声明文件，没东西可提交' }
    }

    const message = `project_manager: ${part?.id ?? '?'} 完成 — ${part?.title ?? ''}`.trim()
    const addArgs =
      mode === 'all'
        ? ['-C', workspace, 'add', '-A']
        : ['-C', workspace, 'add', '--', ...files]

    try {
      execFileSync('git', addArgs, { stdio: 'ignore' })
      execFileSync('git', ['-C', workspace, 'commit', '--quiet', '-m', message], {
        stdio: 'ignore',
      })
      return { ok: true, message, mode }
    } catch {
      return { ok: false, problem: 'git 提交没成功（可能没有改动、路径不存在，或钩子报错）' }
    }
  }
}

/** 一个部分的来源，必须真的能在 .scratch/<项目>/issues/ 里找到。 */
function originChecker(workspace) {
  return (originId, slug) => {
    const dir = join(workspace, '.scratch', slug, 'issues')

    try {
      if (!existsSync(dir)) return false
      return readdirSync(dir).some(
        (name) => name === `${originId}.md` || name.startsWith(`${originId}-`),
      )
    } catch {
      // 读不动就当找不到：报「来源找不到」比抛一个 fs 错误更可读。
      return false
    }
  }
}

/**
 * 验收里的产物检查要读文件：只允许读工作区里的东西，读不到就是「不在」。
 * 路径越界按读不到处理，不抛错、也不悄悄读到工作区外面去。
 */
function readWorkspaceFile(workspace, path) {
  const root = resolve(workspace)
  const absolute = resolve(root, path)

  if (absolute !== root && !absolute.startsWith(root + sep)) return null

  try {
    return readFileSync(absolute, 'utf8')
  } catch {
    return null
  }
}

/**
 * 把随包分发的三个工程技能注册进技能目录。
 *
 * 用原名注册：同名时谁赢由 skills 服务的分层顺序决定（project > runtime > user），
 * 若用户自己装了同名技能且排在前面，效果是模型照样能按原名调用。
 */
function registerFlowSkills(ctx) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (!skills || typeof skills.register !== 'function') return

  for (const skill of flowSkillRegistrations()) {
    // 一个技能注册不上，不该把整个插件拖下水 —— DSH 是「一个插件加载失败，
    // 整条启动链就退出」的。技能名不合规那次已经真实发生过。
    try {
      ctx.effect(() => skills.register(skill), `project_manager: ${skill.name} skill`)
    } catch {
      continue
    }
  }
}

/** 还没项目时：把「grill → to-spec → to-tickets」这条流程交出去。 */
async function bootstrap(ctx, invocation) {
  const workspace = await ctx.workingDirectory.ensure(invocation.agent)
  const survey = surveyWorkspace(workspace)

  const brief = flowBrief()
  const nudged = await nudgeSession(ctx, invocation.agent, brief, invocation.signal)
  const shadowed = await shadowedSkills(ctx)

  const header = nudged.ok
    ? '还没有项目。这条流程已经排进本会话，主对话接下来会按顺序开始访谈。'
    : `还没有项目。流程在下面；自动排进会话失败了（${nudged.reason}）—— 你回一句「开始」，我就照它做。`

  // 半成品工作区：先理解现状，再谈还缺什么。
  const brownfield = survey.hasWork
    ? [
        '',
        `这个工作区**不是空的**（顶层有：${survey.top.join('、')}）。`,
        '所以在动手之前先做一件事：**读懂它现在是什么**。',
        '  - 读 README、GLOSSARY、docs/adr、入口文件与构建配置；',
        '  - 产出一段「现状摘要」：已经做了什么、用了哪些约定、哪些地方不能动；',
        '  - 这份摘要要成为后面访谈的基础 —— 问「还差什么」，而不是「你想做什么」。',
      ].join('\n')
    : ''

  const warning =
    shadowed.length === 0
      ? ''
      : `\n\n注意：本机 ~/.agents/skills/ 里已装同名技能（${shadowed.join('、')}），它们是「只给用户」的，模型调不到。` +
        `这几步请用工具 ${TOOL_FLOW_SKILL} 取正文（它本地优先、包里兜底），不要指望能直接调用同名技能。`

  return { kind: 'success', text: `${header}${brownfield}${warning}\n\n${brief}` }
}

/** 有哪些技能被本机同名的「只给用户」条目盖住了。 */
async function shadowedSkills(ctx) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (!skills || typeof skills.list !== 'function') return []

  try {
    const list = await skills.list({})
    const byName = new Map(list.map((entry) => [entry.name, entry]))

    return FLOW.map((skill) => skill.name).filter((name) => {
      const entry = byName.get(name)
      return entry !== undefined && entry.invocation?.modelInvocable === false
    })
  } catch {
    return []
  }
}

/** 给当前会话排一条消息，让它真的动起来。失败时把原因带回去，不静默。 */
async function nudgeSession(ctx, agent, text, signal) {
  try {
    const controller = ctx.get('sessionController')
    if (!controller) return { ok: false, reason: '拿不到 sessionController 服务' }
    if (typeof controller.prompt !== 'function') {
      return { ok: false, reason: 'sessionController 上没有 prompt 方法' }
    }

    // prompt(request, signal) —— 漏传 signal 会在内部 throwIfAborted 上炸。
    const usable = signal ?? new AbortController().signal

    await controller.prompt(
      {
        requestId: `project_manager-flow-${Date.now()}`,
        sessionId: agent.id,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
      usable,
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** 回报只认 outputSchema 校验过的结构化对象；拿不到就是没按约定回报。 */
function readReport(result) {
  return result?.structured && typeof result.structured === 'object' ? result.structured : null
}

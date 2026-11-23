/**
 * 把本地已装的三个工程技能，注册成「模型可调用」的别名。
 *
 * 为什么不直接注册原名：`skills.register` 遇到同名是 first-wins，
 * 你的文件系统注册会赢，改不了它的 invocation 策略。换个带前缀的名字，
 * 既不撞车，也不用把别人的正文打包进插件 —— 内容在加载时从磁盘读。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const FLOW = [
  {
    source: 'grill-with-docs',
    alias: 'dsh-manager-grill',
    step: 1,
    description:
      'dsh-manager 流程第一步：把想法问清楚。一轮一轮追问，边问边把术语与决定落进 GLOSSARY.md 与 ADR。',
  },
  {
    source: 'to-spec',
    alias: 'dsh-manager-spec',
    step: 2,
    description:
      'dsh-manager 流程第二步：把访谈收敛成 spec，写到 .scratch/<项目名>/spec.md。',
  },
  {
    source: 'to-tickets',
    alias: 'dsh-manager-tickets',
    step: 3,
    description:
      'dsh-manager 流程第三步：把 spec 拆成带先后关系的部分，写到 .scratch/<项目名>/parts/NN-*.md。',
  },
]

export function skillsRoot() {
  return join(homedir(), '.agents', 'skills')
}

/** 读一个技能的正文；去掉 frontmatter。找不到返回 null。 */
export function readSkill(source, root = skillsRoot()) {
  const file = join(root, source, 'SKILL.md')
  if (!existsSync(file)) return null

  const raw = readFileSync(file, 'utf8')
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw)
  return (match ? raw.slice(match[0].length) : raw).trim()
}

/** 本机缺了哪几个源技能。 */
export function missingSkills(root = skillsRoot()) {
  return FLOW.filter((skill) => readSkill(skill.source, root) === null).map(
    (skill) => skill.source,
  )
}

/** 能注册的别名：只给机器上真有的那些，正文带上「这是第几步」的前言。 */
export function aliasRegistrations(root = skillsRoot()) {
  const registrations = []

  for (const skill of FLOW) {
    const body = readSkill(skill.source, root)
    if (body === null) continue

    registrations.push({
      name: skill.alias,
      description: skill.description,
      content: [
        `这是 dsh-manager 建项目流程的第 ${skill.step} 步（原技能：${skill.source}）。`,
        `做完这一步就停下来等用户回话，不要连续跑后面的步骤。`,
        '',
        body,
      ].join('\n'),
      invocation: { modelInvocable: true, userInvocable: false },
    })
  }

  return registrations
}

/** `/manager` 输出的短指令：只有步骤名，正文走技能通道。 */
export function flowBrief(root = skillsRoot()) {
  const missing = missingSkills(root)
  const lines = [
    '这个工作区还没有项目。按下面的顺序把项目立起来，每步做完都停下来等用户回话，不要一口气跑完。',
    '',
    ...FLOW.map((skill) => `${skill.step}. 先调用技能 ${skill.alias} —— ${skill.description}`),
    '',
    '拆完之后，用 manager_plan 提交计划：每个部分填上文件集与证据类型，',
    '并把 - 来源：<文件名> 写上（插件会核对那个文件真的存在）。计划提交后停下，等用户 /manager approve。',
  ]

  if (missing.length > 0) {
    lines.push(
      '',
      `注意：本机缺少 ${missing.join('、')}，对应的步骤没有别名可用。`,
      '缺的那几步要么跳过并如实告诉用户，要么让用户先按 ~/.agents/skills/<名字>/SKILL.md 装好再重来。',
      '如果三个都缺，就不要再走这条流程 —— 直接问用户目标与验收标准，用 manager_start 起项目。',
    )
  }

  return lines.join('\n')
}

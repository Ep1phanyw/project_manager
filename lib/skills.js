/**
 * 随插件一起分发的三个工程技能。
 *
 * 正文来自 Matt Pocock 的 skills 仓库（MIT），逐字未改，版权声明见
 * THIRD-PARTY-NOTICES.md。放在包里而不是运行时去读用户目录，是为了
 * 「装上就有」，不赌用户装了别的技能。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FLOW = [
  {
    name: 'grill-with-docs',
    step: 1,
    description:
      'dsh-manager 流程第一步：把想法问清楚。一轮一轮追问，边问边把术语与决定落进 GLOSSARY.md 与 ADR。',
  },
  {
    name: 'to-spec',
    step: 2,
    description: 'dsh-manager 流程第二步：把访谈收敛成 spec，写到 .scratch/<项目名>/spec.md。',
  },
  {
    name: 'to-tickets',
    step: 3,
    description:
      'dsh-manager 流程第三步：把 spec 拆成带先后关系的部分，写成 .scratch/<项目名>/issues/NN-*.md（沿用原技能的目录约定）。',
  },
]

/** 包里自带的正文目录。 */
export function bundledRoot() {
  return fileURLToPath(new URL('../skills/', import.meta.url))
}

/** 用户自己装技能的目录，作为兜底。 */
export function userRoot() {
  return join(homedir(), '.agents', 'skills')
}

function readFrom(root, name) {
  if (root === null || root === undefined) return null

  const file = join(root, `${name}.md`)
  const fallback = join(root, name, 'SKILL.md')
  const path = existsSync(file) ? file : existsSync(fallback) ? fallback : null
  if (path === null) return null

  const raw = readFileSync(path, 'utf8')
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw)
  return (frontmatter ? raw.slice(frontmatter[0].length) : raw).trim()
}

/**
 * 读技能正文：**本地优先，包里兜底**。
 *
 * 本机装了就跟着用户的版本走（他改过也生效）；没装才用插件自带的那份。
 */
export function readSkill(name, root = bundledRoot(), fallbackRoot = userRoot()) {
  return readFrom(fallbackRoot, name) ?? readFrom(root, name)
}

/** 注册用的条目：原名、模型可调用、用户也能敲。 */
export function flowSkillRegistrations(root = bundledRoot(), fallbackRoot = userRoot()) {
  const registrations = []

  for (const skill of FLOW) {
    const body = readSkill(skill.name, root, fallbackRoot)
    if (body === null) continue

    registrations.push({
      name: skill.name,
      description: skill.description,
      content: [
        `这是 dsh-manager 建项目流程的第 ${skill.step} 步。`,
        '做完这一步就停下来等用户回话，不要连续跑后面的步骤。',
        '',
        body,
      ].join('\n'),
      invocation: { modelInvocable: true, userInvocable: true },
    })
  }

  return registrations
}

/** 本机（或包里）缺了哪几个技能。 */
export function missingSkills(root = bundledRoot(), fallbackRoot = userRoot()) {
  return FLOW.filter((skill) => readSkill(skill.name, root, fallbackRoot) === null).map(
    (skill) => skill.name,
  )
}

/** `/manager` 输出的短指令：只有步骤名，正文走技能通道。 */
export function flowBrief(root = bundledRoot(), fallbackRoot = userRoot()) {
  const lines = [
    '这个工作区还没有项目。按下面的顺序把项目立起来，每步做完都停下来等用户回话，不要一口气跑完。',
    '',
    ...FLOW.map((skill) => `${skill.step}. 先调用技能 ${skill.name} —— ${skill.description}`),
    '',
    '拆完之后，用 manager_plan 提交计划：每个部分填上文件集与证据类型，',
    '并把 - 来源：<文件名> 写上（插件会核对那个文件真的存在）。计划提交后停下，等用户 /manager approve。',
  ]

  const missing = missingSkills(root, fallbackRoot)
  if (missing.length > 0) {
    lines.push(
      '',
      `注意：缺少 ${missing.join('、')} 的正文（包内和 ~/.agents/skills/ 都没找到）。`,
      '缺的那几步跳过并如实告诉用户；如果三个都缺，直接问目标和验收标准，用 manager_start 起项目。',
    )
  }

  return lines.join('\n')
}

/**
 * 读本地已装的 Matt Pocock 技能，把正文交给主对话。
 *
 * 不重新注册：那些技能已经由 dsh-skill-filesystem 注册在全局层，
 * 再注册一次会撞名。这里只取正文，塞进要排进会话的那条消息里。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const FLOW_SKILLS = [
  {
    name: 'grill-with-docs',
    why: '把想法问清楚：一轮一轮追问，边问边把术语与决定落进 GLOSSARY.md 与 ADR',
  },
  {
    name: 'to-spec',
    why: '把访谈收敛成一份 spec，写到 .scratch/<项目名>/spec.md',
  },
  {
    name: 'to-tickets',
    why: '把 spec 拆成带阻塞边的票，写到 .scratch/<项目名>/issues/NN-*.md',
  },
]

export function skillsRoot() {
  return join(homedir(), '.agents', 'skills')
}

/** 读一个技能的正文；去掉 frontmatter。找不到返回 null。 */
export function readSkill(name, root = skillsRoot()) {
  const file = join(root, name, 'SKILL.md')
  if (!existsSync(file)) return null

  const raw = readFileSync(file, 'utf8')
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw)
  return (match ? raw.slice(match[0].length) : raw).trim()
}

/** 把整条流程拼成一段给主对话的指令；缺哪个技能会如实说。 */
export function flowBrief(root = skillsRoot()) {
  const sections = []

  for (const skill of FLOW_SKILLS) {
    const body = readSkill(skill.name, root)
    sections.push(
      body
        ? `### ${skill.name}\n${skill.why}\n\n${body}`
        : `### ${skill.name}（没找到）\n${skill.why}\n\n本机 ${join(root, skill.name)} 下没有 SKILL.md，这一步跳过。`,
    )
  }

  return [
    '这个工作区还没有项目。按下面的顺序把项目立起来，每一步做完都停下来等用户回话，不要一口气跑完。',
    '',
    '1. 先按 grill-with-docs 做完访谈 —— 需求没问清之前不要写 spec。',
    '2. 访谈收敛后再按 to-spec 产出 spec。',
    '3. spec 定稿后再按 to-tickets 拆票。',
    '4. 票齐了，用 manager_plan 提交计划：每张票对应一个部分，填上文件集与证据类型，并把 - 票：<编号> 写上，插件会核对票文件真的存在。',
    '5. 计划提交后停下来，等用户 /manager approve。',
    '',
    sections.join('\n\n---\n\n'),
  ].join('\n')
}

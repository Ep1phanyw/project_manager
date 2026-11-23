/**
 * 自检：把「这个版本到底给了什么」摊开给人看。
 *
 * 跨版本最难受的坏法不是功能坏掉，而是**插件激活失败、整条启动链退出** ——
 * 那时用户只看到 DSH 起不来，不知道是哪个插件缺了哪个接口。
 * doctor 就是让这件事变成可诊断的。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 从 DSH 的安装目录读真实版本，读不到就返回空串。 */
export function detectDshVersion(env = process.env, read = readFileSync) {
  const dir = env?.DSH_INSTALL_DIR
  if (!dir) return ''

  try {
    const manifest = JSON.parse(read(join(dir, 'package.json'), 'utf8'))
    return typeof manifest?.version === 'string' ? manifest.version : ''
  } catch {
    return ''
  }
}

/** 期望范围，从本插件自己的 package.json 里读。 */
export function detectExpectedRange(read = readFileSync) {
  try {
    const manifest = JSON.parse(read(new URL('../package.json', import.meta.url), 'utf8'))
    return manifest?.engines?.dsh ?? ''
  } catch {
    return ''
  }
}

/** 版本是否落在声明范围里 —— 只做最常见的那种比较，判不了就返回 null。 */
export function versionInRange(version, range) {
  if (!version || !range) return null

  const lower = /(?:>=|\^|~)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(range)
  const upper = /<\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(range)

  const compare = (a, b) => {
    const pa = a.split('-')
    const pb = b.split('-')
    const na = pa[0].split('.').map(Number)
    const nb = pb[0].split('.').map(Number)

    for (let i = 0; i < 3; i += 1) {
      if (na[i] !== nb[i]) return na[i] < nb[i] ? -1 : 1
    }
    // 同版本号时，预发布版小于正式版
    if (pa.length === pb.length) return 0
    return pa.length > 1 ? -1 : 1
  }

  if (lower && compare(version, lower[1]) < 0) return false
  if (upper && compare(version, upper[1]) >= 0) return false
  return true
}

function line(ok) {
  return ok ? '在' : '缺'
}

/** 把收集到的事实排成给人看的报告。纯函数，好测。 */
export function formatDoctorReport(facts) {
  const { version, expected, capabilities, config, git, workspace, projects, skills } = facts
  const missing = capabilities.filter((item) => !item.ok)
  const lines = ['manager 自检', '']

  const inRange = versionInRange(version, expected)
  lines.push(
    `DSH 版本：${version || '读不到（DSH_INSTALL_DIR 没设？）'}`,
    `期望范围：${expected || '（没写）'}`,
    version && expected
      ? `范围判断：${inRange === null ? '判不了' : inRange ? '在范围内' : '不在范围内'}` +
        (inRange === false ? ' —— 可能缺接口，往下看' : '')
      : '范围判断：信息不全',
    '',
    `工作区：${workspace}`,
    `状态目录：${workspace}\\.scratch`,
    `已有项目：${projects.length > 0 ? projects.join('、') : '（没有）'}`,
    '',
    '能力：',
  )

  for (const item of capabilities) {
    lines.push(`  ${line(item.ok)}  ${item.name}${item.ok || !item.note ? '' : `　—— ${item.note}`}`)
  }

  lines.push('', '配置：', `  snapshot=${config.snapshot}　evidenceTypes=${config.evidenceTypes.join('/')}`)

  lines.push(
    '',
    `git：${git.ok ? `可用（${git.note}）` : `不可用（${git.note}）`}`,
    git.ok ? '  → 快照与越界改动检查可用' : '  → 快照与越界改动检查会跳过，不影响其他功能',
  )

  lines.push(
    '',
    `技能：已注册 ${skills.registered.length} 个${skills.registered.length > 0 ? `（${skills.registered.join('、')}）` : ''}`,
  )
  if (skills.shadowed.length > 0) {
    lines.push(`  被本机同名技能盖住：${skills.shadowed.join('、')}（插件版模型调不到，走 manager_flow_skill）`)
  }

  lines.push(
    '',
    missing.length === 0
      ? '结论：能力齐全，可以正常用。'
      : `结论：缺 ${missing.length} 项能力（${missing.map((item) => item.name).join('、')}）。缺的这些功能不可用，其余照常。`,
  )

  return lines.join('\n')
}

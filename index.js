/**
 * dsh-manager — 项目编排插件的宿主半侧入口。
 *
 * 这一票只交付「装得上、敲得响」：把 `/manager` 命令注册进当前会话。
 * 项目状态、计划、分派、验收由后续部分接上。
 */

export const name = 'dsh-manager'

/** 依赖 commands 服务：没有它就不要激活，而不是一半装好。 */
export const inject = ['commands']

const COMMAND_NAME = 'manager'

const READY_TEXT = 'dsh-manager 已就位；当前没有活动项目。'

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.commands.register({
        name: COMMAND_NAME,
        description: '项目编排：把当前会话指定为主对话，规划项目并把部分分派给子对话',
        handler: () => ({ kind: 'success', text: READY_TEXT }),
      }),
    'dsh-manager: /manager command',
  )
}

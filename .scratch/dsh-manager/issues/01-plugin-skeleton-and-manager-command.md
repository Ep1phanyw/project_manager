# 01: 可安装的插件骨架与 /manager 命令

**What to build:** 装上 dsh-manager 之后，在任意会话里敲 `/manager` 会得到回应，证明这不是一个空壳。如果当前 DSH 版本不在支持范围内，安装阶段就直接失败并说明原因，而不是装上一个跑不起来的插件。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 插件能通过插件安装流程装进当前 profile，安装结果显示为生效
- [ ] 安装后在会话里敲 `/manager` 能得到一条回应
- [ ] 把引擎版本约束改成不匹配的版本后安装失败，且失败原因说明是版本不兼容
- [ ] 禁用插件后 `/manager` 不再响应

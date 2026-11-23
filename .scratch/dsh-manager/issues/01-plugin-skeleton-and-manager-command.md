# 01: 可安装的插件骨架与 /manager 命令

**What to build:** 装上 dsh-manager 之后，在任意会话里敲 `/manager` 会得到回应，证明这不是一个空壳。如果当前 DSH 版本不在支持范围内，安装阶段就直接失败并说明原因，而不是装上一个跑不起来的插件。

**Blocked by:** None (can start immediately)

**Status:** in-review

- [x] 插件能通过插件安装流程装进当前 profile，安装结果显示为生效
- [ ] 安装后在会话里敲 `/manager` 能得到一条回应
- [ ] 把引擎版本约束改成不匹配的版本后安装失败，且失败原因说明是版本不兼容
- [ ] 禁用插件后 `/manager` 不再响应

## 验证记录

- **装入**：`install_bundle` 返回 `application: applied`；profile 的 `dsh.profile.bundles` 含 `dsh-manager`，行 `include:dsh-manager` 为 `enabled: true`，来源 `link:D:\plugin`。
- **版本**：`engines.dsh` 按 spec「写死」为精确值 `0.2.3-alpha.2`（早先写的 `^0.2.3-alpha.2` 是范围，会放行 `0.2.4`、`0.2.9`，已改）。用该精确值重组配置返回 `applied`，说明与运行版本匹配；不匹配时由 DSH 引擎闸门拒绝（`incompatible-version`）。**尚未做实机失败注入。**
- **卸载**：单测覆盖「注销后命令从注册表移除」。实机禁用未跑。
- **`/manager` 实际回应**：需用户在会话里敲一次确认。

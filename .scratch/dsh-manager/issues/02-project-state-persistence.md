# 02: 项目落地与状态回读

**What to build:** 在主对话里启动一个项目，给出目标与验收标准后，这些内容以 markdown 落在 `.scratch/` 下，人能直接读懂。用 `/manager status` 能把它们读回来。关掉会话重新打开，状态还在，不需要重新输入。

**Blocked by:** 01

**Status:** done

- [x] 启动项目后生成项目状态与验收标准两份 markdown，内容人可读
- [x] `/manager status` 输出当前项目的目标与验收标准
- [x] 关闭会话再新开会话，状态仍可读回
- [x] 状态文件被手工改坏时，`status` 报出可理解的问题而不是崩溃
- [x] 核心逻辑有测试覆盖：从单一接口驱动、外部能力全部用注入的假件

## 验证记录

- **命令入口**：`/manager` 与 `/manager status` 都能用。早先把 `status` 当成项目名去查，是评审抓出来的真 bug，已修并留下回归测试。
- **写入格式**：验收标准用 `- [AC-N] 文本` 标记行，解析按标记锚定，所以条目文本自带编号也不会读错。
- **状态机**：`createProjectState({ store })`，store 注入。18 条测试里绝大多数用内存版 store，两条用真实文件存储（一条跨实例读回，一条验证落盘）。
- **往返一致**：多行目标、自带编号的条目都能原样读回；目标含 markdown 标题行、验收标准含换行、项目名含换行/路径分隔符/保留名，一律**拒绝并说明原因**，不再静默截断。
- **防穿越**：读取路径与写入路径共用同一套项目名校验，`status('../outside')` 读不到 `.scratch` 之外。
- **文件安全**：写入时先落 `acceptance.md` 再落 `project.md`（后者是「项目存在」的标记），所以半途失败不会留下一个能被列出却读不完的项目；读写异常一律转成可读问题。
- **实机**：重载插件后调用 `manager_start` 两次（重写前后各一次），都在 `.scratch/` 下生成了预期的两份 markdown，验证产物已清理。
- **术语**：核心模块改名 `lib/project-state.js` / `createProjectState`，因为 glossary 的 **Main conversation** 条目把 `orchestrator` 列为 _Avoid_。

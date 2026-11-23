# dsh-manager

把一次交付拆成若干**部分**，交给上下文独立的**子对话**；**主对话**负责规划、派分、验收。插件只出工具，开车的是主对话。

状态全部落在会话工作区的 `.scratch/<项目名>/` 下，是普通 markdown：跑完能读，卡住能查。

## 它是什么

- **主对话**是当前会话里负责指挥的那一个：启动项目、提交计划、派分部分、验收结果。
- **部分**是一次派分的工作单元：每次交给一个上下文独立的子对话，失败可重试。子对话只拿到这一部分的任务、文件范围和要求的证据类型（外加项目目标与验收标准），不继承主对话的上下文。
- **验收标准**在项目启动时定下，逐条可核对；每个部分的完成都要拿可复现的证据来换。
- **用户**保留三类裁决权：批准/驳回计划、确认/打回「待确认」的部分、解除阻塞。模型侧没有对应的工具。

术语的完整定义见 [GLOSSARY.md](GLOSSARY.md)，「验收归用户」的取舍见 [ADR-0001](docs/adr/0001-acceptance-belongs-to-the-user.md)。

## 安装

要求：

- DSH **0.2.3-alpha.2**（见 `package.json` 的 `engines.dsh`）
- Node.js **>= 22**
- 本包没有运行时依赖，也没有构建脚本，不需要先跑构建

安装方式（二选一）：

1. **Plugins 页**：打开 DSH 的 **Plugins → Add plugin**，选择本仓库根目录（即 `package.json` 所在目录）。
2. **让主对话装**：主对话调用 `plugin_manager` 的 `install_bundle`，`target` 传本目录的绝对路径。

装好后：

- 在 Plugins 页确认 `dsh-manager` 一行已启用；
- 新开一个会话，输入 `/manager`。还没有项目时应该回「还没有项目；先在主对话里启动一个项目」。

本包通过 `cordis.patch.yml` 挂进配置树；插件需要 `commands`、`tools`、`workingDirectory`、`subagents` 四项能力，缺一项就不会半装好地跑起来。

## 斜杠命令

`/manager` 在**没有项目**时是建项目的入口：它会输出一条三行的流程，并把三个上游技能注册成可被模型调用的别名（`dsh-manager-grill` / `dsh-manager-spec` / `dsh-manager-tickets`），正文走技能通道加载，对话里只留一个短标记。有项目时它照旧显示状态。

### 前置依赖

那三个别名是从本机 `~/.agents/skills/` 下读的：

| 别名 | 需要的源技能 |
| --- | --- |
| `dsh-manager-grill` | `grill-with-docs` |
| `dsh-manager-spec` | `to-spec` |
| `dsh-manager-tickets` | `to-tickets` |

**缺了会怎样**：缺哪个就少哪个别名，`/manager` 会在流程后面点名缺什么；**三个都缺**时它会明说，并给出退路 —— 直接讲目标和验收标准，用 `manager_start` 起项目。核心回路（start → plan → run → verify）不依赖这些技能。

### 来源与署名

上面三个别名的正文来自 **Matt Pocock 的 [skills](https://github.com/mattpocock/skills)**：

| 别名 | 原技能 |
| --- | --- |
| `dsh-manager-grill` | `grill-with-docs` |
| `dsh-manager-spec` | `to-spec` |
| `dsh-manager-tickets` | `to-tickets` |

那个仓库是 **MIT 许可**（`Copyright (c) 2026 Matt Pocock`），作者在 README 里明确邀请改编：*"These skills are designed to be small, easy to adapt, and composable… Hack around with them. Make them your own."*

**本插件不打包他的任何正文**：包内容只有 `index.js`、`lib/`、`cordis.patch.yml`。正文在加载时从本机 `~/.agents/skills/` 读取，再注册成别名 —— 所以 MIT 里「复制或分发实质部分需附版权声明」这一条在这里不触发。

如果你将来把正文**内联进插件**，请连同上面那句版权声明一起带上。

三个最常用的：

| 命令 | 作用 |
| --- | --- |
| `/manager` | 看当前项目状态：阶段、目标、逐条验收标准、审批记录、每个部分的状态与重试次数。`/manager status` 等价。 |
| `/manager approve` | 批准已提交的计划。批准后阶段从「待批准」变成「执行」，才允许派分部分。 |
| `/manager confirm [说明]` | 对「待确认」的部分点头。有些证据只能由你亲眼看（比如界面效果）；说明可省略，省略时会记一句默认说明。 |

全部命令：

| 命令 | 作用 |
| --- | --- |
| `/manager` 或 `/manager status` | 有项目时看状态；**还没有项目时**给出「grill-with-docs → to-spec → to-tickets → 提交计划」这条建项目流程，并尝试把它排进本会话。 |
| `/manager <项目名>` | 同时有多个项目时，指定要看哪一个。项目名里的空白会变成目录名里的 `-`。 |
| `/manager approve` | 批准计划，只认用户。计划没到「待批准」、或已经不合法时会被拒。 |
| `/manager reject [理由]` | 驳回计划，回到规划阶段。理由必填。 |
| `/manager confirm [说明]` | 确认当前唯一一个待确认的部分。没有待确认的部分、或有多个待确认时会报错。 |
| `/manager decline [理由]` | 把待确认的部分打回重做。理由必填。 |
| `/manager resolve [说明]` | 你处理完阻塞后，让这个部分重新可派分。说明必填。 |

状态里出现「待你确认」时，会连同子对话的摘要与证据一起列出来，供你判断。

## 一次典型的项目

这些是主对话调用的工具，不是斜杠命令；你只需要在关键节点用上面的命令点头或打回。

| 工具 | 做什么 |
| --- | --- |
| `manager_start` | 启动项目：写下目标与逐条验收标准，落在 `.scratch/<项目名>/`。 |
| `manager_plan` | 提交计划：每个部分声明依赖、会改的文件、要求的证据类型。依赖成环、两个部分改同一批文件却没有先后关系、证据类型不在 `test / build / command / artifact` 里，都会被拒。 |
| `manager_run` | 派下一个可派分的部分，起一个独立上下文的子对话；结构化回报记进项目。子对话失败或回报不合规记为可重试，项目不崩。 |
| `manager_verify` | 验收一个部分：子对话说「完成」只是候选；主对话拿证据对照验收标准，判 `pass` 才算完成，判 `fail` 则打回重派。 |
| `manager_block` | 请求阻塞，或查看当前阻塞报告。不给 `condition` 时返回报告。 |

完整循环：

1. 你告诉主对话要做什么、怎样算做完；主对话调用 `manager_start` 定下目标与验收标准。
2. 主对话用 `manager_plan` 提交计划，阶段变成「待批准」。
3. 你用 `/manager` 看一眼，`/manager approve` 批准。
4. 主对话用 `manager_run` 派分；子对话只拿到这一部分，完成后交回 `status / summary / evidence`。
5. 主对话用 `manager_verify` 验收；通过后才轮到依赖它的部分。
6. 若某个部分的证据只能由你判断，状态显示「待你确认」，你 `/manager confirm` 或 `/manager decline [理由]`。
7. 所有部分都验收通过后，状态显示「完成」，不会再派分。

## 状态文件

每个项目一个目录，都在**当前会话工作区**的 `.scratch/` 下：

```
.scratch/<项目名>/
├── project.md      # 目标、阶段、审批记录、验收标准指纹
├── acceptance.md   # 逐条验收标准（AC-1、AC-2 …）
├── plan.md         # 部分清单：依赖、文件集、证据类型
└── parts.md        # 每次派分/验收/确认的历史
```

这些文件是插件的状态来源，可以直接读。手改要小心：

- 批准时会记下验收标准的指纹；批准之后再改 `acceptance.md`，插件会发现，并拒绝继续派分或验收，直到重新批准。
- 手改 `project.md` 里的「阶段：」一行骗不过派分闸门 —— 派分看的是审批历史里最后一条确实是「批准」。
- 子对话写的摘要与证据会缩进落盘，伪造不出新的结构行，也写不坏别的部分的记录。

## 边界

- 只有用户能批准或驳回计划、确认或打回待确认的部分、解除阻塞。模型侧没有这些入口。
- 阻塞只认三种情形：缺少只有用户能提供的东西、需要改动验收标准本身、同一部分连续两次同样的验收失败（最后一种由插件自己数，模型声称不算）。其他情况不许宣布阻塞，也不许自行降低验收标准。
- 派分是串行的：有部分在等确认、报了阻塞、或有候选完成还没验收时，都会先停下。
- 报「完成」时至少要有一条证据以这部分要求的类型开头（例如 `test：node --test`）；「我确认过了」不算证据。

## 开发

```sh
node --version   # >= 22
npm test         # 依次跑 test/ 下的 node:test 用例
```

代码结构：`index.js` 是宿主半侧入口（登记命令与工具）；`lib/project-state.js` 是状态机与校验器；`lib/store.js` 负责 markdown 落盘；`lib/format.js` 负责给人看的排版。测试用假 store 与假子对话执行器，不碰真实会话。

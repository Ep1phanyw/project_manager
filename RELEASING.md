# 发布前检查

## 0. 名字（当前阻塞）

`project_manager` 这个名字 **npm 上已经被占**（`tudamu`，2026-10-07 发布，0.0.1）。
在改名之前不能 `npm publish`，否则会得到 403。

两个选项：

| 选项 | 说明 |
| --- | --- |
| **改包名** | 例如 `dsh-project-manager`。要同步改 `package.json` 的 `name`、`cordis.patch.yml` 的 `id`，并重新安装一次插件（profile 里记的是 `include:<包名>`） |
| **加 scope** | 例如 `@ep1phanyw/project_manager`。自己的 scope 一定可用，不用猜名字有没有被占 |

改完之后 `bundle` 的 id 与包名要保持一致 —— 这条是 `cordis.patch.yml` 开头的约定。

## 0.5 怎么被人搜到

包名里没有 `dsh`，所以要靠标记补。两处：

| 位置 | 写什么 | 为什么 |
| --- | --- | --- |
| **GitHub 仓库 Topics** | **`dsh-plugin`（必须）**、`deepseek-harness`、`dsh`、`cordis` | `dsh-plugin` 是识别 DSH 插件的 topic；没打就等于不存在 |
| `package.json` → `keywords` | `dsh`、`deepseek-harness`、`dsh-plugin`、`cordis` 等（已有 8 个） | npm 站内搜索 |

## 0.6 进 dshmarket（DSH 内置插件市场）

**查清了：不是投稿给市场，是给精选列表提 PR。**

市场（dshmarket）的插件目录**就是**另一份精选列表，其 README 第 167 行原话：

> **这个仓库是市场应用本身，不是插件目录。** 市场里的插件列表来自精选列表
> [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
> ——想让你的插件上架，请去**那边**提 PR（在列表里加一条即可，站点和本市场会自动收录，
> 通常一天内生效）。请不要往本仓库提插件条目。

而且市场**只允许安装列表内的来源**（安装弹窗明确拒绝其它来源），所以：

> **不进这份列表 = 市场里搜不到、也装不了。**

### 怎么提

在 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin> 的合适分类下加一条：

```
* <GitHub 用户名>/<仓库名> - 一句话英文描述，说清它做什么
```

- **分类建议**：`Workflow & Automation`（备选 `Development & Runtime`）
- 描述要和列表里其它条目同风格：一句英文，先讲它做什么
- 别写营销词。列表的审核会**对着源码核**：「如果描述说 46 个工具，会有人去数」

### 收录门槛（原文四条）

1. 能用 `dsh plugin add` 装上（声明了 `dsh.bundle` manifest）—— 我们满足
2. 做的事和那行描述一致
3. 分类对
4. 有维护

**不是永久的**：仓库消失、停止维护、坏掉会被移除。

### 另有一条更快的索引通道

dsh 0.2.1+ 的「插件 → 发现 → 索引源」里可以添加
`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` —— 那是同一份列表的
format-1 索引，放在 npm 上分发。**这只影响本地能不能搜到，不替代上面的 PR**。

## 1. 本地必须全绿

```
node scripts/check.js     # 每个模块都能加载
node test/run.js          # 全部用例
node scripts/pack-check.js # 打包清单自检：files 都存在、必需项都在、engines 是范围
```

## 2. 看一眼真正会被打包的东西

```
npm pack --dry-run
```

确认列表里**没有** `test/`、`scripts/`、`.scratch/`、`docs/` —— 包的体积与内容应该只有
`index.js`、`lib/`、`skills/`、`cordis.patch.yml`、`LICENSE`、`THIRD-PARTY-NOTICES.md`。

## 3. 版本

`0.x` 阶段：行为变化就跳 minor，修 bug 跳 patch，`0.1.0 → 0.1.1` 不承诺兼容。
`README` 与 `package.json` 的版本号一起改。

## 4. CI

`.github/workflows/ci.yml` 在 push 与 PR 上跑 Node 22 与 24，三个检查同上。
**它没跑过之前不要发版** —— 这个仓库目前只在 Windows 上验过。

## 5. 发版

```
npm publish --access public
```

然后在本机 DSH 里重新装一次，确认命令与工具都注册上了：

```
/manager status
```

## 已知的未验证项

- `engines.dsh` 的范围只在一个版本（0.2.3-alpha.2）上跑过
- 全部测试只在 Windows 上跑过，Linux/macOS 靠 CI 补
- git 快照用真实仓库验证过，但只在 `D:\plugin` 这一个仓库上

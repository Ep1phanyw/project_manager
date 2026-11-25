# 发布前检查

## 0. 名字与包名

- **npm 包名**：`dsh-project-manager-plugin`（2026-11-25 用 `npm view` 查过：`project_manager` 现在返回 404，但那个名字太泛、且在别的生态里重名多；`dsh-project-manager-plugin` 更能被搜到）。
- **GitHub 仓库**：`Ep1phanyw/project_manager`（仓库名不动，`package.json` 的 `repository` 指回来即可）。
- **bundle id 必须等于包名**：`cordis.patch.yml` 里的 `id` 与 `name` 都是 `dsh-project-manager-plugin`。
- **改包名之后要重装**：profile 里记的是 `include:<包名>`，旧行读的仍是 `project_manager`，必须重装一次插件（`plugin_manager` 或 Plugins 页）。

## 0.5 怎么被人搜到

包名里已经带 `dsh`，再加两处标记：

| 位置 | 写什么 | 状态 |
| --- | --- | --- |
| **GitHub 仓库 Topics** | `dsh-plugin`（必须）、`deepseek-harness`、`dsh`、`cordis`、`ai-agent` | 已设置 |
| `package.json` → `keywords` | `dsh`、`deepseek-harness`、`dsh-plugin`、`cordis` 等 | 已设置 |

另外 GitHub 仓库描述目前是空的，建议填一句（搜索与市场卡片会用）。

## 0.6 进 dshmarket（DSH 内置插件市场）

**不是投稿给市场，是给精选列表提 PR。** 市场只允许安装列表内的来源——不进这份列表，市场里搜不到、也装不了。

目标仓库：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>

### 提交形态（2026-11 实测）

一个 PR 只加**一个 YAML 文件**：`data/plugins/<owner>__<repo>.yml`。两个 README 由脚本生成，**不要手改**。

```yaml
url: https://github.com/Ep1phanyw/project_manager
name: Ep1phanyw/project_manager
category: workflow
description:
  en: 'Project orchestration for DSH: splits work into parts run by independent subagent conversations, and verifies each part by executing checks itself — command exit codes and artifact assertions — with user-only approval and a final full rerun.'
  zh: 把一次交付拆成若干部分，交给独立上下文里的子对话并行完成；验收由插件亲自执行检查（命令退出码与产物断言），计划批准与收尾点头只归用户，收尾会全量重跑一遍。
```

- `description.en` 必填；评审会**对着源码核**描述里的每一句，别写「N 个工具」这类数字除非对得上。
- 可选 `icon:`（GitHub 托管的 png/jpg/webp，约 96px）、仓库内 `screenshots.json`（1–8 张）。
- 一个 PR 最多 3 条；我们只提 1 条。

### 收录门槛

1. `package.json` 声明 `dsh.bundle`（我们通过 `dsh.bundle.patch` 满足）
2. 做的事和那行描述一致
3. 分类对（`workflow`）
4. 有维护

CI 还会查：条目数、manifest、**仓库年龄 ≥ 1 天**、awesome-lint 与站点构建。评审可能打 `held: author` 让你改描述——改同一分支即可，不用重开 PR。

**已提交**：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/18772>（2026-11-25，分支 `Ep1phanyw:add-dsh-project-manager-plugin`，只加了一个 YAML 文件）。

### npm 与市场的关系

npm 发布**不是收录前提**，但发布后市场能显示下载量、安装也免掉 `allowBuilds` 构建授权这一步。发布后映射自动从 registry 采集（要求包的 `repository` 指回本仓库），条目里不用写任何 npm 字段。

## 1. 本地必须全绿

```
node scripts/check.js     # 17 个模块都能加载
node test/run.js          # 318 条用例
node scripts/pack-check.js # 打包清单自检
```

## 2. 看一眼真正会被打包的东西

```
npm pack --dry-run
```

确认列表里**没有** `test/`、`scripts/`、`.scratch/`、`docs/` —— 包的内容应该只有
`index.js`、`lib/`、`skills/`、`cordis.patch.yml`、`LICENSE`、`THIRD-PARTY-NOTICES.md`。

## 3. 版本

当前 `0.3.0`（首个公开版本；此前从未发过 npm）。`0.x` 阶段：行为变化跳 minor，修 bug 跳 patch，不承诺兼容。

## 4. CI

`.github/workflows/ci.yml` 在 push 与 PR 上跑 Node 22 与 24，三个检查同上。**已实际跑过且全绿**（2026-11-25 的 5 次 push 都是 success）。

## 5. 发版（需要 npm 凭据，人来做）

```
npm login
npm publish --access public
```

发布之后**不要相信 `+ name@version` 那行**：

1. 查 `https://registry.npmjs.org/dsh-project-manager-plugin`：`dist-tags.latest` 必须等于 0.3.0，`dist.tarball` 能下载。
2. 在干净 profile 里真装一遍：`dsh plugin --profile test add dsh-project-manager-plugin`。
3. 新包名可能先留一个 `0.0.0-stage` 占位壳；国内镜像还可能把旧壳当 `latest`（`registry.npmmirror.com`），必要时让它重新抓取：`curl -X PUT https://registry.npmmirror.com/dsh-project-manager-plugin/sync`。

## 已知的未验证项

- `engines.dsh` 的范围只在 0.2.3-alpha.2 上跑过 —— 上界 `<0.4.0` 是声明，不是实测；0.3.x 靠运行时能力探测而不是版本号来工作，能不能用看 `/manager doctor` 的能力清单
- 测试只在 Windows 上跑过；CI 跑的是 Linux（Node 22 / 24）且已绿
- git 快照只在少数真实仓库上验证过
- 没有对「DSH 升级后插件能不能装上」做过回归；`/manager doctor` 只能事后告诉你缺了什么
- 改包名之前装过的 profile 不会自动迁移，需要重装

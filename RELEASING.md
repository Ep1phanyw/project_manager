# 发布前检查

## 0. 名字（当前阻塞）

`dsh-manager` 这个名字 **npm 上已经被占**（`tudamu`，2026-10-07 发布，0.0.1）。
在改名之前不能 `npm publish`，否则会得到 403。

两个选项：

| 选项 | 说明 |
| --- | --- |
| **改包名** | 例如 `dsh-project-manager`。要同步改 `package.json` 的 `name`、`cordis.patch.yml` 的 `id`，并重新安装一次插件（profile 里记的是 `include:<包名>`） |
| **加 scope** | 例如 `@ep1phanyw/dsh-manager`。自己的 scope 一定可用，不用猜名字有没有被占 |

改完之后 `bundle` 的 id 与包名要保持一致 —— 这条是 `cordis.patch.yml` 开头的约定。

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

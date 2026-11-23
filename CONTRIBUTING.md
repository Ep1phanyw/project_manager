# 参与开发

## 环境

```sh
node --version   # >= 22
```

插件零运行时依赖，不需要 `npm install`。

## 跑检查

```sh
node scripts/check.js     # 每个模块都能加载（改动后第一时间跑它）
node test/run.js          # 全部用例，一个进程跑完
node scripts/pack-check.js # 打包清单自检
```

`node --test` 不要直接用在多文件上：它会为每个测试文件开子进程，在受限环境里会被拒绝。
用 `node test/run.js` 就一个进程跑完。

## 代码结构

| 文件 | 负责什么 |
| --- | --- |
| `index.js` | 宿主半侧入口：登记命令与工具 |
| `lib/project-state.js` | 状态机与校验器（本项目的心脏） |
| `lib/store.js` | markdown 落盘 |
| `lib/format.js` | 给人看的排版 |
| `lib/skills.js` | 三个随包分发的技能 |
| `lib/records.js` | 部分记录的渲染与解析 |
| `lib/config.js` | 配置读取（快照模式、证据类型） |
| `lib/exec.js` | 跑核对命令并取回输出 |
| `lib/git.js` | 越界改动检查 |
| `lib/workspace.js` | 判断工作区是不是空的 |

## 测试的写法

状态机的用例全部用**假 store 与假子对话执行器**，不碰真实会话、不需要网络。
少数几个真的开进程：`test/exec.test.js`（真命令）与 `test/stray.test.js`（真 git 仓库）。

**改函数签名之前先 grep 调用点。** 这个项目栽过两次：加了参数却漏了某个调用点，
测试还是绿的 —— 因为那条路径没有用例走过。补用例要补**触发条件**，不是补代码。

## 一条约定

护栏落在**返回值**上，不要落在提示词里。「请在确认后再继续」这种话是拦不住的，
只有「这个操作必须 `by: 'user'`，而模型手上没有这个工具」才拦得住。

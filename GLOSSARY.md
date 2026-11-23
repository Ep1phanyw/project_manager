# Project Orchestrator

一次项目交付如何被拆成**部分**、分派给**子对话**、并在用户设定的**验收标准**前收工。这份词汇表只定义概念，不记录实现。

## Language

**Project**（项目）:
一个待交付的目标，拥有自己的计划、若干部分和验收标准。

_Avoid_: feature, effort, epic

**Main conversation**（主对话）:
当前会话中被指定为项目指挥者的那一个，负责规划、分派、汇总，并按验收标准判定是否收工。

_Avoid_: orchestrator, manager, coordinator, 项目经理

_Note_: 插件与命令叫 `dsh-manager` / `/manager`，那是产品名；这个概念本身一律叫「主对话」，工具名也不该被读成对这个概念的另一种称呼。

**Plan**（计划）:
项目开始时产出、并经用户批准的部分清单，含每部分的先后顺序、依赖关系、涉及的文件集与要求的证据类型。

_Avoid_: roadmap, schedule, 任务列表

**Part**（部分）:
项目计划里的一个工作单元，恰好由一个子对话完成。

_Avoid_: task, ticket, work item, subtask, 章节

**Child conversation**（子对话）:
上下文独立的子代理，只把结构化结果交回主对话；它的完整记录落盘备查。子对话不能自己再开子对话。

_Avoid_: subagent, worker, 任务会话

**Acceptance criteria**（验收标准）:
由主对话向用户提问后确定、可逐条核对的条件，每条都要求可复现的证据；未全部满足不得收工。

_Avoid_: 交付标准, definition of done, requirements, 需求

**Phase**（阶段）:
项目此刻所处的状态：规划（还没有计划）、待批准（计划已提交，等你点头）、执行（已批准，可以派分部分）。

_Avoid_: status, state, 状态

**Approval**（审批）:
用户对计划的一次裁决记录：批准、驳回、或「计划已更新，需重新批准」。它既是留痕，也是派分闸门的依据 —— 只看这一行，不看 `阶段：` 那一行。

_Avoid_: 签字, 授权, sign-off

**Evidence**（证据）:
用于证明一个部分达标的可复现产物：测试通过、构建成功、某条命令的输出、或生成的产物。「我确认过了」不构成证据。

_Avoid_: proof, 证明, 结果, 自述

**Blocked**（阻塞）:
主对话必须停下并出报告的状态，只在三种情形成立：同一部分连续两次验收失败且失败原因未变；缺少只有用户能提供的东西；需要改动验收标准本身。主对话不得在任何其他情形下宣布阻塞，也不得自行降低验收标准。

_Avoid_: stuck, 失败, 做不出来

**Needs user verification**（待确认）:
一个部分已产出材料，但它的证据只能由用户亲眼判断。它既不是完成、也不是阻塞：主对话停下把材料摊给用户，用户点头才继续。

_Avoid_: 人工验收, manual check

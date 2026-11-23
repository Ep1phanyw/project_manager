/**
 * 单进程跑完全部测试。
 *
 * 一个 `node test/run.js` 就够了 —— 不再串十个进程，
 * 也不需要 `node --test`（它会为每个文件 spawn 一个子进程）。
 */

import './registration.test.js'
import './project-state.test.js'
import './plan.test.js'
import './approval.test.js'
import './records.test.js'
import './dispatch.test.js'
import './verify.test.js'
import './blocked.test.js'
import './confirm.test.js'
import './progress.test.js'
import './skills.test.js'
import './workspace.test.js'

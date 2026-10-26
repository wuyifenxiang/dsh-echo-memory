// 冒烟测试：用一个假的 ctx 真正 apply 一次插件，确认
//   - 六个依赖都能挂上
//   - 工具真的注册了（名字是 echo_*）
//   - systemPrompt.context 真的开了
//   - HTTP 路由真的注册了
// 目标不是验证业务逻辑（那是 tests/*.test.mjs 的事），而是验证「装上去不会崩」。
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'echo-smoke-'))

const mod = await import('../lib/index.js')

const registeredTools = []
const routes = []
const promptContexts = []
const timers = []

const ctx = {
  logger: { info() {}, warn() {}, debug() {}, error() {} },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  timer: {
    interval(fn, ms) { timers.push({ fn, ms }); return () => {} },
  },
  agents: {
    list() {
      return [{
        cwd: 'D:/demo/workspace',
        session: { id: 'sess-1', header: { cwd: 'D:/demo/workspace' } },
        ctx: {
          on() { return () => {} },
          systemPrompt: {
            context(spec) { promptContexts.push(spec); return () => {} },
          },
          tools: {
            register(tool) { registeredTools.push(tool); return () => {} },
          },
        },
      }]
    },
  },
  tools: { register(t) { registeredTools.push(t); return () => {} } },
  webServer: {
    register(r) { routes.push(r); return () => {} },
  },
  systemPrompt: { context() { return () => {} } },
  get() { return undefined },
}

mod.apply(ctx)

// tick() 由 timer.interval 建立，宿主会在 2s 后调用；这里手动跑一次，
// 等价于「第一轮 tick」——所有挂载都在里面发生。
assert.ok(timers.length >= 1, '应该注册了定时器')
timers[0].fn()

const names = registeredTools.map((t) => t.name)
assert.deepEqual(
  [...new Set(names)].sort(),
  ['echo_forget', 'echo_recall', 'echo_remember', 'echo_stats'],
  `工具注册不完整：${JSON.stringify(names)}`,
)

// 每个工具都必须有 output.render —— 少了它宿主会抛
// `Cannot read properties of undefined (reading 'render')`（原版踩过这个坑）
for (const t of registeredTools) {
  assert.ok(t.output && typeof t.output.render === 'function', `${t.name} 缺 output.render`)
  assert.equal(typeof t.execute, 'function', `${t.name} 缺 execute`)
  assert.ok(t.parameters && t.parameters.type === 'object', `${t.name} 的 parameters 不是 JSON Schema`)
}

assert.ok(promptContexts.length >= 1, 'systemPrompt.context 没挂上')
assert.equal(promptContexts[0].name, 'echo-memory')
assert.equal(typeof promptContexts[0].text, 'function')

const paths = routes.map((r) => r.path)
for (const p of [
  '/dsh-echo-memory/sessions',
  '/dsh-echo-memory/memories',
  '/dsh-echo-memory/config',
  '/dsh-echo-memory/remember',
  '/dsh-echo-memory/curve',
  '/dsh-echo-memory/backfill',
]) {
  assert.ok(paths.includes(p), `缺路由 ${p}（实际：${paths.join(', ')}）`)
}

// 曲线与回填通过 __test 暴露，设置页靠它们画图/提案
assert.equal(typeof mod.__test.retentionCurves, 'function')
assert.equal(typeof mod.__test.backfillProposals, 'function')
const c = mod.__test.retentionCurves(mod.__test ? {} : {}, {})
assert.ok(c.series.length > 0, '曲线应能采样')

// 注入文案函数不能抛，且空输入返回空串
assert.equal(promptContexts[0].text(), '')

console.log('smoke ok:', names.length, 'tools,', routes.length, 'routes,', promptContexts.length, 'prompt contexts')

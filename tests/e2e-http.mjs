// 端到端：真的调用注册进来的 HTTP handler（假 req/res），验证
// 记住 → 列表 → 曲线 → 回填 → 确认写入 这条完整链路。
// 冒烟测试只证明「挂上了」，这个证明「能用」。
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'echo-e2e-'))

const mod = await import('../lib/index.js')

const handlers = new Map()
const ctx = {
  logger: { info() {}, warn() {}, debug() {}, error() {} },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  timer: { interval() { return () => {} } },
  agents: {
    list: () => [{
      cwd: 'D:/demo/proj',
      session: { id: 's1', header: { cwd: 'D:/demo/proj' } },
      ctx: {
        on: () => () => {},
        systemPrompt: { context: () => () => {} },
        tools: { register: () => () => {} },
      },
    }],
  },
  tools: { register: () => () => {} },
  webServer: { register(r) { handlers.set(r.path, r.handler); return () => {} } },
  systemPrompt: { context: () => () => {} },
  get: () => undefined,
}
mod.apply(ctx)

// 用真的 req/res 形状驱动 handler
function call(path, { method = 'GET', query = {}, body = null } = {}) {
  const qs = new URLSearchParams(query).toString()
  const req = {
    method,
    url: path + (qs ? '?' + qs : ''),
    on(ev, cb) {
      if (ev === 'data' && body !== null) cb(JSON.stringify(body))
      if (ev === 'end') cb()
      return req
    },
    destroy() {},
  }
  let out = ''
  const res = {
    writeHead() {},
    end(s) { out += s || '' },
  }
  return Promise.resolve(handlers.get(path)(req, res)).then(() => JSON.parse(out || '{}'))
}

const KEY = 'ws-proj'

// 1. 记三条：强情绪 / 中等 / 无情绪
const a = await call('/dsh-echo-memory/remember', { method: 'POST', body: { key: KEY, text: '那天吃的抹茶小蛋糕，特别感动', emo: 1, imp: 0.5 } })
const b = await call('/dsh-echo-memory/remember', { method: 'POST', body: { key: KEY, text: '今天开了一个会', emo: 0, imp: 0.3 } })
const c = await call('/dsh-echo-memory/remember', { method: 'POST', body: { key: KEY, text: '有点累但还行', emo: 0.3, imp: 0.3 } })
assert.ok(a.ok && b.ok && c.ok, '三条都应写入成功')

// 2. 列表：每条都带 decay 剖面
const list = await call('/dsh-echo-memory/memories', { query: { key: KEY } })
assert.equal(list.rows.length, 3)
for (const r of list.rows) {
  assert.ok(r.decay, `${r.id} 缺 decay 剖面`)
  assert.equal(typeof r.decay.halfLifeDays, 'number')
}
const cake = list.rows.find((r) => r.text.includes('抹茶'))
assert.equal(cake.emo, 1)
assert.ok(Math.abs(cake.decay.halfLifeDays - 90) < 0.01, `emo=1 半衰期应 90 天，实际 ${cake.decay.halfLifeDays}`)
const meeting = list.rows.find((r) => r.text.includes('开了一个会'))
assert.ok(Math.abs(meeting.decay.halfLifeDays - 30) < 0.01, `emo=0 半衰期应 30 天，实际 ${meeting.decay.halfLifeDays}`)

// 3. 曲线：不依赖库内容也能出
const curve = await call('/dsh-echo-memory/curve', { query: { days: '90', points: '7' } })
assert.ok(curve.ok && curve.curve.series.length === 4)
assert.equal(curve.curve.totalDays, 90)
assert.equal(curve.curve.series[0].points.length, 7)

// 4. 回填：老条目 emo=0，先出提案不写盘
await call('/dsh-echo-memory/update', { method: 'POST', body: { key: KEY, id: meeting.row?.id || meeting.id, patch: { text: '那天特别开心，感动到哭' } } })
const dry = await call('/dsh-echo-memory/backfill', { method: 'POST', body: { key: KEY, confirm: false } })
assert.ok(dry.ok && dry.dryRun === true)
const before = await call('/dsh-echo-memory/memories', { query: { key: KEY } })
const sameEmo = before.rows.find((r) => r.text.includes('感动到哭')).emo
assert.equal(sameEmo, 0, 'dry run 不应改动数据')

// 5. 确认写入后 emo 提升
const applied = await call('/dsh-echo-memory/backfill', { method: 'POST', body: { key: KEY, confirm: true } })
assert.ok(applied.ok && applied.dryRun === false)
const after = await call('/dsh-echo-memory/memories', { query: { key: KEY } })
const filled = after.rows.find((r) => r.text.includes('感动到哭'))
assert.ok(filled.emo > 0, `回填后 emo 应 > 0，实际 ${filled.emo}`)

// 6. 配置写入后曲线跟着变
await call('/dsh-echo-memory/config', { method: 'POST', body: { emotionHalfLifeSpan: 5 } })
const cfg2 = await call('/dsh-echo-memory/config')
assert.equal(cfg2.cfg.emotionHalfLifeSpan, 5)
const curve2 = await call('/dsh-echo-memory/curve')
const hot = curve2.curve.series.find((s) => s.emo === 1)
assert.ok(Math.abs(hot.halfLifeDays - 180) < 0.5, `span=5 时 emo=1 应 180 天，实际 ${hot.halfLifeDays}`)

// 7. 越界参数被钳住，不炸
await call('/dsh-echo-memory/config', { method: 'POST', body: { halfLifeEventDays: -99, emotionGamma: 0 } })
const cfg3 = await call('/dsh-echo-memory/config')
assert.ok(cfg3.cfg.halfLifeEventDays >= 1, `半衰期不得 <1，实际 ${cfg3.cfg.halfLifeEventDays}`)
assert.ok(cfg3.cfg.emotionGamma >= 0.05, `gamma 不得为 0，实际 ${cfg3.cfg.emotionGamma}`)

console.log('e2e ok: 记住→列表→曲线→回填→确认→改参数 全链路通过')

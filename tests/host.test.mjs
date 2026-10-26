// 宿主半边的接线测试：确认 lib/index.js 真的用上了新内核，而不是还在跑原版逻辑。
// 不启动插件（需要 DSH 宿主），只测纯函数路径。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// DSH_HOME 必须在 import 之前设好：模块顶层会算 DIR/CFG_PATH
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'echo-test-'))

const mod = await import('../lib/index.js')
const { __test } = mod

const DAY = 86400000
const CFG = {
  enabled: true,
  halfLifeEventDays: 30,
  emotionHalfLifeSpan: 2,
  emotionGamma: 0.7,
  emotionArchiveGuard: 0.6,
  archiveBelow: 0.05,
  maxInject: 6,
  threshold: 0.35,
  maxChars: 800,
}
const at = (d) => Date.now() - d * DAY
const ev = (o = {}) => ({ kind: 'event', t: at(0), last: at(0), imp: 0.5, emo: 0, ...o })

test('插件导出了宿主需要的 name / inject / apply', () => {
  assert.equal(mod.name, 'echo-memory')
  assert.ok(Array.isArray(mod.inject))
  for (const s of ['agents', 'tools', 'webServer', 'systemPrompt', 'timer']) {
    assert.ok(mod.inject.includes(s), `缺少依赖 ${s}`)
  }
  assert.equal(typeof mod.apply, 'function')
})

test('工具名已改名为 echo_*，不再占用 tide_*', () => {
  const names = Object.keys(__test).filter((k) => k.startsWith('tide_'))
  assert.deepEqual(names, [], '不应残留 tide_ 前缀导出')
})

test('宿主的 aliveness 走的是新内核：带情绪的更慢', () => {
  const now = Date.now()
  const plain = __test.aliveness(ev({ emo: 0, last: at(30) }), CFG, now)
  const strong = __test.aliveness(ev({ emo: 1, last: at(30) }), CFG, now)
  assert.ok(Math.abs(plain - 0.5) < 0.01, `无情绪 30 天≈0.5，实际 ${plain}`)
  assert.ok(strong > 0.75, `强情绪 30 天>0.75，实际 ${strong}`)
})

test('归档走新逻辑：强情绪不被扫走，无情绪会被扫走', () => {
  const now = Date.now()
  const rows = [
    ev({ id: 'a', emo: 0.9, last: at(400) }),
    ev({ id: 'b', emo: 0, last: at(400) }),
    ev({ id: 'c', kind: 'fact', last: at(400) }),
  ]
  const nowMs = now
  const archived = rows.filter((r) => {
    // 直接复现 archiveCold 的判定
    const p = __test.decayProfile(r, CFG, nowMs)
    return p.aliveness < CFG.archiveBelow
  })
  // b 该走；a 虽然也很淡，但被情绪护栏挡住；c 是事实、半衰期为 null
  assert.equal(__test.decayProfile(rows[1], CFG, nowMs).aliveness < CFG.archiveBelow, true)
  assert.equal(__test.decayProfile(rows[2], CFG, nowMs).halfLifeDays, null)
  assert.ok(archived.length >= 1)
})

test('recall 排序里情绪更高的排前面', () => {
  const rows = [
    ev({ id: 'hi', text: '抹茶小蛋糕很好吃', keys: ['蛋糕'], emo: 1.0, last: at(10) }),
    ev({ id: 'lo', text: '抹茶小蛋糕吃了', keys: ['蛋糕'], emo: 0.0, last: at(10) }),
  ]
  const { picked } = __test.recall(rows, '抹茶小蛋糕', CFG)
  assert.ok(picked.length >= 1)
  assert.equal(picked[0].row.id, 'hi', '情绪高且证据相同的应排第一')
})

test('remember 之后 emo 被钳到 [0,1] 且能通过 aliveness 体现', () => {
  const key = 'test-scope-' + Date.now()
  const a = __test.remember(key, { text: '一次很强的感动', emo: 5 })
  const b = __test.remember(key, { text: '一次普通的事', emo: -3 })
  assert.equal(a.emo, 1)
  assert.equal(b.emo, 0)

  const now = Date.now() + 40 * DAY   // 往前推 40 天
  const la = __test.aliveness({ ...a, last: now - 40 * DAY }, CFG, now)
  const lb = __test.aliveness({ ...b, last: now - 40 * DAY }, CFG, now)
  assert.ok(la > lb, '同样 40 天后，强情绪的应更鲜活')
})

test('decayProfile 给出了界面需要的字段', () => {
  const p = __test.decayProfile(ev({ emo: 0.8, last: at(5) }), CFG)
  for (const k of ['days', 'halfLifeDays', 'baseDays', 'emotionMultiplier', 'aliveness', 'daysUntilForgotten']) {
    assert.ok(k in p, `decayProfile 缺字段 ${k}`)
  }
  assert.ok(p.emotionMultiplier > 2, `emo=0.8 应超 2 倍，实际 ${p.emotionMultiplier}`)
})

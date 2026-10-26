// 衰减内核的契约测试：这些断言就是「情绪越强、遗忘越慢」的可执行定义。
// 跑：node --test tests/
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DAY,
  emotionHalfLifeMultiplier,
  effectiveHalfLife,
  aliveness,
  rankScore,
  shouldArchive,
  decayProfile,
} from '../lib/decay.js'

const CFG = {
  halfLifeEventDays: 30,
  emotionHalfLifeSpan: 2,
  emotionGamma: 0.7,
  emotionArchiveGuard: 0.6,
  archiveBelow: 0.05,
}

const at = (daysAgo) => Date.now() - daysAgo * DAY
const ev = (over = {}) => ({ kind: 'event', t: at(0), last: at(0), imp: 0.5, emo: 0, ...over })

test('情绪为 0 时不延长半衰期', () => {
  assert.equal(emotionHalfLifeMultiplier(0, CFG), 1)
  assert.equal(emotionHalfLifeMultiplier(undefined, CFG), 1)
})

test('情绪越强，半衰期倍数单调递增', () => {
  const xs = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1].map((e) => emotionHalfLifeMultiplier(e, CFG))
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1], `应单调递增：${xs}`)
  assert.equal(xs.at(-1), 3) // emo=1 → 1+2×1 = 3 倍封顶
})

test('情绪 0.5 时半衰期超过两倍（gamma<1 把曲线抬高）', () => {
  const m = emotionHalfLifeMultiplier(0.5, CFG)
  // 0.5^0.7 ≈ 0.6156 → 1 + 2×0.6156 ≈ 2.231
  assert.ok(Math.abs(m - 2.2311) < 0.001, `期望 ≈2.231，实际 ${m}`)
  // gamma=1 时才是线性 2.0，gamma<1 必须更高
  assert.ok(m > emotionHalfLifeMultiplier(0.5, { ...CFG, emotionGamma: 1 }))
})

test('span=0 时彻底关闭情绪效应', () => {
  const off = { ...CFG, emotionHalfLifeSpan: 0 }
  assert.equal(emotionHalfLifeMultiplier(1, off), 1)
})

test('事件半衰期 = 基线 × 情绪倍数', () => {
  assert.equal(effectiveHalfLife(ev({ emo: 0 }), CFG), 30)
  assert.ok(Math.abs(effectiveHalfLife(ev({ emo: 1 }), CFG) - 90) < 1e-9)
})

// ── 这条是整个插件的存在理由 ──
test('同样过 30 天：强情绪记忆留存远高于无情绪记忆', () => {
  const now = Date.now()
  const plain = ev({ emo: 0, last: at(30) })
  const strong = ev({ emo: 1, last: at(30) })
  const a0 = aliveness(plain, CFG, now)
  const a1 = aliveness(strong, CFG, now)
  assert.ok(a0 > 0.49 && a0 < 0.51, `无情绪 30 天应≈50%，实际 ${a0}`)
  assert.ok(a1 > 0.75, `强情绪 30 天应>75%，实际 ${a1}`)
  assert.ok(a1 > a0 * 1.5, '强情绪必须明显更慢')
})

test('原版的错误方向已被修正：带情绪不再比无情绪更快遗忘', () => {
  const now = Date.now()
  const rows = [0, 0.2, 0.4, 0.6, 0.8, 1].map((emo) => aliveness(ev({ emo, last: at(20) }), CFG, now))
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i] >= rows[i - 1], `情绪升高时留存不得下降：${rows}`)
  }
})

test('事实与钉住的记忆不衰减', () => {
  const old = at(9999)
  assert.equal(aliveness({ kind: 'fact', last: old, emo: 0 }, CFG), 1)
  assert.equal(aliveness({ kind: 'event', pinned: true, last: old, emo: 0 }, CFG), 1)
})

test('被想起来会回血（last 刷新）', () => {
  const now = Date.now()
  const stale = ev({ emo: 0.4, last: at(40) })
  const fresh = ev({ emo: 0.4, last: at(1) })
  assert.ok(aliveness(fresh, CFG, now) > aliveness(stale, CFG, now))
})

test('排序分不超过证据分，且情绪高的排前面', () => {
  const base = { evidence: 0.6, aliveness: 0.5, importance: 0.5 }
  const low = rankScore({ ...base, emotion: 0 })
  const high = rankScore({ ...base, emotion: 1 })
  assert.ok(high > low)
  assert.ok(high <= 0.6 + 1e-12, 'P 不得大于 C')
  assert.equal(rankScore({ evidence: 0, aliveness: 1, importance: 1, emotion: 1 }), 0)
})

test('强情绪记忆不会因为淡了就被扫进冷宫', () => {
  const now = Date.now()
  const fadedStrong = ev({ emo: 0.9, last: at(400) })   // 早就淡透了
  const fadedPlain = ev({ emo: 0, last: at(400) })
  assert.equal(shouldArchive(fadedStrong, CFG, now), false, '强情绪应留档')
  assert.equal(shouldArchive(fadedPlain, CFG, now), true, '无情绪应归档')
})

test('归档豁免有边界：emo 低于 guard 且淡透仍然归档', () => {
  const now = Date.now()
  assert.equal(shouldArchive(ev({ emo: 0.5, last: at(400) }), CFG, now), true)
  assert.equal(shouldArchive(ev({ emo: 0.6, last: at(400) }), CFG, now), false) // 恰好等于 guard
})

test('归档不动事实、钉住、以及被想起过的', () => {
  const now = Date.now()
  const old = at(400)
  assert.equal(shouldArchive({ kind: 'fact', last: old, emo: 0 }, CFG, now), false)
  assert.equal(shouldArchive({ kind: 'event', pinned: true, last: old, emo: 0 }, CFG, now), false)
  assert.equal(shouldArchive({ kind: 'event', last: old, emo: 0, hits: 2 }, CFG, now), false)
})

test('decayProfile 给界面解释得通：情绪越强，距遗忘越远', () => {
  const now = Date.now()
  const p0 = decayProfile(ev({ emo: 0, last: at(0) }), CFG, now)
  const p1 = decayProfile(ev({ emo: 1, last: at(0) }), CFG, now)
  assert.equal(p0.halfLifeDays, 30)
  assert.equal(p1.halfLifeDays, 90)
  assert.equal(p1.emotionMultiplier, 3)
  assert.ok(p1.daysUntilForgotten > p0.daysUntilForgotten)
  assert.equal(decayProfile({ kind: 'fact', last: at(0) }, CFG, now).halfLifeDays, null)
})

test('退化输入不抛错', () => {
  assert.equal(emotionHalfLifeMultiplier(NaN, CFG), 1)
  assert.equal(emotionHalfLifeMultiplier(-5, CFG), 1)
  assert.equal(emotionHalfLifeMultiplier(99, CFG), 3)    // 越界钳到 1
  assert.equal(aliveness(null, CFG), 0)
  assert.doesNotThrow(() => decayProfile({}, {}))
  assert.doesNotThrow(() => shouldArchive({}, {}))
})

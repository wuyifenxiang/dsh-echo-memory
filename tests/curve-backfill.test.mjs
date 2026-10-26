// 曲线采样 + 情绪回填的契约测试。
import test from 'node:test'
import assert from 'node:assert/strict'

import { retentionCurves } from '../lib/curve.js'
import { inferEmotion, backfillProposals } from '../lib/backfill.js'

const CFG = {
  halfLifeEventDays: 30,
  emotionHalfLifeSpan: 2,
  emotionGamma: 0.7,
  emotionArchiveGuard: 0.6,
  archiveBelow: 0.05,
}

// ─────────────── 曲线 ───────────────

test('曲线给出 4 条默认线，情绪越高越靠上', () => {
  const c = retentionCurves(CFG, { days: 120, points: 25 })
  assert.equal(c.series.length, 4)
  assert.deepEqual(c.series.map((s) => s.emo), [0, 0.3, 0.6, 1])

  // 在同一横轴上，情绪高的保留率必须 >= 情绪低的（逐点验证，不是只看末端）
  for (let i = 0; i < c.days.length; i++) {
    for (let s = 1; s < c.series.length; s++) {
      assert.ok(
        c.series[s].points[i].retention >= c.series[s - 1].points[i].retention - 1e-9,
        `第 ${i} 个采样点：emo=${c.series[s].emo} 的留存不应低于 emo=${c.series[s - 1].emo}`,
      )
    }
  }
})

test('曲线起点都是 1、终点递减，且横轴等距到 totalDays', () => {
  const c = retentionCurves(CFG, { days: 100, points: 11 })
  assert.equal(c.days[0], 0)
  assert.equal(c.days.at(-1), 100)
  for (const s of c.series) {
    assert.equal(s.points[0].retention, 1)
    assert.ok(s.points.at(-1).retention < 1)
  }
})

test('emo=0 的线在一个基线半衰期处正好 50%', () => {
  const c = retentionCurves(CFG, { days: 30, points: 3 })
  const flat = c.series.find((s) => s.emo === 0)
  assert.equal(flat.halfLifeDays, 30)
  // points=3 → 采样点为 0/15/30 天；30 天正好一个半衰期
  assert.deepEqual(c.days, [0, 15, 30])
  assert.ok(Math.abs(flat.points[2].retention - 0.5) < 1e-6)
  // 15 天（半个半衰期）应是 1/√2；曲线里保留 4 位小数，容差给到 1e-4
  assert.ok(Math.abs(flat.points[1].retention - Math.SQRT1_2) < 1e-4)
})

test('emo=1 的遗忘日约为 emo=0 的 3 倍', () => {
  const c = retentionCurves(CFG)
  const flat = c.series.find((s) => s.emo === 0)
  const hot = c.series.find((s) => s.emo === 1)
  assert.ok(hot.forgetsAtDay > flat.forgetsAtDay * 2.9)
})

test('曲线对坏参数稳健', () => {
  assert.doesNotThrow(() => retentionCurves({}))
  assert.doesNotThrow(() => retentionCurves(null, { days: -5, points: 0, emos: [] }))
  const c = retentionCurves(CFG, { emos: [2, -1, 'x'] })
  for (const s of c.series) assert.ok(s.emo >= 0 && s.emo <= 1)
})

// ─────────────── 情绪回填 ───────────────

test('强情绪词能被识别，且封顶不猜满', () => {
  const r = inferEmotion({ text: '今天真的特别感动，差点哭了', imp: 0 })
  assert.ok(r.emo >= 0.55, `应识别为强情绪，实际 ${r.emo}`)
  assert.ok(r.emo <= 0.85, '不应猜满 1.0')
  assert.equal(r.confidence, 'medium')
})

test('温和情绪词给较低的值', () => {
  const r = inferEmotion({ text: '这家店的小蛋糕挺好吃的', imp: 0 })
  assert.ok(r.emo > 0 && r.emo < 0.5, `应偏低，实际 ${r.emo}`)
})

test('没有任何信号时不动它', () => {
  const r = inferEmotion({ text: '明天开会', imp: 0 })
  assert.equal(r.emo, 0)
  assert.equal(r.confidence, 'none')
})

test('重要度能单独折算情绪', () => {
  const r = inferEmotion({ text: '记住了这件事', imp: 1 })
  assert.ok(r.emo > 0.5)
  assert.equal(r.confidence, 'low')   // imp>=0.6 → low，够用但不冒进
})

test('回填只提升不降低，且跳过已过时/已隐藏', () => {
  const rows = [
    { id: 'a', text: '那天真的很开心，特别感动', imp: 0.5, emo: 0 },
    { id: 'b', text: '已经很高的情绪', imp: 0.5, emo: 0.9 },
    { id: 'c', text: '那天真的很开心', imp: 0, emo: 0, supersededBy: 'x' },
    { id: 'd', text: '那天真的很开心', imp: 0, emo: 0, hidden: true },
    { id: 'e', text: '明天开会', imp: 0, emo: 0 },
  ]
  const { proposals, skipped } = backfillProposals(rows, { minConfidence: 'low' })
  const ids = proposals.map((p) => p.id)
  assert.ok(ids.includes('a'), 'a 应该被提议')
  assert.ok(!ids.includes('b'), 'b 已经很高，不该降')
  assert.ok(!ids.includes('c'), '已过时的跳过')
  assert.ok(!ids.includes('d'), '已隐藏的跳过')
  assert.ok(!ids.includes('e'), '没信号的跳过')
  assert.equal(skipped, 4)
})

test('minConfidence 能收紧到只要强信号', () => {
  const rows = [
    { id: 'strong', text: '崩溃大哭', imp: 0 },
    { id: 'weak', text: '有点累', imp: 0 },
    { id: 'imp', text: '很重要', imp: 0.9 },
  ]
  const loose = backfillProposals(rows, { minConfidence: 'low' }).proposals.map((p) => p.id)
  const tight = backfillProposals(rows, { minConfidence: 'medium' }).proposals.map((p) => p.id)
  assert.ok(loose.length > tight.length)
  assert.deepEqual(tight, ['strong'])
})

test('回填提案自带可解释的理由', () => {
  const { proposals } = backfillProposals([{ id: 'x', text: '特别开心', imp: 0, emo: 0 }])
  assert.ok(proposals[0].reason.includes('情绪词'), `理由应说清楚，实际：${proposals[0].reason}`)
  assert.equal(typeof proposals[0].confidence, 'string')
})

test('回填对空/畸形输入不抛', () => {
  assert.doesNotThrow(() => backfillProposals(null))
  assert.doesNotThrow(() => backfillProposals([null, undefined, {}]))
  assert.deepEqual(backfillProposals([]).proposals, [])
})

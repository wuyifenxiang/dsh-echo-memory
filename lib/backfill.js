// 情绪回填：让老记忆也能吃到「情绪越强、忘得越慢」。
//
// 背景：这套衰减对 emo=0 的条目等价于「按基线淡忘」。升级前存下的记忆全是 emo=0，
// 所以升级后它们看起来「没享受到新算法」。但情绪是**主观强度**，没法从文本可靠推断 ——
// 与其硬猜（猜错比不猜更糟，会让用户失去对权重的信任），不如：
//
//   1. 提供保守的启发式，并且**默认只做加法不做减法**（只会把 emo 从 0 提到某个值）；
//   2. 结果写进 trace，可回看、可撤销；
//   3. 全程 dryRun 优先，用户看清楚再落盘。
//
// 启发式只用可解释的信号（重要度 + 情绪词命中），并明确标注 confidence。

// 情绪词表：只收「说话时明显带情绪」的词，不收中性描述。
// 分正负两栏只是为了加权（强烈情绪更难忘，正负都算强）。
const STRONG = [
  '开心', '高兴', '兴奋', '激动', '感动', '惊喜', '幸福', '喜欢', '爱', '珍惜',
  '难过', '伤心', '哭', '崩溃', '生气', '愤怒', '害怕', '焦虑', '失望', '委屈',
  '丢脸', '尴尬', '后悔', '遗憾', '孤独', '害怕', '紧张',
]
const WARM = [
  '温暖', '舒服', '安心', '踏实', '满足', '有趣', '好玩', '可爱', '好吃', '漂亮',
  '累', '烦', '担心', '心疼', '可惜', '意外', '没想到', '第一次', '终于',
]

/**
 * 给一条老记忆估一个情绪强度。
 *
 * 只用两个信号，都是可解释的：
 *   - 重要度 imp：用户/模型当时就标了「这件事要紧」，本身接近情绪强度
 *   - 情绪词命中：正文里出现强情绪词 / 温和情绪词
 *
 * 二者取 max 再用命中数小幅加成，封顶 0.85 —— 不猜满，
 * 因为「100% 强情绪」这种判断只有当事人能给。
 *
 * @returns { emo, reason, confidence }  confidence ∈ {'none','low','medium'}
 */
export function inferEmotion(row) {
  const text = String((row && row.text) || '')
  const imp = clamp01(row && row.imp)

  let strongHits = 0
  let warmHits = 0
  for (const w of STRONG) if (text.includes(w)) strongHits++
  for (const w of WARM) if (text.includes(w)) warmHits++

  // 强情绪词命中：一个就够说明问题了
  const fromWords = strongHits > 0
    ? Math.min(0.8, 0.55 + 0.1 * (strongHits - 1))
    : warmHits > 0
      ? Math.min(0.45, 0.28 + 0.06 * (warmHits - 1))
      : 0

  const emo = round(Math.min(0.85, Math.max(imp * 0.85, fromWords)), 3)

  const reason = strongHits > 0
    ? `命中了 ${strongHits} 个强情绪词`
    : warmHits > 0
      ? `命中了 ${warmHits} 个温和情绪词`
      : imp > 0
        ? `按当时标的重要度 ${round(imp, 2)} 折算`
        : '没有可用信号'

  const confidence = strongHits > 0 ? 'medium' : (warmHits > 0 || imp >= 0.6) ? 'low' : 'none'
  return { emo, reason, confidence }
}

/**
 * 给一批记忆生成回填建议（不落盘）。
 *
 * 约束（都是为了「不把事情搞坏」）：
 *   - 只提升，不降低：已经是 emo 更高的条目不动
 *   - 已过时 / 已隐藏的跳过
 *   - 推断 confidence 为 none 的跳过（没信号就别瞎猜）
 *
 * @returns { proposals: [{ id, text, from, to, reason, confidence }], skipped }
 */
export function backfillProposals(rows, opts = {}) {
  const minConfidence = opts.minConfidence || 'low'
  const rank = { none: 0, low: 1, medium: 2 }
  const threshold = rank[minConfidence] ?? 1

  const proposals = []
  let skipped = 0

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.supersededBy || row.hidden) { skipped++; continue }
    const cur = clamp01(row.emo)
    const { emo, reason, confidence } = inferEmotion(row)
    if (rank[confidence] < threshold || emo <= cur + 0.01) { skipped++; continue }
    proposals.push({
      id: row.id,
      text: String(row.text || '').slice(0, 60),
      from: round(cur, 2),
      to: round(emo, 2),
      reason,
      confidence,
    })
  }

  proposals.sort((a, b) => b.to - a.to)
  return { proposals, skipped }
}

function clamp01(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function round(v, digits) {
  const p = Math.pow(10, digits)
  return Math.round(v * p) / p
}

// dsh-echo-memory · 衰减内核（纯函数，无 IO，可直接测试）
//
// 改编自 MingHuanYue/dsh-tide-memory (MIT)。原版的 aliveness 是：
//     half = emo > 0 ? 7 : 30          ← 带情绪的反而忘得更快（4 倍）
//     act  = 0.5 ^ (days / half)
//
// 本文件把「情绪」从**布尔开关**改成**连续增益**，方向反过来：
//     情绪越强 → 半衰期越长 → 遗忘越慢
//
// 这是本插件存在的唯一理由，所以单独成文件、单独测。

export const DAY = 86400000

// ───────────────────────── 情绪 → 半衰期 ─────────────────────────

/**
 * 情绪强度（0~1）换算出的半衰期倍数。
 *
 *     multiplier = 1 + span × emo^gamma
 *
 * emo=0   → 1（不延长，就是基线半衰期）
 * emo=0.5 → 1 + 2×0.5^1 = 2      （中情绪，能记两倍久）
 * emo=1   → 1 + 2 = 3            （强情绪，三倍久）
 *
 * 为什么是 `emo^gamma` 而不是直接用 emo：
 *   γ=1 时情绪是线性的，0.5 和 0.9 只差 1.8 倍，区分度不够。
 *   γ<1（默认 0.7）把曲线往上抬，让「有点情绪」就开始明显减速 —— 
 *   这符合遗忘曲线的实际形状：中等唤醒度已经足够触发杏仁核介入巩固。
 *
 * 为什么封顶 3 倍：
 *   超过 3~4 倍后记忆实际已经「永久」了，再长没有语义差别，
 *   但会让高情绪条目永远压在别人头上、把记忆库变成只进不出的排行榜。
 */
export function emotionHalfLifeMultiplier(emo, cfg = {}) {
  const e = clamp01(emo)
  if (e <= 0) return 1
  const span = numOr(cfg.emotionHalfLifeSpan, 2)   // 0 → 关闭情绪效应
  const gamma = numOr(cfg.emotionGamma, 0.7)
  return 1 + Math.max(0, span) * Math.pow(e, Math.max(0.01, gamma))
}

/**
 * 一条记忆当前的有效半衰期（天）。
 *
 * 基线按 kind 取：事件用 halfLifeEventDays，事实本就不衰减（调用方处理）。
 * 情绪再乘上去 —— 注意**只有事件**享受这个加成，因为事实本来就不衰减，
 * 给它加半衰期是空操作。
 */
export function effectiveHalfLife(row, cfg = {}) {
  const base = Math.max(0.5, numOr(cfg.halfLifeEventDays, 30))
  return base * emotionHalfLifeMultiplier(row && row.emo, cfg)
}

// ───────────────────────── 鲜活度 ─────────────────────────

/**
 * 鲜活度 act ∈ (0, 1]：这条记忆还剩多少「会被想起来」的劲。
 *
 *     act = 0.5 ^ (days / half)
 *
 * days 从 `last` 算（最后一次被写入或被想起来），不是从创建时间 `t` 算 ——
 * 被反复想起的记忆应该回血，这是间隔重复的前提。
 */
export function aliveness(row, cfg = {}, now = Date.now()) {
  if (!row) return 0
  if (row.kind === 'fact') return 1                    // 事实不衰减
  if (row.pinned) return 1                             // 钉住的不衰减
  const anchor = Number(row.last) || Number(row.t) || now
  const days = Math.max(0, (now - anchor) / DAY)
  const half = effectiveHalfLife(row, cfg)
  return Math.pow(0.5, days / half)
}

/**
 * 排序分 P：证据 C 决定「能不能进」，这里的 P 只决定「排多前」。
 *
 *     P = C × (0.50 + 0.30·act + 0.12·imp + 0.08·emo)
 *
 * 系数合计 1.0，所以 P ≤ C —— 排序分永远不会伪造出「证据」。
 * 相比原版（0.55/0.25/0.15/0.05）把权重从 act 挪向 emo：
 * 情绪强的东西即使act略低也该浮上来，这是「情绪挂钩权重」的另一半含义。
 */
export function rankScore({ evidence, aliveness: act, importance, emotion }) {
  const C = clamp01(evidence)
  if (C <= 0) return 0
  return C * (0.50
    + 0.30 * clamp01(act)
    + 0.12 * clamp01(importance)
    + 0.08 * clamp01(emotion))
}

// ───────────────────────── 该不该进冷宫 ─────────────────────────

/**
 * 决定一条记忆是否淡到该挪进冷宫（不删除，只是不再日常浮现）。
 *
 * 原版条件：`!fact && !pinned && act < 0.05 && hits === 0`
 * 这里多一条 `!highEmotion`：情绪高于阈值的条目即使淡了也留着 ——
 * 这正是「情绪越强忘得越慢」在归档层的体现，否则算法再对，
 * 归档逻辑会把它提前扫走。
 */
export function shouldArchive(row, cfg = {}, now = Date.now()) {
  if (!row) return false
  if (row.kind === 'fact' || row.pinned || row.hidden) return false
  if (Number(row.hits) > 0) return false                       // 被想起过就留着
  const guard = numOr(cfg.emotionArchiveGuard, 0.6)
  if (clamp01(row.emo) >= guard) return false                  // 强情绪留档
  return aliveness(row, cfg, now) < numOr(cfg.archiveBelow, 0.05)
}

// ───────────────────────── 解释性：给界面看「为什么」 ─────────────────────────

/**
 * 一条记忆的衰减剖面，设置页用它解释「为什么这条还在 / 为什么淡了」。
 * 不参与任何计算，纯只读。
 */
export function decayProfile(row, cfg = {}, now = Date.now()) {
  const anchor = Number(row && row.last) || Number(row && row.t) || now
  const days = Math.max(0, (now - anchor) / DAY)
  const half = row && row.kind === 'fact' ? Infinity : effectiveHalfLife(row, cfg)
  return {
    days: round(days, 2),
    halfLifeDays: half === Infinity ? null : round(half, 2),
    baseDays: round(Math.max(0.5, numOr(cfg.halfLifeEventDays, 30)), 2),
    emotionMultiplier: round(emotionHalfLifeMultiplier(row && row.emo, cfg), 3),
    aliveness: round(aliveness(row, cfg, now), 4),
    // 完全淡到归档线还要几天（Infinity → null，表示不会自然淡忘）
    daysUntilForgotten: half === Infinity ? null
      : round(Math.max(0, half * Math.log2(1 / Math.max(1e-9, numOr(cfg.archiveBelow, 0.05))) - days), 1),
  }
}

// ───────────────────────── 小工具 ─────────────────────────

function clamp01(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function numOr(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function round(v, digits) {
  const p = Math.pow(10, digits)
  return Math.round(v * p) / p
}

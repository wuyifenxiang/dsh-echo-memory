// 衰减内核的「可视化前端」：给定参数，采样出一条保留率曲线。
//
// 为什么单独放：设置页要画图，但设置页只有一个 HTTP 接口，
// 不该为了画图去翻整个记忆库（空库时也应该能看见参数的效果）。
// 这里纯函数、给定 cfg 就能出图。

import { effectiveHalfLife, aliveness, DAY } from './decay.js'

const DEFAULT_SAMPLE_EMOS = [0, 0.3, 0.6, 1]

/**
 * 采样保留率曲线。
 *
 * @param cfg    同 DEFAULTS
 * @param opts.days      横轴总天数，默认 120
 * @param opts.points    采样点数，默认 25
 * @param opts.emos      要画的几条线，默认 [0, 0.3, 0.6, 1]
 * @returns { days, series: [{ emo, halfLifeDays, points: [{ day, retention }] }] }
 */
export function retentionCurves(rawCfg = {}, opts = {}) {
  // 设置页可能在配置还没读到时先请求一次；null/undefined 当空对象处理
  const cfg = (rawCfg && typeof rawCfg === 'object') ? rawCfg : {}
  const totalDays = clampNum(opts.days, 120, 1, 3650)
  const points = Math.round(clampNum(opts.points, 25, 2, 500))
  const emos = Array.isArray(opts.emos) && opts.emos.length
    ? opts.emos.map((e) => clampNum(e, 0, 0, 1)).slice(0, 8)
    : DEFAULT_SAMPLE_EMOS

  const now = Date.now()
  const days = []
  for (let i = 0; i < points; i++) {
    days.push(round((totalDays * i) / (points - 1), 2))
  }

  const series = emos.map((emo) => {
    const row = { kind: 'event', emo, last: now, t: now, imp: 0.5 }
    const half = effectiveHalfLife(row, cfg)
    const pts = days.map((d) => ({
      day: d,
      // 直接复用真实内核，不另写一份公式 —— 图画的和跑的不是一个算法就没意义了
      retention: round(aliveness({ ...row, last: now - d * DAY }, cfg, now), 4),
    }))
    return {
      emo,
      halfLifeDays: round(half, 2),
      // 曲线穿过 0.05（默认归档线）的那一天
      forgetsAtDay: round(half * Math.log2(1 / clampNum(cfg.archiveBelow, 0.05, 1e-6, 1)), 1),
      points: pts,
    }
  })

  return {
    days,
    totalDays,
    baseHalfLifeDays: round(Number(cfg.halfLifeEventDays) || 30, 2),
    archiveBelow: clampNum(cfg.archiveBelow, 0.05, 1e-6, 1),
    series,
  }
}

function clampNum(v, fallback, min, max) {
  const n = Number(v)
  const base = Number.isFinite(n) ? n : fallback
  return base < min ? min : base > max ? max : base
}

function round(v, digits) {
  const p = Math.pow(10, digits)
  return Math.round(v * p) / p
}

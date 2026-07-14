// DESIGN.md 對比鐵律的可執行版。所有 theme（含 default）都要全綠。
// 用法：node scripts/check-theme-contrast.mjs   （任何一對不及格 → exit 1）
import { THEMES, mergedTokens } from '../pipeline/themes.mjs'

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// [前景, 背景, 最低比值, 說明] — 來源：DESIGN.md「對比鐵律」與現役用法。
const PAIRS = (t) => [
  [t.ink, t.paper, 4.5, 'ink on paper'],
  [t.muted, t.paper, 4.5, 'muted on paper'],
  [t['ink-soft'], t.paper, 4.5, 'ink-soft on paper'],
  [t['rail-deep'], t.paper, 4.5, 'rail-deep on paper'],
  [t['rail-deep'], t['paper-bright'], 4.5, 'rail-deep on paper-bright'],
  [t.stamp, t.paper, 4.5, 'stamp on paper (判子)'],
  [t.stamp, t['paper-bright'], 4.5, 'stamp on paper-bright (判子)'],
  ['#ffffff', t['rail-press'], 4.5, 'CTA white on rail-press'],
  [t.gold, t.night, 4.5, 'gold on night (eyebrow)'],
  [t['paper-bright'], t.night, 4.5, 'paper-bright on night'],
  [t['paper-dim'], t.night, 4.5, 'paper-dim on night'],
  [t['paper-faint'], t.night, 4.5, 'paper-faint on night'],
  [t['paper-ghost'], t.night, 4.5, 'paper-ghost on night (weak data)'],
]

let failed = 0
for (const name of Object.keys(THEMES)) {
  const t = mergedTokens(name)
  console.log(`\n=== theme: ${name} ===`)
  for (const [fg, bg, min, label] of PAIRS(t)) {
    const r = ratio(fg, bg)
    const ok = r >= min
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${r.toFixed(2)} (need ≥${min})  ${fg} on ${bg}`)
  }
}
process.exit(failed ? 1 : 0)

// fs-writing wrapper around render.mjs's portable buildItineraryFiles — kept
// in its own file so render.mjs itself has zero node: imports and stays
// Worker-safe (mirrors the agents.mjs / agents-local.mjs split).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildItineraryFiles } from './render.mjs'

export async function renderItinerary(itinerary, { outDir, customTokens, customMotifs }) {
  const tripId = itinerary.trip_id || 'trip_unknown'
  // 記念票畫版：data/posters/<trip_id>.png 存在才渲染（檔案是觸發器，欄位只是紀錄）。
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const posterSrc = path.join(packageRoot, 'data', 'posters', `${tripId}.png`)
  const hasPoster = fs.existsSync(posterSrc)

  const { pages, files } = await buildItineraryFiles(itinerary, { customTokens, customMotifs, hasPoster })

  // 只清掉本層舊的 .html（保留子目錄——dist 根同時承載 trips/<slug>/ 票夾）。
  fs.mkdirSync(outDir, { recursive: true })
  // 海報上票：檔案存在才複製為 poster.png（沿用上面既有的 outDir mkdir，不重複邏輯）。
  // 反向：海報被移除後重印時，清掉本層殘留的舊 poster.png，避免封面雖無 has-poster
  // 卻留一張孤兒圖（也讓 PWA precache 清單與實體檔一致）。
  const outPoster = path.join(outDir, 'poster.png')
  if (hasPoster) fs.copyFileSync(posterSrc, outPoster)
  else fs.rmSync(outPoster, { force: true })
  for (const entry of fs.readdirSync(outDir)) {
    if (entry.endsWith('.html')) fs.rmSync(path.join(outDir, entry), { force: true })
  }
  for (const [name, body] of files) fs.writeFileSync(path.join(outDir, name), body)

  return {
    artifact_type: 'interactive_itinerary',
    trip_id: tripId,
    html_path: path.join(outDir, 'index.html'),
    pages,
    slug: itinerary.slug,
    preview_status: 'ready',
  }
}

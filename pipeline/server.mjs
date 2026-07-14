#!/usr/bin/env node
// Trip Ticket Studio — local web entry point for the pipeline.
//   node pipeline/server.mjs [port]
// GET  /            input page (paste a one-sentence trip request)
// POST /api/plan    { sentence, mock? } → spawns the orchestrator
// POST /api/deploy  spawns `wrangler deploy`（deployment_status: awaiting_approval —— 按了才跑）
// GET  /api/status  live pipeline state (polled by the input page)
// GET  /trip/*      serves the generated site in dist/
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')
const distDir = path.join(packageRoot, 'dist')
const port = Number(process.argv[2] || process.env.PORT || 4747)

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }

const state = {
  phase: 'idle', // idle | running | done | error
  sentence: '',
  startedAt: null,
  finishedAt: null,
  log: [],
  agents: {},
  manifest: null,
  error: null,
}

const AGENT_LINE = /^\[orchestrator\] (.+?(?:Agent|Composer)): (completed|failed|timeout|skipped)/

// 部署狀態（誠實流程：manifest 印 deployment_status: awaiting_approval，
// 只有使用者按了「部署」、這裡才真的 spawn wrangler）。
const deploy = {
  phase: 'idle', // idle | running | done | error
  startedAt: null,
  finishedAt: null,
  log: [],
  error: null,
  url: null,
}

const dlog = (line) => {
  deploy.log.push(line)
  if (deploy.log.length > 200) deploy.log.splice(0, deploy.log.length - 200)
}

function startDeploy() {
  Object.assign(deploy, { phase: 'running', startedAt: Date.now(), finishedAt: null, log: [], error: null, url: null })
  // 優先用專案自己的 wrangler（devDependencies 有裝），沒有再試 PATH。
  const localBin = path.join(packageRoot, 'node_modules', '.bin', 'wrangler')
  const bin = fs.existsSync(localBin) ? localBin : 'wrangler'
  dlog('[deploy] wrangler deploy --config wrangler.itinerary.toml')
  const child = spawn(bin, ['deploy', '--config', 'wrangler.itinerary.toml'], { cwd: packageRoot })
  let tail = ''
  const onData = (d) => {
    // wrangler 非 TTY 也吐 ANSI 色碼，進 logbox 會變亂碼——剝掉，錯誤才讀得懂。
    const plain = String(d).replace(/\x1b\[[0-9;]*m/g, '')
    tail = (tail + plain).slice(-4000)
    for (const line of plain.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) dlog(`[deploy] ${trimmed}`)
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  child.on('close', (code) => {
    if (deploy.phase !== 'running') return // spawn error 已經收尾過
    deploy.finishedAt = Date.now()
    if (code === 0) {
      deploy.phase = 'done'
      deploy.url = tail.match(/https:\/\/\S+\.workers\.dev\S*/)?.[0] ?? null
      if (state.manifest) state.manifest.deployment_status = 'deployed'
      dlog(`[deploy] 部署完成${deploy.url ? ` → ${deploy.url}` : ''}`)
    } else {
      deploy.phase = 'error'
      const lastLines = tail.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' / ')
      deploy.error = `wrangler exited ${code}：${lastLines || '沒有輸出——先在終端跑 npx wrangler login，或用 npm run deploy 看完整錯誤'}`
      dlog(`[deploy] 部署失敗：${deploy.error}`)
    }
  })
  child.on('error', (err) => {
    deploy.phase = 'error'
    deploy.finishedAt = Date.now()
    deploy.error = err.code === 'ENOENT'
      ? 'wrangler 不存在——先 npm install（devDependencies 已列 wrangler）或全域安裝，再按一次「部署」'
      : err.message
    dlog(`[deploy] 部署失敗：${deploy.error}`)
  })
}

function startRun(sentence, mock) {
  Object.assign(state, {
    phase: 'running', sentence, startedAt: Date.now(), finishedAt: null,
    log: [], agents: {}, manifest: null, error: null,
  })
  const args = [path.join(here, 'orchestrator.mjs')]
  if (mock) args.push('--mock')
  if (sentence) args.push(sentence)
  const child = spawn(process.execPath, args, { cwd: packageRoot })
  let stdout = ''
  let stderrTail = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d).slice(-4000)
    for (const line of String(d).split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      state.log.push(trimmed.replace(/^\[orchestrator\]\s*/, ''))
      if (state.log.length > 500) state.log.splice(0, state.log.length - 500)
      const match = trimmed.match(AGENT_LINE)
      if (match) state.agents[match[1]] = match[2]
    }
  })
  child.on('close', (code) => {
    state.finishedAt = Date.now()
    if (code === 0) {
      try { state.manifest = JSON.parse(stdout) } catch { state.manifest = null }
      state.phase = 'done'
    } else {
      state.phase = 'error'
      state.error = `orchestrator exited ${code}: ${stderrTail.split('\n').slice(-4).join(' / ')}`
    }
  })
  child.on('error', (err) => {
    state.phase = 'error'
    state.error = err.message
    state.finishedAt = Date.now()
  })
}

const tripSummary = (j) => ({
  destination: j.destination,
  days: j.days?.length ?? 0,
  trip_id: j.trip_id,
  pages: ['index.html', ...(j.days ?? []).map((d) => `day-${d.date}.html`)],
})

function currentTrip() {
  try {
    return tripSummary(JSON.parse(fs.readFileSync(path.join(packageRoot, 'data', 'final_itinerary.json'), 'utf8')))
  } catch {
    return null
  }
}

// 票夾：data/trips/*.json → 摘要列表（trip_id 內含時間戳，新的排前面）。
function allTrips() {
  const dir = path.join(packageRoot, 'data', 'trips')
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
          return { ...tripSummary(j), dir: f.replace(/\.json$/, '') }
        } catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.trip_id).localeCompare(String(a.trip_id)))
  } catch {
    return []
  }
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type })
  res.end(type === 'application/json' ? JSON.stringify(body) : body)
}

// 畸形 percent-encoding（%zz、結尾 %）會讓 decodeURIComponent 丟 URIError，
// handler 沒接住就是整個 server 陣亡——decode 失敗回 null 由呼叫端 404。
const safeDecode = (text) => { try { return decodeURIComponent(text) } catch { return null } }
// CSRF 防護：跨站的 simple POST（<form>／bodyless fetch，無 preflight）一定帶 Origin——
// 不是本機 studio 的一律 403，否則任意網頁能替使用者按「部署」，繞過 awaiting_approval 誠實流程。
// 沒帶 Origin 的（curl、同源導航）放行。
const originOk = (req) => {
  const origin = req.headers.origin
  return !origin || origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`
}
// prefix-match traversal 防護：/trips/../trips-evil 會過 startsWith(base)，必須帶分隔符比對。
const insideDir = (file, base) => file === base || file.startsWith(base + path.sep)

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`)

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return send(res, 200, fs.readFileSync(path.join(here, 'studio.html')), TYPES['.html'])
  }

  if (url.pathname === '/api/status') {
    return send(res, 200, { ...state, elapsed_ms: state.startedAt ? (state.finishedAt ?? Date.now()) - state.startedAt : 0, trip: currentTrip(), trips: allTrips(), deploy })
  }

  if (url.pathname === '/api/plan' && req.method === 'POST') {
    if (!originOk(req)) return send(res, 403, { error: 'cross-origin request rejected' })
    if (state.phase === 'running') return send(res, 409, { error: 'a run is already in progress' })
    // 反向互斥（/api/deploy 已擋 pipeline running）：wrangler 正在讀 dist 上傳，
    // 這時重寫 dist 會部署出新舊混雜的站。
    if (deploy.phase === 'running') return send(res, 409, { error: '部署還在跑——等 wrangler 完成再出票' })
    let body = ''
    let tooBig = false
    req.on('data', (d) => {
      body += d
      if (body.length > 64 * 1024 && !tooBig) { // 一句話需求用不到 64KB——超過就是異常流量
        tooBig = true
        send(res, 413, { error: 'body too large' })
        req.destroy()
      }
    })
    req.on('end', () => {
      if (tooBig) return
      try {
        const { sentence, mock } = JSON.parse(body || '{}')
        if (!sentence && !mock) return send(res, 400, { error: 'sentence is required' })
        startRun((sentence || '').trim(), Boolean(mock))
        send(res, 202, { ok: true })
      } catch (err) {
        send(res, 400, { error: err.message })
      }
    })
    return
  }

  if (url.pathname === '/api/deploy' && req.method === 'POST') {
    if (!originOk(req)) return send(res, 403, { error: 'cross-origin request rejected' })
    if (deploy.phase === 'running') return send(res, 409, { error: '部署已經在跑了——看 logbox 的進度' })
    if (state.phase === 'running') return send(res, 409, { error: 'pipeline 還在出票——等手冊完成再部署' })
    if (!fs.existsSync(path.join(distDir, 'index.html'))) return send(res, 409, { error: '還沒有手冊可以部署——先出一張票' })
    startDeploy()
    return send(res, 202, { ok: true })
  }

  if (url.pathname === '/trip' || url.pathname === '/trip/') {
    const file = path.join(distDir, 'index.html')
    if (!fs.existsSync(file)) return send(res, 404, '還沒有產生任何行程 — 回 <a href="/">入口</a> 出一張票。', TYPES['.html'])
    return send(res, 200, fs.readFileSync(file), TYPES['.html'])
  }
  if (url.pathname.startsWith('/trip/')) {
    const rel = safeDecode(url.pathname.slice('/trip/'.length))
    const file = rel === null ? null : path.resolve(distDir, rel)
    if (!file || !insideDir(file, distDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'not found', 'text/plain')
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] ?? 'application/octet-stream')
  }

  // 票夾裡的每份手冊：/trips/<dir>/ 與 /trips/<dir>/day-*.html
  if (url.pathname === '/trips' || url.pathname === '/trips/') {
    res.writeHead(302, { location: '/' })
    return res.end()
  }
  if (url.pathname.startsWith('/trips/')) {
    let rel = safeDecode(url.pathname.slice('/trips/'.length))
    if (rel === null) return send(res, 404, '這個網址壞掉了 — 回 <a href="/">入口</a> 從票夾重新點。', TYPES['.html'])
    if (rel.endsWith('/')) rel += 'index.html'
    if (!rel.includes('/')) rel += '/index.html'
    const base = path.join(distDir, 'trips')
    const file = path.resolve(base, rel)
    if (!insideDir(file, base) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return send(res, 404, '這本手冊不在票夾裡了（可能被重新產出蓋掉）— 回 <a href="/">入口</a> 看現有的票。', TYPES['.html'])
    }
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] ?? 'application/octet-stream')
  }

  send(res, 404, 'not found', 'text/plain')
  // 只綁 loopback：這是本機 studio，不是給區網用的——0.0.0.0 會讓鄰居能打 /api/deploy。
}).listen(port, '127.0.0.1', () => {
  console.log(`Trip Ticket Studio → http://localhost:${port}`)
})

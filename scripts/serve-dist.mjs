// Tiny static server for previewing dist/ locally: node scripts/serve-dist.mjs [port]
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const port = Number(process.argv[2] || 8899)
const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' }

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1)
  const file = path.resolve(root, rel)
  if (!file.startsWith(root) || !fs.existsSync(file)) {
    res.writeHead(404).end('not found')
    return
  }
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' })
  res.end(fs.readFileSync(file))
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`))

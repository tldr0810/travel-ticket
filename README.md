# Trip Ticket Pipeline — 一句話變旅遊手冊

線上版（瑞士 demo）：https://switzerland-itinerary-2026.zack-chen.workers.dev

## 這是什麼
一個 multi-agent pipeline：輸入一句話的旅遊需求，經過多個 agent 協作，
產出票券風格的互動行程網站（可部署到 Cloudflare Workers）。

```
一句話 ─▶ Trip Brief Agent (LLM, structured output)
              ├─ Timezone Agent        (純程式，Intl 計算時差/DST)
              ├─ Local Discovery Agent (LLM + web search，官方來源)
              ├─ Travel Context Agent  (Gmail via Composio MCP，無 key 自動 skip)
              ├─ Calendar Agent        (Google Calendar via Composio MCP，無 key 自動 skip)
              └─ Notion Agent          (Notion via Composio MCP，無 key 自動 skip)
          Itinerary Composer Agent (LLM) ─▶ final_itinerary.json ─▶ dist/ 網站
```

每個 agent 都在 orchestrator 的監督下執行（timeout、狀態、confidence 都會
記錄進最終產物的 `agent_statuses`）。Composer 失敗或逾時時，orchestrator
會用本地 fallback composer 硬湊出可渲染的行程（跟瑞士 demo 當初的行為一樣）。

## 怎麼跑

### 入口網頁（推薦）

```bash
npm run studio   # → http://localhost:4747
```

開瀏覽器貼上一句話 → 按「出票」→ 即時看每個 agent 的進度 →
完成後自動出現「打開手冊」，封面在 `/trip/`、每日分頁在 `/trip/day-*.html`。
入口右下角隨時列出最新一份手冊的 Cover / Day 快速連結。

### 指令列

```bash
npm install

# 真實跑 — 不需要 API key：沒有 ANTHROPIC_API_KEY 時會自動改用
# headless `claude -p`（走你 Claude Code 的登入 / 訂閱額度）
npm run plan -- "十月中帶另一半從台北去京都四天，賞楓吃和食，步調放鬆"

# 測試 pipeline 管線（完全不打 LLM，用固定假資料）
npm run plan:mock

# 重新產生瑞士 demo（純資料，不打 LLM）
npm run demo

# 只重新渲染最新一份行程（改了 render.mjs 設計之後用）
node pipeline/orchestrator.mjs --render-only

# 只重印票夾裡指定那份（slug 前綴即可）
node pipeline/orchestrator.mjs --render-only --trip=kyoto
```

### 票夾（多份手冊共存）

- 每次產出：最新一份印在 `dist/` 根（部署相容），同時收進
  `dist/trips/<slug-id>/`＋`data/trips/<slug-id>.json`。
- Studio 首頁右下 **Ticket Wallet** 列出歷史手冊（`/trips/<slug-id>/`）。
- 日票有 Relaxed/Full 深連結（`?mode=full`）、撕票翻頁（View Transitions＋
  手機左右滑）、行程蓋章（郵戳＋時刻，localStorage 僅本機）。

LLM backend 自動選擇（也可用 `--backend=sdk|cli` 強制指定）：
1. `sdk` — 有 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 時走 Anthropic API
   （`claude-opus-4-8` + 真正的 structured outputs）。
2. `cli` — 否則 fallback 到 headless `claude -p`（Claude Code 登入，訂閱額度計費；
   模型跟隨 Claude Code 預設，可用環境變數 `PIPELINE_CLAUDE_MODEL` 覆寫）。

實測（cli backend）：一句話 → 完整京都四天行程約 6 分鐘
（Brief ~18s、Discovery 含 web search ~150s、Composer ~170s）。

產出：
- `.trip_work/final_itinerary.json`、`data/final_itinerary.json` — 結構化行程
- `dist/index.html` + `dist/day-*.html` — 互動網站，瀏覽器直接開即可預覽

## 檔案結構

| 路徑 | 說明 |
|---|---|
| `DESIGN.md` | 設計語言（tokens、字體角色、元件語彙、無障礙底線）——改前端先讀這份 |
| `pipeline/server.mjs` + `pipeline/studio.html` | 入口網頁（Studio）：貼一句話出票、看 agent 進度、瀏覽產出手冊 |
| `pipeline/orchestrator.mjs` | 派工、timeout 監督、fallback、組裝 JSON、觸發渲染 |
| `pipeline/agents.mjs` | 各 agent 實作（Claude API `claude-opus-4-8`、structured outputs、web search）＋時區工具 |
| `pipeline/render.mjs` | 通用渲染器：任意 `final_itinerary` JSON → 票券風格網站（單一真實來源） |
| `scripts/generate-itinerary-preview.mjs` | 瑞士 demo 的行程資料，渲染走 `pipeline/render.mjs` |
| `scripts/serve-dist.mjs` | 本地預覽 dist 的小型靜態 server |
| `src/itinerary-worker.ts` + `wrangler.itinerary.toml` | Cloudflare Workers 部署（assets = dist/） |

## final_itinerary JSON 重點欄位
- `days[].items[]`：`start_utc`/`end_utc`（UTC-first）＋ `timezone`、`variant`（both/relaxed/full）、`sources`
- `agent_statuses`：每個 agent 的 status/confidence/notes（誠實記錄 skipped/failed/timeout）
- `cover`：封面文案（標題、eyebrow、route stops、stats）——Composer 產生，渲染器也能自行推導
- `actions_suggested`：後續動作（訂票確認、寫入 Calendar 等），全部 `requires_approval: true`

## Connectors (Composio)

`pipeline/agents.mjs` 裡的 `runTravelContextAgent`（Gmail）、`runCalendarAgent`
（Google Calendar）、`runNotionAgent`（Notion）都走 Composio 的 dynamic-tools
MCP server（`pipeline/composio.mjs`），把使用者自己的信箱/日曆/Notion 內容
讀進來輔助 Composer；沒有帳號授權也完全不影響出票，只是那個 agent 會誠實
回報 `skipped`。

- **拿 key**：Composio dashboard 的 MCP 頁面（key 會輪替，dashboard 才是唯一
  真實來源，不要把 key 寫死在別的地方）。
- **設定**：加進 `~/.zshrc`（或你的 shell rc）：
  ```bash
  export COMPOSIO_API_KEY="ck_..."
  ```
  設定完記得開新的 shell（或 `source ~/.zshrc`）讓 `npm run plan` / studio 讀到。
- **沒有 key 時**：三個 connector agent 全部自動降級成 `skipped`（`bookings`/
  `events`/`travel_notes` 都是空陣列），出票流程照跑，不會因此失敗。
- **這是單人工具**：每個人用自己的 Composio key，帳號授權（Gmail/Calendar/
  Notion）也是各自在 Composio dashboard 上連的，彼此不共用。
- **Smoke test**（打真的 Composio + 真的 LLM，不算進 `npm test`）：
  ```bash
  COMPOSIO_API_KEY="$(sed -n 's/^export COMPOSIO_API_KEY="\(.*\)"/\1/p' ~/.zshrc)" npm run composio:smoke
  ```
  輸出範例（gmail/calendar 已連線、notion 未連線）：
  ```
  gmail: status=ok items=0 (2.6s) — No booking-looking emails found in the last 180 days.
  calendar: status=ok items=1 (3.6s) — Found 1 calendar event(s) inside the trip window.
  notion: status=skipped items=0 (2.5s) — Notion check skipped: COMPOSIO_MULTI_EXECUTE_TOOL: 1 out of 1 tools failed
  ```

## Use as an MCP server

`pipeline/mcp-server.mjs`（`npm run mcp`）把整套 pipeline 包成一個 zero-dep
stdio MCP server，讓 Claude Code / Claude Desktop 之類的 MCP client 直接呼叫，
不用另外開 studio 網頁或打指令列。

**Prerequisites**
- Node 22+
- `ANTHROPIC_API_KEY`（或已登入的 `claude` CLI，走 headless `claude -p` fallback）
- 選用：`COMPOSIO_API_KEY`，讓 Gmail/Calendar/Notion context agent 生效
  （沒設也完全能跑，那三個 agent 會誠實回報 `skipped`）

**兩段式呼叫流程**
1. `plan_trip {"sentence": "..."}` — 跑完 Trip Brief / Discovery / Composer 等
   agent，回傳 `plan_id`、行程摘要、`design_options`（可選的票券設計清單）。
2. 把 `design_options` 呈現給使用者，等使用者選一個設計。
3. `render_ticket {"plan_id": "...", "design": "<選的設計名稱>"}` —
   （`design` 可以是某個 preset 名稱、`custom:<風格描述>`，或整個省略走推薦選項）
   渲染出票券網站，回傳 `entry`（`.../dist/trips/<trip_dir>/index.html`）等路徑。

**Client 設定範例**（把路徑換成你自己 clone 這個 repo 的絕對路徑）：
```json
{
  "mcpServers": {
    "trip-ticket": {
      "command": "node",
      "args": ["/Users/zack/Desktop/travel ticket/switzerland-itinerary-package/pipeline/mcp-server.mjs"],
      "env": { "COMPOSIO_API_KEY": "ck_..." }
    }
  }
}
```
（`env.COMPOSIO_API_KEY` 是選用的；`/Users/zack/.../switzerland-itinerary-package/...`
是本機範例路徑，請換成你自己這份 repo 實際的絕對路徑。）

**注意事項**
- `plan_trip` 可能跑好幾分鐘（LLM + web search 都在裡面），client 端請不要設太
  激進的 timeout，也不用等它逾時失敗才重試。
- 一切都誠實降級：沒有任何 key 時，Gmail/Calendar/Notion 三個 connector agent
  自動 `skipped`，出票流程照跑；想完全不打 LLM 測試協定，可以用
  `plan_trip {"sentence": "", "mock": true}`。

## 部署
```bash
npx wrangler deploy --config wrangler.itinerary.toml
```

## 還沒接的東西
- **自動部署**：orchestrator 產出後停在 `deployment_status: awaiting_approval`，
  部署仍是手動指令。

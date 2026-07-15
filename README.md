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

`pipeline/composio.mjs` 使用官方 `@composio/core` 的 direct execution API；每個
讀取請求都帶一個穩定的 `userId`，所以 Gmail、Google Calendar、Notion 的 connected
accounts 依訪客隔離。它不再使用舊的共用 Composio MCP endpoint，也絕不回退讀取
server owner 的帳號。

- `COMPOSIO_API_KEY` 是 server owner 的 Composio project key，只用來代表這個
  專案呼叫 Composio API；它不是任何訪客的 Google/Notion credential，也不能提交進 repo。
- 在 dashboard 建立三個 **read-only** auth config 後，將其 ID 設為
  `COMPOSIO_GMAIL_AUTH_CONFIG_ID`、`COMPOSIO_CALENDAR_AUTH_CONFIG_ID`、
  `COMPOSIO_NOTION_AUTH_CONFIG_ID`。MCP 的 Connect Link 工具只走
  `connectedAccounts.link()`；不使用已於 2026-07-03 對 managed OAuth 停用的
  `initiate()`。
- 沒有 connector account 時，讀取工具回傳 `not_connected` 和「先建立 Connect Link」
  的訊息；沒有 Composio project key 或 auth config 時，會誠實回報
  `configuration_required`。
- 傳統 CLI pipeline 若要讀 connector，必須另外明確設定 `COMPOSIO_USER_ID`；沒有
  它就只會 skip，避免隱式使用任何「預設」帳號。

## Use as an MCP server

`pipeline/mcp-server.mjs`（`npm run mcp`）是 stdio MCP server。它**不會呼叫
Anthropic、Claude CLI、web search 或任何 LLM**：連進來的 Claude Code、Claude Desktop、
Codex CLI、Manyfold 等 MCP client 自己理解使用者需求、查資料、組出 JSON，並以該
client 自己的模型 session / 訂閱承擔推理成本。

**Prerequisites**
- Node 22+
- 不需要 `ANTHROPIC_API_KEY`，也不需要登入 `claude` CLI。
- 選用：server owner 設定 `COMPOSIO_API_KEY` 和三個 read-only auth config ID，才會啟用
  個人 Gmail/Calendar/Notion context；沒有設定時，其他 schema、timezone、render 工具仍可用。

**MCP tools**
- `get_itinerary_schema`：回傳 `final_itinerary` JSON schema 與完整範例。
- `fetch_travel_context`：用明確提供的 IANA timezone 與日期計算時差、DST、body clock。
- `create_visitor_id`：建立客戶端必須自行保存的穩定 visitor ID。
- `create_connector_link`：為一個 visitor 與 Gmail、Calendar 或 Notion 建立 OAuth Connect Link。
- `get_connector_status`：檢查該 visitor 是否已連上指定 connector。
- `fetch_gmail_context`：回傳該 visitor 的訂位相關 email 原始文字，不做 LLM 摘要。
- `fetch_calendar_context`：回傳該 visitor 日期區間內的 Calendar events 原始資料。
- `fetch_notion_context`：回傳該 visitor 最多三頁 Notion markdown 原始資料。
- `render_ticket`：將 client-composed JSON 渲染成票券網站；只接受 preset 或 client 提供、經 contrast gate 的 custom tokens。

**典型流程**
1. Client 先呼叫 `get_itinerary_schema`，再自行理解需求、搜尋當地資料。
2. 需要私有 context 時，呼叫 `create_visitor_id`，將回傳的 `visitor_id` 保存在自己的
   MCP client/session 裡；呼叫 `create_connector_link`，讓使用者在瀏覽器開啟
   `authorization_url` 並完成 Google/Notion consent。
3. 使用同一個 `visitor_id` 呼叫 context tools。未連帳號只會收到 `not_connected`，
   不可能取得別人的內容。
4. Client 組合 itinerary JSON 後呼叫 `render_ticket`，取得本機 `entry` 路徑。

stdio MCP 沒有 browser cookie 或登入使用者 identity 可讀，所以 server 無法自行替
client 生成可跨重啟的身份；client 必須保存 `visitor_id`。未來若將同一層接到 HTTP
Studio，可用其 authenticated session/cookie 作為這個穩定 ID 的來源。

**Client 設定範例**（把路徑換成你自己 clone 這個 repo 的絕對路徑）：
```json
{
  "mcpServers": {
    "trip-ticket": {
      "command": "node",
      "args": ["/Users/zack/Desktop/travel ticket/switzerland-itinerary-package/pipeline/mcp-server.mjs"],
      "env": {
        "COMPOSIO_API_KEY": "ck_project_key",
        "COMPOSIO_GMAIL_AUTH_CONFIG_ID": "ac_readonly_gmail",
        "COMPOSIO_CALENDAR_AUTH_CONFIG_ID": "ac_readonly_calendar",
        "COMPOSIO_NOTION_AUTH_CONFIG_ID": "ac_readonly_notion"
      }
    }
  }
}
```
（Composio env 全部選用；這些值只屬於 host server，絕不能放進 repo。`/Users/zack/...`
是本機範例路徑，請換成你自己這份 repo 實際的絕對路徑。）

**注意事項**
- `render_ticket` 不產生 poster；MCP 模式保留圖片生成的誠實 skip，不會呼叫本機
  Codex CLI 或 Gemini API。
- Connector 目前只提供 read-only context，且 Gmail/Notion 內容有大小上限，避免把
  整個帳號灌進模型 context。
- direct execution 暫時採 Composio 文件所述的 latest toolkit version 模式；toolkit
  schema/behavior 變動時，應重新驗證本 adapter 的 read-only tool slugs 與參數。

## 部署
```bash
npx wrangler deploy --config wrangler.itinerary.toml
```

## 還沒接的東西
- **自動部署**：orchestrator 產出後停在 `deployment_status: awaiting_approval`，
  部署仍是手動指令。

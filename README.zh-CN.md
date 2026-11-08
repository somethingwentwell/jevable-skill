# Jevable Skill

[English](README.md) | 中文

**描述工作流程，讓 Agent 做成可檢視、可測試、能獨立執行的 App。**

把重複處理的請求、審核與分流，變成有明確步驟、分支和人工審批的工作流。Agent 協助建立與修改；你檢視並測試後，由 Jevable 執行引擎負責運作，保留每次執行的結果。

- **先看清楚，再執行**。檢視流程圖、修改差異與測試結果；開啟預覽不會自動執行或批准。
- **需要人決定時，停下來等**。人工審批節點保留等待狀態與決策紀錄。
- **交付可執行的 App**。可匯出包含工作流與執行引擎的 ZIP，不只是 YAML 或圖表；匯出後不依賴原本的對話或 skill。
- **讓每種節點各司其職**。Rules 處理已知邏輯、Decision（Jev）提供型別化判斷、LLM 負責文字生成。

### 從不接模型的範例開始

[Request review 範例](examples/request-review.yaml) 展示兩條路徑：一般請求直接輸出；標記為需要審核的請求，停下等待人工批准。兩條路徑都不呼叫模型，也不寄送訊息或修改外部帳戶。

已取得並驗證可信 skill ZIP 的使用者，可依[安裝指南](references/skill-package.md)操作。此範例需要 Node.js 22.19+，不需要 Docker、`npm install` 或模型帳戶。目前尚無公開安裝／下載入口。

> 目前版本為 `0.1.0-alpha.1`，尚非正式生產環境版本。真實託管模型服務仍待驗證；自訂程式碼節點目前可驗證但不執行。AI 節點可能產生供應商費用。授權與散布條款尚未定案，公開原始碼不代表允許免費商用或自由再散布。

逐步指令、預期的結束碼，以及這個範例**沒有**展示的內容，請見 [Request review 操作手冊（英文）](docs/request-review-demo.md)。

## 快速開始 — 一句提示

以下內容摘要自[英文 README](README.md)；如有出入，以英文版與 [references/](references/skill-package.md) 中的指南為準。

把這段提示貼給你的 Agent（任何能使用 skill 並執行 Node.js 的 Agent）：

> 從 Jevable skill 的公開儲存庫安裝：clone https://github.com/somethingwentwell/jevable-skill，從該 checkout 把 skill 安裝到你核准的 skill 位置，再用這個 skill 執行內附的 echo 範例 — 不要 npm install、不要 Docker、不要模型帳戶。告訴我 run ID 與保留下來的結果。

Agent 會 clone 儲存庫、安裝 skill、執行範例，並回報**已保存的執行紀錄**。另一種方式是把同一個 skill 打包成經驗證的 ZIP 並檢查封存內容，詳見 [skill 封裝指南](references/skill-package.md)。

> **已知問題（`0.1.0-alpha.1`）**：在單純 clone 下來的 checkout 中，`node bin/jevable.mjs` 目前會因 `ERR_MODULE_NOT_FOUND`（例如找不到 `zod` 套件）而停止，因為 checkout 的 `dist/` 需要未隨儲存庫提交的執行期相依套件。「不需要 `npm install`」適用於匯出的 skill ZIP，其內附的 CLI 不需要 `node_modules` 即可執行。詳見[操作手冊](docs/request-review-demo.md#which-cli-to-use)。

### 試試真實的分支與審批等待 — 同樣一句提示

內附的 [Request review 工作流](examples/request-review.yaml) 有五個節點。Rule 讀取輸入中的 `needsReview` 布林值：`false` 的一般請求直接送到 Output；`true` 的請求停在 Human Approval（人工審批）。Rule 只讀這個布林值，不會偵測內容是否敏感。兩條路徑都不呼叫模型，也不修改任何帳戶。對你的 Agent 說：

> 使用 Jevable skill，把兩個內附的 request-review 輸入執行到同一個私有狀態目錄，然後給我看等待中的審批與它們的 run ID。不要批准。

第一次執行會完成，輸出 onboarding guide 那則訊息。第二次執行回報 **waiting**（結束碼 3），既不是成功也不是失敗：billing account 那則訊息尚未被處理。請保存回傳的 run ID；不要只為了跑完範例就批准請求。沒有沿用原本保留 ID 的執行，會建立一次新的執行。詳見[審批的安全與審核](references/approvals.md)。

範例輸入檔：

| 檔案 | 內容 | 預期結果 |
| --- | --- | --- |
| [`examples/request-review-routine-input.json`](examples/request-review-routine-input.json) | `needsReview: false` | `completed`，結束碼 0 |
| [`examples/request-review-sensitive-input.json`](examples/request-review-sensitive-input.json) | `needsReview: true` | `waiting`，結束碼 3 |

範例訊息只是文字：不會寄出任何指南或 email，也不會變更任何帳單帳戶。

## 在對話旁預覽與測試

可以請 Agent 開啟工作流的即時預覽，並且不執行任何東西。若 Agent 有可用且被允許的瀏覽器工具，可以把檢視器顯示在對話旁；否則會提供本機 URL。開啟預覽永遠不會執行或批准任何東西。只想要一個可攜、僅供檢視的檔案時，可以請 Agent 匯出工作流的預覽 HTML。詳見[可攜 HTML 預覽](references/preview.md)與[即時預覽](references/live-preview.md)（實驗性功能）。

## 目前能做什麼、還有哪些限制

`0.1.0-alpha.1` 是早期實作，不是正式生產版本。

- 已包含：編譯、範本、匯入轉換器、版本化專案、保留的執行與審批紀錄、已保存的測試、API 與匯出封裝。
- 自訂程式碼節點可驗證但不會執行。
- 真實託管模型服務尚未驗證；AI 節點需要你設定供應商，且可能產生費用。
- 瀏覽器驗收只涵蓋英文 README 中明確記錄的流程。
- 授權與散布條款尚未定案（`package.json` 標示為 `UNLICENSED`）。公開原始碼不代表允許免費商用或自由再散布。

依賴某項功能之前，請 Agent 回報這個安裝實際具備的範圍（`capabilities`）以及指令的實際語法（`help <command> --json`）。

更多內容 — Decision（Jev）、匯入 n8n／Dify 等工作流、匯出可執行 App、本機／Docker／Kubernetes 執行、追蹤與遙測 — 請見[英文 README](README.md)。

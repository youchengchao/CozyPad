# CozyPad 規格書

## 1. 產品概覽

### 1.1 產品定位

- CozyPad 連接本機／遠端，操作 Agent、Terminal、檔案、主機資源與研究流程，非 Agent 本身。
- Desktop 與 Mobile 提供相同功能與操作結果。
- 畫面排列可依螢幕空間調整。

### 1.2 主要功能

- Local／SSH Machine 切換。
- Claude Code、Codex、AGY Session 管理。
- Agent 對話、工具操作、Diff、Approval、Question、Usage、Error 顯示。
- SSH 中斷或 CozyPad 關閉後，遠端 Agent Process 持續執行。
- 互動式 Terminal。
- 檔案瀏覽、預覽、編輯、複製、移動、下載、刪除。
- CPU、GPU、RAM、Storage、GPU Process 監看。
- Study、Experiment、Run、Metric、Artifact、Chart、Export。
- 高風險操作確認。

### 1.3 不處理的範圍

- Agent 模型、推理、記憶、原生對話儲存。
- Agent 登入、API Key、Provider 帳號。
- 以 Terminal 畫面推測完整對話事件。
- 未確認的 SSH Trust、Project File、Research Control 變更。
- 遠端結果未查明前判定成功或失敗。
- 將任意 Shell Command 自動登記為 Research Run。
- 解除安裝時刪除 Project File、Download、Agent 原生資料。

### 1.4 Machine 模式

- **Local**：操作執行 CozyPad 的電腦；不顯示 SSH 登入與 Host Trust。
- **SSH**：使用 Connection Profile 連接遠端電腦。
- 同一時間只啟用一台 Machine。

### 1.5 名詞

- **Machine**：目前操作的本機或遠端電腦。
- **Connection Profile**：Host、Port、Username、驗證方式與顯示名稱。
- **Project**：綁定 Machine 與根目錄的工作範圍。
- **Current Working Directory**：新 Agent、Terminal、Research 工作的預設目錄。
- **Agent Session**：CozyPad 中的一段 Agent 對話。
- **Agent Process**：實際執行 Claude Code、Codex、AGY 的程序。
- **Agent Adapter**：處理各 Agent 的啟動、輸入、事件、Resume、Approval、權限模式差異。
- **Terminal Session**：一個獨立互動式 Shell。
- **Study**：研究問題與共用資料、Metric 定義。
- **Experiment**：Study 下的一版實驗計畫。
- **Run**：依固定設定執行的一次實驗。
- **Artifact**：Agent 或 Run 產生的檔案／具名輸出。
- **Attachment**：加入 Agent Turn 的圖片或檔案。

### 1.6 共通規則

- 同時只執行一個 CozyPad Instance；再次啟動喚回既有視窗。
- 切換 Workspace 不停止 Agent Process、Terminal Session、Research Run。
- 切換 Machine 前處理未保存內容，再斷線。
- 畫面持續顯示目前 Machine 與連線狀態。
- 上一台 Machine 的資料不得顯示成目前資料。
- Timeout／斷線後先查詢遠端狀態，再決定重試。
- 顯示名稱可改；ID 不隨名稱改變。
- 主要操作可用鍵盤、觸控、指標裝置完成。
- Focus 位置需可見。
- Dialog 開啟期間 Focus 限制在 Dialog 內；關閉後回到觸發元件。
- 每個控制項提供可辨識的 Accessible Name。
- 中文輸入法、Emoji、寬字元、Combining Character、貼上程式碼需正常顯示。
- 長 Timeline、Table、Diff、Log 使用分批載入或虛擬化。

### 1.7 Current `main` 實作快照（2026-08-10）

- 本節記錄目前程式狀態；其餘章節仍是產品要求。未達成的要求不得因本節而視為取消。
- Claude、Codex、AGY 已共用 ACP Timeline 與控制流程；Claude／Codex 使用已發布的 ACP wrapper，AGY 使用 CozyPad adapter。
- Local 與 SSH 共用 `NodeHostRuntime` 的 process／filesystem 核心；Local 直接呼叫，SSH 只橋接 request、stream 與 lifecycle event，實際操作在目標主機執行。
- Agent 回應已支援 GFM、KaTeX、Mermaid、安全的 `details`／`summary`／`sub`／`sup`、回應與 code block 複製，以及可展開的 Tool Card。
- Timeline 已保存的 normalized item 會在重開後重新 render；若舊記錄當時未保存完整 ACP event／內容，renderer 不得假造缺少的資料。
- Session 內由 Agent `configOptions` 回報的 Mode／Model 可透過 ACP 更新。
- 建立 Session 的 Launch mode 尚未全部與 Agent 實際 mode ID 對齊：Codex 目前只有 `read-only` 可可靠預先套用；未匹配的選擇會退回 Agent 預設值。此行為不符合 3.4.8 與 6.5 的最終要求。
- AGY print mode 固定回報 `always-proceed`，不送出 `session/request_permission`；workspace root 只表示搜尋起點，不是 sandbox boundary。
- Remote ACP Process 已在遠端主機啟動，但目前 host bridge 仍綁定現存 SSH channel；2.11 與 4.3 所要求的斷線續跑／重接尚未完整達成。

## 2. 使用情境

### 2.1 啟動

**啟動狀態**

- 啟動後一律為 Disconnected。
- 不自動選 Machine，也不自動 Connect。
- 不記憶上次連線的 Machine。
- 顯示 Machine 選擇器與可用 Profile；等待使用者選擇並 Connect。
- 不自動選取 Session；不自動開啟 Terminal Tab。

**首次啟動**

- 建立內建 Local Profile。
- Local 與已保存的 SSH Profile 並列；Local 同樣需要明確 Connect。

**連線後**

- Working Directory 取該 Machine 最近使用的一筆記錄。
- 該 Machine 尚無記錄：使用 Home。
- 記錄的目錄已不存在：使用 Home 並提示。

**例外**

- 本機資料庫、設定、憑證儲存無法讀取：顯示原因與處理方式。
- 不得清空資料後繼續啟動。
- 不得以空白畫面隱藏錯誤。

### 2.2 新增 SSH Profile 並連線

**入口**：Machine 選擇器 → 連線設定。

**Profile 欄位**

- 名稱。
- Host／IP。
- Port。
- Username。
- Password 或 Private Key。
- Private Key Passphrase。
- 保存憑證。

**保存規則**

- Host、Port、Username、驗證方式：一般連線資料。
- Password、Private Key、Passphrase：安全儲存；保存後不顯示原文。

**連線流程**

1. 保存 Profile。
2. Disconnect 目前 Machine。
3. 選取遠端 Profile。
4. Connect。
5. 首次連線顯示 Host、Port、Host Key Type、Fingerprint。
6. 確認後建立 SSH。
7. 檢查 Home、Shell、PTY、檔案傳輸、Agent 版本、遠端會話工具。
8. 顯示可用功能與限制。

**錯誤分類**

- Authentication。
- Host Trust。
- Transport。
- Remote Environment。

### 2.3 SSH Fingerprint 改變

**畫面內容**

- Profile、Host、Port、Username。
- 舊 Fingerprint。
- 新 Fingerprint。
- 主機重裝、更換、遭攔截風險。

**操作**

- 取消。
- 信任新 Fingerprint。

**規則**

- 關閉 Dialog、Timeout、未選擇：取消。
- 未確認前，不開啟 Terminal、Files、Agent、Remote Cleanup。

### 2.4 建立 Project

**入口**：Project 選擇器 → 新增。

**欄位**

- 名稱。
- Machine。
- 根目錄。
- 資料夾瀏覽。
- 完整路徑輸入。

**建立條件**

- 路徑存在。
- 可存取。
- 可取得解析後路徑。

**建立後**

- 新 Agent Session 使用 Current Working Directory。
- 新 Terminal Tab 從 Current Working Directory 開啟。
- Files 可從 Project Root 開始。
- 新 Study 綁定 Project。

**路徑失效**

- 保留 Project 記錄。
- 顯示路徑錯誤。
- 提供修改路徑、重新檢查、刪除記錄。
- 刪除記錄不刪實際目錄。

### 2.5 建立 Agent Session

**入口**：Claude／Codex／AGY → 新增 Session。

**建立畫面**

- Session 名稱；可留空。
- 工作目錄。
- 資料夾瀏覽。
- 建立。

**順序**

1. 預設工作目錄：目前 Project 的 Current Working Directory。
2. 驗證路徑。
3. 建立 Session 記錄。
4. 開啟對話頁。
5. 顯示權限模式。
6. 可先調整權限模式。
7. 送出第一個 Prompt。
8. 啟動或連接 Agent Process。
9. 取得 Agent 原生 Conversation ID。
10. Prompt 接受後顯示 User Message。

**規則**

- 建立畫面不顯示權限模式。
- 新 Session 使用安全預設模式。
- 建立按鈕防止重複提交。
- 啟動失敗：保留 Session；顯示錯誤與重試。
- 重試沿用同一 Session。
- 會公布 Conversation ID 的 Agent 未取得時：顯示 Starting。
- 不公布 Conversation ID 的 Agent：不因此停在 Starting。
- Title、PID、Process Name、tmux／smux Name 不得代替 Conversation ID。

### 2.6 調整 Agent 權限模式

**位置**：Session 對話頁，Composer 附近。

**顯示**

- 目前模式。
- Agent 實際支援的模式。
- 每個模式的影響。
- 高風險警示。

**模式分類**

- 安全預設模式：檔案寫入與命令執行仍需逐次 Approval。
- 高風險模式：略過 Approval，自動接受寫入或執行。
- 分類依 Agent 回報的模式行為判定；不依模式名稱。

**規則**

- 模式屬於目前 Session。
- 不影響其他 Session／Agent。
- 執行中的 Turn 沿用原模式。
- 新模式從下一個 Turn 生效。
- 已存在的 Approval 不自動通過。
- 切換失敗：保留原模式。
- 需要重啟 Agent Process：下一個 Turn 前完成；Session ID 不變。
- 重啟後的原生對話依 2.7 的 Resume 規則處理。
- 只能開新對話的 Agent：切換前告知會失去原生對話的延續。
- Resume 後重新確認該 Agent 仍支援保存的模式。
- 保存的模式已不受支援：回到安全預設模式並提示。

### 2.7 預覽舊 Session 與 Resume

**選取 Session**

- 顯示已保存 Timeline。
- 不啟動 Agent Process。
- 不連接遠端會話。
- Composer 停用。
- 不處理 Question／Approval。

**Resume**

- Process 仍在執行：重新連接；補回事件。
- Process 已結束、Agent 支援續接原生對話：啟動新 Process；沿用原生對話。
- Process 已結束、Agent 只能開新對話：啟動新 Process；建立新原生對話。
- Process 已結束、無法重新啟動：保留歷史；顯示無法繼續。
- 遠端狀態查不到：維持 Disconnected。

**原生對話更換**

- Session 綁定的 Native Conversation ID 可在 Resume 後更換；Session ID 不變。
- 不延續原生對話時：保留 CozyPad Timeline；Timeline 標出分界。
- 明確顯示 Agent 不記得分界之前的內容。
- 不得以 CozyPad Timeline 冒充 Agent 記憶。
- 無法確認是否為同一原生對話：明確告知。

**失敗**

- 歷史仍可閱讀。
- 重試沿用同一 Session。

### 2.8 傳送 Prompt 與附件

**加入方式**

- 附件按鈕。
- 貼上 Screenshot／Image。
- Files → 加入 Agent。

**送出前**

- 附件只留在本機 Buffer。
- 顯示於 Composer Attachment Tray。
- Image 顯示縮圖。
- File 顯示名稱、類型、大小、Buffered。
- 可預覽、移除、繼續加入。
- 每個 Session 保存自己的 Draft 與附件。

**送出流程**

1. 鎖定本次 Prompt 與附件。
2. 建立一個 Attachment Batch。
3. 傳到 Session 專用遠端目錄。
4. 解包與完整性檢查。
5. 全部 Ready 後交給 Agent Adapter。
6. 圖片使用 Agent 原生媒體輸入；一般檔案使用 Agent 可讀路徑或原生 Attachment Object。
7. Prompt 被接受後顯示 User Message。

**失敗**

- 任一附件失敗：Prompt 不送出；保留 Draft 與附件。
- 附件已落地、Prompt 失敗：重試沿用原 Attachment；不重傳。
- 送達結果不明：查詢遠端附件清單、Hash、Agent Event。

**送出後狀態**

- 已送出、尚未收到 Agent 第一個事件：顯示送出中；Composer 與 Send 停用。
- 收到第一個事件：視為送達；轉為 Running。
- 逾時仍無事件：轉為待確認。
- 送出中與待確認的指示與 User Message 分開；User Message 仍於 Prompt 被接受後才顯示。

**待確認**

- 查詢 Turn／Event 判定實際結果。
- 查得未接受：還原 Draft 與 Attachment Tray；Composer 恢復。
- 查得已接受：補回事件；轉為 Running。
- 查詢後仍不明：維持待確認；提供再次查詢與明確重送。
- 不自動重送。

**送出後**

- 附件顯示在對應 User Message。
- Image：縮圖＋大圖預覽。
- Text：有限長度預覽。
- 其他格式：檔案資料＋可用操作。

### 2.9 Agent Approval

**Approval Card**

- Machine。
- 工作目錄。
- 完整動作。
- 目標。
- 影響。
- 可選項目。

**選項**

- Agent 有提供選項清單：選項取自該清單；不使用固定的兩選項。
- Agent 未提供選項清單：只呈現 Allow Once 與 Deny；效力僅限本次。
- 每個選項顯示生效範圍與持續時間。
- 會持續生效、之後不再詢問的選項視為高風險；需額外確認。
- 需要先檢視內容才能決定的選項：提供完整檢視後回到同一 Approval。

**規則**

- Pending 時 Session 顯示 Needs Input。
- 同一 Approval 只提交一次。
- 連點／事件重播不得重複處理。
- Deny 為正常結果。
- Approval 出現後切換權限模式，不改變此 Approval。

### 2.10 Stop Turn

**流程**

1. Send 變成 Stop。
2. 送出 Interrupt。
3. 顯示 Stopping。
4. Agent 確認或重新查詢後確認停止。
5. Composer 恢復。

**規則**

- 只停止目前 Turn。
- 不刪 Session、原生對話、附件、Project File。
- 結果不明：顯示待確認；查詢後更新。

### 2.11 CozyPad 關閉／SSH 中斷後恢復 Agent

**遠端執行**

- Agent Process 由 tmux、smux 或具同等功能的工具保持。
- CozyPad 關閉、App 進入背景、SSH 中斷：Process 繼續執行。

**Local Machine**

- 持續執行是遠端模式的能力；Local Agent Process 隨 CozyPad 結束。
- 重新開啟後 Local Session 顯示 Exited；不顯示 Disconnected／待確認。
- Local Session 仍可 Resume；沿用同一 Session ID 與 Timeline。

**恢復流程**

1. 重新連接 Machine。
2. 查詢 Session 對應的遠端會話與 Process。
3. 讀取本機最後 Event Position。
4. 補回新事件。
5. 去除重複事件。
6. 更新 Session 狀態與 Timeline。

**對帳規則**

- 遠端存在 CozyPad 建立的會話、本機無對應記錄：標為 Orphan 並列出。
- Orphan 不自動接入既有 Session，也不自動建立新 Session。
- 使用者確認前，不啟動也不停止該 Agent Process。
- 處理方式：加入本機清單、保留不處理、交給 Remote Cleanup。
- 加入本機清單不得產生重複 Session。

**例外**

- Process 已結束：顯示實際結果。
- 遠端會話／Event Log 暫時讀不到：顯示 Disconnected／待確認。
- 普通 Terminal Tab 不自動恢復原 PTY Channel。

### 2.12 切換 Machine

**斷線前檢查**

- Files 未保存 Draft。
- Agent 未送 Draft／Attachment。
- 刪除／高風險 Dialog。
- Remote Tool Install／Remote Cleanup。
- Terminal Foreground Process。

**處理**

- File Draft：保存、放棄、取消切換。
- Agent Draft／Attachment：按 Session 留在本機；回到原 Machine 後恢復。
- Terminal Foreground Process：列出受影響 Tab 與 Command 摘要；確認關閉或取消切換。
- Remote Tool Install／Remote Cleanup：繼續、取消切換、中止。
- 關閉 App 時套用同一檢查。

**切換流程**

1. 關閉無法跨 Machine 保留的 Terminal Channel。
2. 停止 Monitor Polling。
3. Disconnect。
4. 解鎖 Machine 選擇器。
5. Connect 目標 Machine。
6. 載入該 Machine 的 Project、Session、Study、設定、索引。
7. Files／Monitor 取得新資料後再標成即時。

**遠端工作**

- 原 Machine 的 Agent Process、Research Run 繼續執行；停止需另行操作。

### 2.13 開啟 Terminal

**預設目錄**

- 有 Project：Current Working Directory。
- 無 Project：Machine Home。

**功能**

- ANSI／True Color。
- Alternate Screen。
- Cursor／Resize。
- Mouse Mode。
- Bracketed Paste。
- CJK／Emoji／Combining Character。
- Select／Copy／Paste／Search／Scrollback。

**規則**

- 每個 Tab 使用獨立 PTY。
- 關閉 Tab 不影響 Agent、Research、其他 Tab。
- Shell／PTY／Path 失敗：顯示原因與 Retry／Close。
- SSH 中斷：關閉即時 Channel；舊 Tab 不接受輸入。

### 2.14 Quick Commands 與 Special Keys

**Quick Commands**

- 類型：目錄、Git、Machine、Runtime、開發環境。
- Paste：放入 Terminal，供檢查／補參數。
- Execute：直接執行完整 Command。
- 預設使用 Paste。
- 有 Placeholder／缺少目標的 Command 不可 Execute。

**Mobile Special-key Row**

- Escape、Tab、Control、Alt、Arrow、Home、End、Page Up、Page Down、常用符號。
- Modifier 狀態持續顯示。
- 組合鍵送出後復原。

### 2.15 瀏覽與編輯檔案

**入口**

- Home。
- Project Root。
- Current Working Directory。
- Root。
- 完整路徑。

**Directory**

- 只讀目前層級。
- 大型目錄分批載入。
- 顯示截斷／尚未載入數量。

**Text Editor**

- 讀取完整內容與檔案資訊。
- 超過編輯上限：Preview／Download；不載入截斷 Draft。
- Save 前檢查外部修改。

**Save 結果**

- 未變更：保存完整內容。
- 已變更：Reload／Save Copy／Compare／Overwrite／Cancel。
- 保存失敗：保留 Draft 與 Error。
- 離開 File、切換 Machine、Reload、關閉 App 前處理未保存內容。

### 2.16 Copy／Move／Delete

**Remote Clipboard**

1. 選取項目 → Copy／Move。
2. 前往目的目錄。
3. Paste Here。

**衝突**

- Cancel。
- Rename。
- Skip。
- Overwrite；遞迴覆寫另行確認。

**規則**

- Copy 成功：Clipboard 保留。
- Move 完成：Clipboard 清空。
- 不可將 Directory 移到自己的子目錄。
- 跨 Filesystem Move 可拆成 Copy＋Delete。
- Timeout：重新讀取來源與目的地；判定完成、未完成、部分完成、待確認。

**Delete**

- 顯示完整 Path。
- 非空 Directory 顯示遞迴範圍。
- Root 與 Home 本身不可刪除。
- Symbolic Link Delete 只刪 Link。
- 不影響 Project、Session、其他 CozyPad 資料。

### 2.17 Files → Agent

**流程**

1. Files 選取 File。
2. 選擇加入 Agent。
3. 選擇同一 Machine 的目標 Session。
4. 加入該 Session 的 Composer Attachment Tray。

**規則**

- 尚未送出。
- 可預覽／移除。
- 不修改原 File。
- 不共用 Attachment ID。
- 來源在送出前移動、刪除、修改：要求重新確認。
- 加入成功後在 Files 顯示結果與目標 Session；不自動切換 Workspace。

### 2.18 Monitor

**更新**

- 一般間隔：5 秒。
- 顯示最後成功更新時間。

**內容**

- CPU：總使用率、核心數、最忙核心、每核心。
- RAM：Used、Total、Percentage。
- GPU：數量、型號、Utilization、Memory、Temperature。
- Storage：Total、Used、Available、Percentage。
- GPU Process：GPU、PID、User、Runtime、Command、Memory。

**失敗**

- 單一資料源失敗：該區 unavailable；其他區繼續更新。
- 舊資料：標成 stale。
- 點擊 GPU Process 只看完整 Command；不停止 Process。

### 2.19 建立 Study 與 Experiment

**Study 欄位**

- 名稱。
- 研究問題。
- 主要 Metric。
- 趨勢方向。

**Experiment 設定**

- Pipeline Stage／Dependency。
- Baseline。
- Factor。
- Control。
- Seed。
- Dataset／Split。
- Metric Definition。
- Working Directory。
- Resource／Timeout／Retry／Cache。
- 同時執行 Run 數上限；有明確預設值。

**版本規則**

- 第一個 Run 進入 Queue 後鎖定。
- 修改 Locked Baseline、Control、Dataset、Split、Metric：建立新版本。
- 已啟動 Run 的設定不變。

### 2.20 預覽與啟動 Research Run

**Preview 顯示**

- Run 數量。
- Factor／Seed 組合。
- 與 Baseline 差異。
- Machine／Working Directory。
- Dataset／Split／Metric Version。
- Resource／Time Estimate。
- Blocking Error。

**驗證**

- One-factor-at-a-time：每個 Run 只改一個 Factor＋Seed。
- Factorial：只改已宣告 Factor。
- Control／Dataset／Split／Metric Drift：禁止 Launch。

**Launch**

- Queue → Preflight → Running。
- Preflight 靜態檢查與 Smoke Run 見 3.5.17。
- Timeout 且結果不明：Launch Unknown；查詢 Run／Queue／Process。
- 不得因 Timeout 建立第二個 Run。

### 2.21 CozyPad 關閉後 Run 完成

- Run 不依賴 Research Page 保持開啟。
- 斷線期間可繼續產生 State、Heartbeat、Log、Metric、Artifact、Exit Result。
- 重連後依 Run ID 補事件、去重 Metric、登記晚到 Artifact、更新 Table／Chart。
- Heartbeat 消失且找不到 Process：Lost。
- 取得明確退出結果後改成 Completed／Failed／Cancelled。

### 2.22 Agent 協助 Research

**可連結**

- Study。
- Experiment。
- Run。
- Log。
- Metric。
- Artifact。
- Dashboard。

**Agent 可提出**

- Pipeline Patch。
- Factor／Control／Seed 建議。
- Metric 設定。
- 錯誤診斷。
- 結果摘要。

**規則**

- 傳給 Agent 的資料需先確認。
- Proposal 以 Patch 顯示。
- 接受 Patch：更新 Draft；Locked Experiment 建立新版本。
- Apply Patch 不等於 Launch。
- 結論需連回 Run、Metric Definition、Filter。

### 2.23 Remote Cleanup

**可清理**

- CozyPad Session Event／Attachment Directory。
- CozyPad Log／Build Temp。
- CozyPad 管理的 Shell／Terminal Config Block。
- Orphan CozyPad Data。
- CozyPad 安裝的 User-level Tool；另行勾選。

**保留**

- Project File。
- Agent 原生 Conversation／Credential。
- User Shell Config。
- 其他 Terminal Config。
- System Tool。

**結果**

- 每項分別回報成功／失敗。
- 部分失敗保留未完成清單。
- Retry 只處理未完成項目。

## 3. 畫面與模組

### 3.1 Application Shell

#### 3.1.1 Top Bar

**元件**

- Machine 選擇器。
- Local／SSH Badge。
- Connection Status。
- Connect／Disconnect。
- Connection Settings。
- Project 選擇器。
- Global Warning。

**Connection Status**

- Disconnected。
- Connecting。
- Connected。
- Reconnecting。
- Error。

**控制**

- 所有 Workspace 可操作。
- Connecting／Connected 時鎖定 Machine 選擇器。
- 切換 Machine 前先 Disconnect。
- Dialog 開啟時，停用會破壞目前確認流程的 Top Bar 操作。

#### 3.1.2 Workspace Navigation

**順序**

1. Agents
2. Research
3. Terminal
4. Files
5. Monitor
6. Settings

**切換時保留**

- Agent Page、Session、Draft、Attachment、Timeline Position。
- Research Filter、Selection、View。
- Terminal Active Tab。
- Files Path、Selection、開啟中的 File 與 Editor Draft、Dirty State。
- Monitor 展開狀態。

**規則**

- 切換 Workspace 不停止工作。
- Terminal Channel 只在 Tab Close、Shell Exit、Machine Disconnect、App Close 時結束。

#### 3.1.3 Warning Area

**適用**

- Database Migration。
- Secure Storage。
- Remote Capability。
- Version Compatibility。

**內容**

- 問題。
- 受影響功能。
- 資料是否可讀。
- 建議操作。
- 可複製 Error Summary。

**規則**

- Dismiss 只隱藏提示。
- Diagnostics 保留必要記錄。

#### 3.1.4 Disconnected View

- 顯示斷線原因與 Connect。
- 已保存 Agent Timeline、Research Result、部分 Setting 可閱讀。
- 顯示最後更新時間。
- Stale Data 不得標成 Live。

### 3.2 Machine 與 SSH

#### 3.2.1 Machine Selector

**列表**

- Local。
- 已保存 SSH Profile。
- 最近 Connection Status。

**規則**

- Local 固定存在；不可刪除。
- Disconnect 後解鎖。
- Connect 成功後鎖定。
- Manual Disconnect 停止 Auto Reconnect。
- 切換 Profile 不保留第二條背景 SSH。

#### 3.2.2 Connection Profile List

**每列**

- Name。
- Host／Port。
- Username。
- Auth Method。
- Credential Saved。
- Last Result。

**操作**

- Add。
- Edit。
- Delete。
- Connect。

**限制**

- 使用中的 Profile 可查看。
- 修改 Host、Port、Username、Auth Method 前先 Disconnect。

#### 3.2.3 Connection Profile Form

| 欄位 | 規則 |
|---|---|
| Name | 必填；只作顯示 |
| Host／IP | 必填 |
| Port | 必填；可預設 22 |
| Username | 必填 |
| Auth Method | Password／Private Key |
| Password | Password 模式 |
| Private Key | 選檔或允許的 Key 內容 |
| Passphrase | 加密 Key 時顯示 |
| Save Credential | 使用 OS Secure Storage |

**Edit**

- Secret Field 預設空白。
- Identity 未變：空白表示沿用 Credential。
- Host／Port／Username／Auth Method 任一變更：重新提供 Credential。

**Delete**

- 需確認。
- 刪除本機 Profile、Credential、Trust Record。
- 不連線遠端。
- 不停止遠端 Process。
- 不刪遠端 File。

#### 3.2.4 Credential Prompt

**顯示**

- Username。
- Host。
- Port。
- Auth Method。
- Secret Field。
- Save Credential。

**規則**

- 未保存 Credential：只保留至本次 App 結束；可供同次 Auto Reconnect。
- Cancel：回到 Disconnected。
- Authentication 失敗：顯示錯誤並指出需修改該 Profile 的 Credential。
- Retry：開啟該 Profile 的 Connection Profile Form；焦點置於 Secret 欄位。
- 不在原地重試同一組已保存的 Credential。
- Secret 不寫入普通 Log、Error、Clipboard History、Workspace State。

#### 3.2.5 Host Fingerprint Dialog

**首次連線**

- 顯示目前 Fingerprint。

**Fingerprint 改變**

- 顯示 Old／New。

**操作**

- Cancel。
- Trust Fingerprint。

**限制**

- 不設自動接受。
- Timeout／Enter Default／Background Retry 不得建立 Trust。

#### 3.2.6 Connection Progress

1. Load Profile。
2. Get Credential。
3. Open SSH Transport。
4. Verify Fingerprint。
5. Open Channel。
6. Check Home／Shell／PTY／File Transfer／Agent。
7. Discover Agent Session／Research Run。
8. Connected。

**規則**

- 任一階段 Cancel：保持 Disconnected。
- 初次失敗後交回控制權。
- 不在背景無限重試。
- Retry 沿用同一 Profile；不建立並行連線。
- Authentication 失敗的 Retry 見 3.2.4。

#### 3.2.7 Auto Reconnect

**Banner**

- Reason。
- Attempt Count。
- Next Attempt。
- Retry Now。
- Cancel。

**規則**

- 非 Manual Disconnect 才啟動。
- Backoff 逐步增加；設上限。
- 同一 Profile 只允許一個 Reconnect Job。
- 恢復後先更新 Session、Run、Event、Files、Monitor，再標成 Live。

#### 3.2.8 Remote Agent Session Tool

**用途**

- SSH 中斷後保持 Agent Process。
- 可使用 tmux、smux 或具同等行為的工具。

**檢查畫面**

- Tool 是否存在。
- Version／Feature 是否可用。
- Agent Background Work 是否可用。
- Install／Setup 入口。
- 該 Tool 可直接執行的完整路徑；持續顯示，不只在安裝當下。
- 提供複製該路徑的操作。
- CozyPad 管理的 Shell Config Block 是否已將該路徑加入使用者 Shell 環境；未加入時告知需使用完整路徑。

**缺少 Tool**

- Terminal、Files、Monitor 仍可使用。
- Agent Page 顯示持續執行功能不可用。

**User-level Install**

- 安裝前檢查前置條件：必要建置工具與可用空間。
- 前置條件不足：不提供安裝；顯示缺少項目與需求量／實際可用量。
- 同一 Machine 同時只允許一個安裝程序；已在進行中時拒絕並顯示原因。
- 顯示 Source、Install Path、Progress、Elapsed Time、Bounded Log。
- 不要求 Admin。
- 不取代 System Install。
- 成功後刪除 Build Temp。
- 安裝中關閉 App／切換 Machine：顯示警告。

### 3.3 Project

#### 3.3.1 Project Selector

**每列**

- Name。
- Root Path。

**操作**

- Select。
- Add。
- Edit。
- Delete Record。
- Open in Files。

**切換後**

- 新 Agent、Terminal、Study 使用新 Project。
- 已執行工作維持原 Project／Path。

#### 3.3.2 Project Form

**欄位**

- Name。
- Machine；Read-only。
- Root Path。
- Folder Browser。
- Exact Path。

**規則**

- Save 前驗證 Path。
- Symbolic Link：保存使用者輸入 Path 與 Resolved Path。
- 同 Machine 可有多個 Project。
- Resolved Path 重複：提示既有 Project。

#### 3.3.3 Current Working Directory

**來源**

- Project Selector。
- Files → Set as Current Working Directory。
- 連線後自動套用該 Machine 最近使用的一筆記錄。

**記錄**

- 每台 Machine 各自保留最近使用過的 Working Directory 清單。
- 清單保存在本機；不寫入遠端。
- 連線後預設套用最近一筆。
- 清單可直接選取以快速切換。
- 目錄已不存在：標示並可移除該筆。

**影響**

- 下一個 Terminal Tab。
- 下一個 Agent Session。
- 下一個 Research Draft。

**不影響**

- 已開啟 Terminal。
- 已啟動 Agent。
- 已建立 Run。

#### 3.3.4 Project Path Error

**原因**

- Path Missing。
- Permission Denied。
- Machine Disconnected。

**操作**

- Recheck。
- Edit Path。
- Reconnect Machine。
- Delete Record。

**規則**

- 不自動停止該 Path 中仍在執行的 Agent／Run。

### 3.4 Agents

**定位**

- Claude、Codex、AGY 使用同一套 UI、同一組操作、同一個版面。
- 差異在 Adapter 層吸收；不因 Agent 不同而改變版面或操作位置。
- 能力不足以「該能力不可用」呈現並說明原因；不隱藏該操作的位置。
- 不為單一 Agent 新增專屬畫面。
- Native Interactive View 是同一版面中的一個顯示區域，不是另一套畫面。

#### 3.4.1 Agent Tabs

**預設**

- Claude。
- Codex。
- AGY。

**每個 Tab 可顯示**

- Running Count。
- Needs Input Count。
- Unread Count。
- Error。

**規則**

- 點擊只切換頁面。
- 不啟動、停止、Resume Session。
- 新 Agent 需提供 Adapter；沿用相同 Session、Attachment、Security、Identity 規則。

#### 3.4.2 Agent Availability

**顯示**

- Detecting。
- Installed＋Version。
- Executable Missing。
- Unsupported Version。
- Structured Chat。
- Resume。
- Interrupt。
- Approval。
- Attachment。
- Slash Command。
- Permission Mode。
- Regenerate／編輯後重送。

**可用條件**

- 遠端 Machine 作業系統不在支援範圍：該 Agent 不可用。
- Local Machine 不套用作業系統限制。
- 不可用時顯示判定原因與偵測到的環境。

**安裝來源**

- 優先偵測使用者層級安裝。
- 找不到使用者層級安裝：顯示警告；使用者確認後才偵測系統層級安裝。
- 採用系統層級安裝前再次警告：Usage、Context、Skills、設定可能與其他使用者共用。
- 兩次警告皆需明確確認；未確認時該 Agent 維持不可用。
- 顯示本次實際採用的安裝來源與路徑。
- 安裝來源屬於該 Machine；不套用到其他 Machine。

**Terminal-only Agent**

- 標示 Native Interactive Mode。
- 不將 Terminal Screen 拆成假的 Message、Diff、Approval。
- 沿用同一版面；Native Interactive View 佔用 Timeline 的顯示區域。
- 結構化能力不可用的操作仍在原位置顯示為不可用。

#### 3.4.3 Session List

**工具**

- Search。
- Status Filter。
- New Session。

**搜尋範圍**

- Session Name。
- Project。
- Machine／Host。
- Working Directory。

**Filter**

- All。
- Running：Starting、Running。
- Needs Input：Needs Input。
- Idle：Ready。
- Exited：Exited。
- Error：Error、Disconnected。
- Filter 分類需涵蓋 3.4.13 的每一個 Session Status。

**排序**

- 預設依 Last Activity 由新到舊。

**Unread**

- Session 未在檢視中時，收到 Assistant Message、Approval、Question、Error 累加。
- 目前正在檢視的 Session 不累加。
- 進入 Session 且 Timeline 捲到最新項目後歸零。
- Preview 不歸零。
- Agent Tab 的 Unread 為所屬 Session 的總和。

**Discovered Remote Session**

- 連線後的 Discover 階段列出本機無記錄的遠端 Session；不得靜默略過。
- 處理方式與限制見 2.11 對帳規則。

**每列**

- Name。
- Project／Directory。
- Last Activity。
- Status。
- Unread。
- Pending Approval。

**操作**

- Click／Short Tap／Enter／Space：Preview。
- Desktop Right-click／Mobile Long-press：Context Menu。
- Long-press 後吞掉 Synthetic Click。
- Menu：Rename、Delete。
- Stop 只放在已進入的 Session Page。

#### 3.4.4 Session Creation

**欄位**

- Name。
- Working Directory。

**名稱**

- 可留空。
- 後續可用 Agent Title／First Prompt 產生顯示名稱。
- Rename 不改 Session ID。

**Create Disabled**

- Machine Disconnected。
- Agent Unavailable。
- Directory Empty／Missing／Denied。
- Request Pending。

**提交**

- 顯示進度。
- 阻止重複提交。
- Session Record 只建一次。
- Agent Start 失敗仍保留 Session。

#### 3.4.5 Session Header

**顯示**

- Name。
- Agent＋Version。
- Machine。
- Project。
- Working Directory。
- Status。
- 是否已綁定原生對話。
- 本次 Resume 是否延續原生對話。
- Resume／Stop／可用操作。

**用量顯示**

- 持續顯示目前 Model 與 Reasoning Effort。
- 顯示 Context 使用百分比與各項 Limit 剩餘百分比。
- 進入 Session 後先自動取得 Context 與 Usage；期間 Composer 停用。
- 完成或逾時後開放 Composer；逾時標示用量未知。
- 數值取自 Agent 公布或明確查詢結果；不由一般畫面輸出推測。
- 自動取得用量的往返不列入 Timeline 與 Prompt History。

**規則**

- Working Directory 建立後固定。
- 需要不同 Directory：建立新 Session。

#### 3.4.6 Timeline

**Item**

- User Message。
- Assistant Message。
- Attachment。
- Streaming。
- Activity。
- Tool Card。
- Diff Card。
- Approval Card。
- Question Card。
- Test Plan Card。
- Test Result Card。
- Usage。
- Error。
- Reconnect Progress。

**Assistant**

- GFM Markdown。
- Table。
- Code Block。
- Syntax Highlight。
- Inline／Block Math 以 KaTeX 顯示。
- `mermaid` Code Block 顯示為 Diagram；Streaming 未完成時延後解析。
- 只允許 `details`、`summary`、`sub`、`sup` 等核准的 Raw HTML；其他 HTML 不直接執行。
- Assistant Message Copy 複製該則 Markdown 原文。
- Code Block Copy 只複製程式碼文字，不包含 fence、language label 或 React node 字串化結果。
- Streaming byte 以跨 chunk 的 UTF-8 decoder 解碼；不得逐 chunk 獨立產生 replacement character。

**Tool Card**

- Status。
- Summary。
- Duration。
- Output。
- Error。
- Long Output 預設收合。

- Running 預設展開；完成後可收合，但 Header、Status 與 Toggle 必須保持可見。
- Toggle 展開後依內容自動增高；不得只剩邊框或固定成一條橫線。
- Persisted Tool Card 缺少原始 ACP detail 時顯示已保存內容；不得從文字猜測 Tool Call。

**Diff Card**

- Path。
- Additions／Deletions。
- Changed Lines。
- Large Diff 分段載入。
- 提供前往 Files 的操作。
- Path 無法解析或 File 已不存在：顯示原因；不提供該操作。
- Agent 不提供 Diff：Turn 結束後由 Working Directory 取得。
- 工作目錄取不到變更：不顯示 Diff Card。
- 缺少 Diff Card 不代表沒有修改。

**Question Card**

- 顯示選項。
- 一次詢問可包含多題。
- 未全部作答前 Agent 仍在等待。
- 顯示尚未作答的題數。
- 無法呈現的詢問：顯示原始內容並提供拒絕。
- Submit 後鎖定。

**Test Plan Card**

- Agent 提出的測試案例清單。
- 每項顯示案例名稱與目的。
- 使用者可逐項勾選、增刪、修改。
- 可退回要求重列；退回時附上理由。
- 確認後才進入實作；未確認不視為同意。
- 確認後鎖定該份清單；後續變更以新的 Test Plan Card 呈現。

**Test Result Card**

- 通過數、失敗數、略過數。
- 失敗案例名稱與失敗原因。
- 可展開檢視單一案例的完整輸出。
- 與上一次結果比較：新修好、新失敗、仍失敗。
- 對應的 Test Plan Card；未經 Plan 的測試不強制關聯。
- 結果來源與登記規則見 4.13。
- 無法取得結構化結果：退回顯示原始輸出；不猜測通過與失敗。

**Turn 操作**

- Assistant Message 提供 Regenerate：同一 Prompt 重跑。
- User Message 提供編輯後重送。
- 兩者需 Agent 支援倒回上一個 Turn；不支援時不顯示該操作。
- 倒回會捨棄該 Turn 之後的原生對話內容；執行前告知影響範圍。
- 被取代的 Turn 保留在 CozyPad Timeline 並標為已取代。
- Turn Running 中不提供；先 Stop。
- 附件沿用原 Attachment；不重傳。

**Generation 結束**

- 未收到 End 的 Streaming Message 標為中斷。
- 未收到 End 的 Tool Card 標為結果未知。
- Session Status 為 Exited 時，Timeline 不得同時顯示執行中的 Item。

**Scroll**

- 接近底部才 Auto-follow。
- 向上閱讀時顯示 New Event 提示。
- 每個 Session 保存 Scroll Position。
- App 重開：先顯示 Cache，再補新 Event。
- 重開後以保存的 normalized item 重新 render；缺少的原始 ACP event 不可由畫面文字反推。

#### 3.4.7 Composer

**元件**

- Multiline Input。
- Attachment Button。
- Attachment Tray。
- Slash Command。
- Permission Mode。
- Send／Stop。

**輸入**

- Enter：Send。
- Shift+Enter：Newline。
- IME Composition 中 Enter：不送出。
- Prompt History 只在游標邊界啟用；離開後恢復 Draft。

**可用條件**

- Session 已進入／Resume。
- Machine Connected。
- Agent 可接受輸入。
- 無另一個 Turn Running。
- 無阻擋輸入的 Question／Approval。
- 進入 Session 後的用量同步已完成或已逾時。
- 無送達結果待確認的 Prompt。

**不可用時**

- 顯示原因與下一步。

#### 3.4.8 Permission Mode Control

**位置**

- Composer 附近；持續顯示目前模式。

**選單**

- 只列 Adapter 回報模式。
- 顯示簡短說明。
- 高風險模式顯示 Warning。

**狀態**

- Current。
- Applying。
- Confirmation Required。
- Failed。
- Dynamic Switch Unsupported。

**規則**

- 高風險模式需確認。
- 啟用期間維持醒目樣式。
- 從下一 Turn 生效。
- 需重啟 Process：完成後才允許 Send。

#### 3.4.9 Attachment Button／Tray

**限制**

- 每 Session 最多 10 個 Pending Attachment。
- 每個上限 20 MB。
- 超限只拒絕新增項目。

**每項顯示**

- Preview／Icon。
- Original Name。
- Type。
- Size。
- Buffered／Packaging／Transferring／Verifying／Ready／Error。
- Remove。

**規則**

- Buffered 不發遠端 Request。
- Processing 指 Packaging、Transferring、Verifying；Error 不屬於 Processing。
- Processing 中不可移除單項。
- Error 項目可單獨移除，也可單獨重試。
- 可取消整次 Send：已完成項目回到 Ready，未完成項目回到 Buffered。

#### 3.4.10 Attachment Preview

- Image：Fit、Zoom／Scroll。
- Text：Bounded Preview。
- PDF：PDF Preview。
- Other：Name、Type、Size、Session Path、Available Action。
- 關閉方式：Close Action、Escape、Backdrop。
- 關閉後 Focus 回到原 Session 對話。
- Preview 不 Resume、不 Stop、不改變 Session 狀態。
- Preview Error 只影響單一 Attachment。
- Content 在開啟 Preview 時讀取。
- Timeline 只保存 Metadata；不嵌入完整 File Bytes。

#### 3.4.11 Slash Commands／Native Interaction

- `/` 顯示可用 Command。
- 清單包含 Agent 公布的 Command 與 CozyPad 提供的 Command。
- 不使用固定共用清單假設 Agent Capability。
- Arrow：Move。
- Enter：Apply。
- Escape：Close。
- 需要額外選項：開 Picker。
- Native Interactive Agent 可將選單投影成 UI；結果仍送回原 Agent Process。

**由 CozyPad 完成的 Command**

- 部分 Command 由 CozyPad 直接完成；不建立 Agent Turn、不進入 Running。
- 選單需可分辨由 CozyPad 完成與由 Agent 處理的 Command。
- 直接完成的 Command 仍在 Timeline 顯示操作與結果。
- 只影響 CozyPad 自身資料；不改變 Agent 原生對話。
- 需要 Agent 配合才能完成的動作不列入此類。
- CozyPad 代使用者送給 Agent 的查詢，其往返不列入 Timeline 與 Prompt History。

#### 3.4.12 Approval Card

**狀態**

- Pending。
- Submitting。
- Allowed。
- Denied。
- Expired。
- Result Unknown。
- Failed。

**Expired**

- 所屬 Execution Generation 已結束：標為 Expired；停用所有選項。
- 提交後 Agent 回報該 Approval 已不存在：標為 Expired。
- Expired 保留原內容；不改寫成 Allowed／Denied。
- Expired 不代表已允許；該動作未執行。
- Expired 後 Session 不再顯示 Needs Input 與 Pending Approval。
- 提示該動作需由 Agent 重新提出。

**規則**

- Resolved 後不可再操作。
- Event Replay 更新同一 Card。

#### 3.4.13 Session Status

| 狀態 | 顯示 |
|---|---|
| Starting | 建立 Process；會公布 Conversation ID 者含取得 ID |
| Ready | 可送 Prompt |
| Running | 正在處理 Turn |
| Needs Input | 等待 Approval／Question／Input |
| Disconnected | 無法確認遠端 Process |
| Exited | Process 已結束 |
| Error | 需處理錯誤 |

**Execution Generation**

- 同一 Session 每次啟動新 Process 取得新 Generation。
- 舊 Generation 晚到 Event／Error／Exit 不得修改目前 Generation。

#### 3.4.14 Session Delete

**範圍**

- Local Index。
- Agent Process。
- CozyPad Remote Event。
- CozyPad Remote Attachment。
- Agent Native Conversation；Agent 支援時顯示。

**規則**

- Dialog 顯示 Session、Machine、Agent、Directory。
- 每個選取 Scope 顯示實際影響。
- 不可復原的 Scope 明確標示。
- Project File 永不列入。
- 每項分別回報結果。
- 部分失敗不得顯示全部完成。
- Machine 未連線仍可刪除 Local Index。
- 未連線時遠端 Scope 不執行；回報未完成並列出殘留項目。
- 晚到的 Event、狀態更新、Stream 結束不得使已刪除的 Session 重新出現。
- 刪除成功後不得再顯示該 Session 不存在的錯誤。
- 刪除後關閉該 Session 進行中的 Dialog 與選單。

### 3.5 Research

**定位**

- Research 是 Agent 產生實驗設定的工具，也是使用者監督該設定的介面。
- Agent 負責產生與修改設定；使用者負責審核、鎖定變因、決定執行。
- 每個欄位在 GUI 上可見、可操作、可鎖定。
- 鎖定的欄位 Agent 不得變更；強制機制見 3.5.16。
- 啟動、取消、提高 Resource 一律由使用者確認。

#### 3.5.1 Study List

**每列**

- Name。
- Research Question Summary。
- Primary Metric。
- Experiment Count。
- Running／Failed／Completed Run Count。
- Last Activity。

**操作**

- Add。
- Open。
- Archive。
- Export。

**Archive**

- 仍可 Read／Compare／Export。
- 不可新增 Run。

#### 3.5.2 Study Form

**欄位**

- Name。
- Research Question。
- Primary Metric。
- Direction。
- Note。

**規則**

- 綁定目前 Project。
- 切換 Machine／Project 後只顯示對應 Study。

#### 3.5.3 Experiment Version List

**每列**

- Version。
- Draft／Locked／Archived。
- Baseline Summary。
- Factor Count。
- Run Count。
- Created At。

**規則**

- Draft 可編輯。
- 第一個 Run 進 Queue 後 Locked。
- 修改 Locked Version：建立新 Version；顯示 Diff。
- Version 對應設定檔的一個版本；見 3.5.16。
- 此處的 Locked 指版本凍結；與 3.5.16 的欄位鎖定是兩件事。

#### 3.5.4 Pipeline

**常見 Stage**

- Dataset Snapshot。
- Split。
- Preprocess。
- Normalize／Augment。
- Initialize Model。
- Train。
- Evaluate。
- Export。

**Stage 欄位**

- Name／Purpose。
- Command／Entry Point。
- Input Artifact。
- Output Artifact。
- Success Condition。
- Working Directory。
- CPU／GPU／RAM／Storage。
- Timeout。
- Retry。
- Cache。

**執行介面**

- 不要求研究程式引入 CozyPad 套件或改用特定語言。
- 執行時提供 Resolved Config、Working Directory、Metric 輸出位置。
- 研究程式依約定格式寫出 Metric 與 Artifact；CozyPad 據此登記。
- 格式與登記規則見 4.13。

**驗證**

- DAG；禁止 Cycle。
- Required Input 必須存在。
- Artifact Type 必須相容。
- Stage 必須可到達。
- 失敗時阻止 Run Preview。

**Stage State**

- Stage 節點各自顯示狀態；與 3.5.7 Run Status 分開。
- Cached 與實際執行的 Completed 分開顯示。

**Cache**

- Code、Input Artifact、Resolved Config、Environment 全部相同才可重用。

**Version Compare**

- 標出新增／刪除／修改的 Stage、Edge、Input、Output。

#### 3.5.5 Experiment Design

**分類**

- Factor。
- Control。
- Derived Value。
- Observed Nuisance。
- Outcome。

**規則**

- 每個 Factor 至少一個 Baseline Value。
- 可加入 Alternative Value 與 Seed。
- Design：One-factor-at-a-time／Full／Grid Factorial。
- 每個欄位可由使用者鎖定；鎖定與強制機制見 3.5.16。
- 即時計算 Run Count。
- Queue／Resource／Duration 顯示 Estimate。
- Estimate 依同時執行 Run 數上限計算。

#### 3.5.6 Run Preview

**每列**

- Temporary Label。
- Factor。
- Control。
- Seed。
- Dataset／Split。
- Metric Definition。
- Machine／Directory／Resource。
- Baseline Diff。
- Validation Result。

**規則**

- Launch 後建立正式 Run ID。
- Temporary Label 不作 Run ID。
- 未宣告的 Control／Dataset／Split／Metric／Path Drift：阻止整批 Launch。

#### 3.5.7 Queue／Run Status

| 狀態 | 說明 |
|---|---|
| Draft | 尚未確認 |
| Queued | 等待執行 |
| Preflight | 執行前檢查；項目見 3.5.17 |
| Launch Pending | 已送要求，等待回應 |
| Launch Unknown | 遠端是否啟動不明 |
| Running | 執行中 |
| Paused | 已暫停且可恢復 |
| Completed | 完成 |
| Failed | 明確失敗 |
| Cancelled | 已確認取消 |
| Lost | Heartbeat／Process 找不到；結果待查 |

**規則**

- Pause：Stage 支援且有有效 Checkpoint。
- Retry：建立新 Run；保留 Source Run 關係。
- Retry 預設沿用 Source Run 的 Experiment Version 與 Resolved Config。
- Experiment 已有較新 Version：Retry 前顯示差異，由使用者選擇沿用或改用。
- 超過同時執行上限的 Run 停在 Queued。
- 原 Run Config、Log、Metric、Artifact 不覆寫。

#### 3.5.8 Run Detail

**Tabs**

- Overview。
- Configuration。
- Pipeline。
- Logs。
- Metrics。
- Artifacts。
- Provenance。
- Linked Agent Sessions。

**Overview**

- Machine。
- Status。
- Start Time。
- Heartbeat。
- Progress。
- Current Stage。
- Resource Usage。
- Primary Metric。

**Cancel**

- 顯示 Run／Process。
- 保留 Log、Metric、Checkpoint、Artifact。

#### 3.5.9 Provenance

**啟動前收集**

- Code Revision／Dirty State。
- Dataset Identity。
- Split。
- Preprocessing。
- Resolved Config。
- Command／Working Directory。
- Environment／Framework／Dependency。
- Driver／Hardware／Resource Limit。
- Seed。
- Model Initialization。
- Container／Environment Identity。

**Model Initialization**

- Random／Pretrained／Checkpoint。
- Source Revision。
- Seed。
- Loaded Layer。
- Mismatch。
- Freeze Policy。
- Total／Trainable Parameter Count。

**限制**

- 不保存 Secret、Token、完整 Environment Dump。
- 缺少必要資料：Run 可完成；不可標成 Reproducible。
- Export 列出缺少項目。

#### 3.5.10 Metrics

**欄位**

- Run ID。
- Name。
- Value。
- Step／Epoch。
- Split。
- Time。
- Unit。
- Aggregation。
- Direction。
- Metric Version。

**規則**

- 既有格式的 Metric 記錄可匯入；沿用相同 Metric 定義與去重規則。
- Duplicate Event 只保存一次。
- Late Metric 可加入 Completed Run。
- NaN／Infinite／Missing 保留原狀。
- 同名不同 Unit／Definition 不自動合併。

#### 3.5.11 Artifacts

**欄位**

- Name／Type。
- Size。
- Hash。
- Run／Stage。
- Remote Path。
- Retention Policy。
- Downloaded。

**規則**

- Large Artifact 預設留在遠端。
- Download／Sync 才傳本機。
- Checkpoint 保存 Model、Architecture、Layer、Optimizer、Step、Seed、Source Run、Compatibility。

#### 3.5.12 Runs Table

**功能**

- Filter。
- Sort。
- Group。
- Pivot。
- Pin Column。
- Saved View。
- Multi-select。
- Expand Detail。

**規則**

- Charts、Effect Summary、Export 使用目前 Selection。
- Failed／Cancelled／Lost／Missing Metric 保留。
- Analysis Summary 顯示 Total 與 Excluded Count。

#### 3.5.13 Ablation Analysis

**前置檢查**

- Control 一致。
- Metric Definition 一致。

**顯示**

- Absolute／Relative Difference。
- Run Count。
- Seed Distribution。
- Mean／Variation。
- Confidence Interval。
- Failed／Missing Count。

**限制**

- 多 Factor 變動：顯示 Interaction Warning。
- Design／Sample 不足：標成 Descriptive Comparison。
- 每個數值可追到 Run／Metric Definition。

#### 3.5.14 Charts／Dashboard

**Chart Type**

- Learning Curve。
- Scatter。
- Distribution。
- Heatmap。
- Parallel Coordinates。
- Effect。
- Interaction。
- Pareto。

**每張圖顯示**

- Run Selection。
- Filter。
- Group。
- Metric。
- Metric Version。

**規則**

- Learning Curve 保留實際長度；不補 0。
- Dashboard 可放 Table／Chart／Metric／Note。
- 保存 Query＋Layout；不複製 Run Data。
- Header：Dataset Revision、Baseline、Run Count、Failed Count、Last Update。

#### 3.5.15 Agent Collaboration

**入口**

- Research 查看 Linked Agent Session。
- 從 Study／Experiment／Run／Artifact／Dashboard 開 Agent Session。

**傳送前**

- 列出交給 Agent 的內容。

**操作分離**

- Apply Proposal。
- Reject Proposal。
- Launch Run。
- Cancel Run。
- Remove Link。

**限制**

- Agent 不得將任意 Shell Command 直接登記為 Run。
- Agent 不得直接提高 Resource、修改 Locked Control、替換 Dataset、改 Analysis Filter、Launch／Cancel Run。
- Agent 產生的 Draft 需經使用者確認才成為 Experiment Version。
- Remove Link 只解除關聯；不刪 Agent Session 與 Research Object。

#### 3.5.16 實驗設定檔與變因鎖定

**權威來源**

- 實驗定義以設定檔保存在 Working Directory。
- 設定檔是權威來源；GUI 是它的檢視與編輯介面。
- 本機只保存索引、Lock 記錄與顯示用資料；不另存一份實驗定義。
- 設定檔可由使用者以一般檔案工具版控。
- 設定檔遺失或無法解析：保留 Run 記錄；標示該 Experiment 無法編輯與執行。

**Agent 權限**

- 可讀取設定檔。
- 可產生新的實驗 Draft 設定檔。
- 對既有設定檔的修改一律以 Patch 呈現；不直接生效。
- 不得寫入 Lock 記錄。

**欄位識別**

- 每個可鎖欄位以設定檔內的結構路徑作為識別。
- Lock 記錄、唯讀鎖定清單、違規訊息一律使用同一識別。
- 同名欄位出現在多個 Stage 時，各自有不同識別。

**Lock 記錄**

- 保存在本機；不寫入設定檔。
- 每筆包含欄位識別、鎖定當下的值、鎖定時間。
- 鎖定當下的值即校驗基準。
- 基準值只在使用者變更該欄位或解除鎖定時更新。
- 基準值屬於 Lock 記錄；不視為另存一份實驗定義。

**唯讀鎖定清單**

- CozyPad 產生一份放在設定檔同一目錄，供 Agent 讀取。
- 檔名由設定檔名衍生。
- 內容只含欄位識別、鎖定狀態、鎖定時間。
- 鎖定狀態變更、連線後開啟該 Experiment、Launch Preflight 時重寫。
- 遺失或與本機記錄不符：以本機記錄重寫。
- 被修改不改變實際鎖定狀態；一律以本機記錄為準。

**校驗時機**

- 開啟 Experiment、套用 Patch 後、Launch Preflight 一律重讀設定檔並校驗。
- Machine 連線期間另行監看設定檔；偵測到變更即校驗。
- 監看不可用：明確標示；上述三個時機照常校驗。
- 不論變更來自 Agent、使用者或外部檔案工具，一律校驗。

**校驗**

- 逐一比對被鎖欄位目前值與基準值。
- 有變動：標為違規；該欄位不套用。
- 被鎖欄位在新內容中不存在（改名、搬移、刪除）：比照變動處理。
- 違規顯示欄位識別、基準值、嘗試變更的值。
- 未通過校驗前不可 Launch。
- 校驗結果記入該 Experiment 的變更記錄。

**違規處理**

- 還原該欄位：寫回基準值；本次其他變更保留。
- 解除該欄位鎖定：需明確確認；之後該欄位不再校驗。
- 捨棄整次變更：只在變更來自 CozyPad 套用的 Patch 時提供；還原該次 Patch 的全部欄位。

#### 3.5.17 Preflight 與 Smoke Run

**目的**

- 在正式 Launch 前以機械方式擋掉可預期的錯誤。
- 檢查結果為二元；不由 Agent 判斷，也不由 Agent 略過。

**靜態檢查**

- 檢查項為固定清單；每項顯示通過或未通過與原因。
- Seed 已設定。
- Dataset 版本已釘住。
- Split 定義存在。
- Metric 定義存在且已宣告方向。
- 輸出位置可寫。
- 資源需求在宣告上限內。
- 被鎖欄位未變動；見 3.5.16。
- 未宣告的 Control／Dataset／Split／Metric Drift；見 3.5.6。
- 任一項未通過：阻止 Launch。

**Smoke Run**

- 以極小資料子集執行完整 Pipeline。
- 子集大小與來源屬於 Experiment 設定；與正式 Run 共用同一份設定檔。
- 通過條件：每個 Stage 執行完成、Metric 依約定格式寫出、宣告的 Artifact 產生、Checkpoint 可寫入並讀回。
- 失敗：顯示失敗的 Stage 與缺少的輸出；阻止正式 Launch。
- Metric 標為 Smoke；不計入分析。
- Artifact 與 Checkpoint 預設不保留。
- 可由使用者略過；略過需明確操作並記入 Provenance。

**與正式 Run 的關係**

- 通過的 Smoke Run 記錄當時的設定指紋。
- 設定在 Smoke Run 後變動：需重跑 Smoke Run。
- 未變動時可直接正式 Launch。
- Smoke Run 與正式 Run 使用不同 Run ID；不互相覆寫。

**GUI 操作**

- 每個欄位顯示分類、目前值、是否鎖定。
- 使用者可逐欄鎖定與解除鎖定。
- 解除鎖定需明確操作；不因 Agent 提出而自動解除。
- 顯示每個欄位最後一次變更的來源：使用者或 Agent。
- 可一次檢視所有被鎖欄位。

### 3.6 Terminal

#### 3.6.1 Tab Bar

**顯示**

- Terminal Session。
- Active Tab。
- Shell Status。
- New Tab。

**Shell Status**

- Idle：無 Foreground Process。
- Running：有 Foreground Process。
- Exited：Shell 已結束；顯示 Exit Code／Signal。
- Disconnected：Channel 已失效；不接受輸入。

**操作**

- Rename：只改顯示名稱。
- Switch：不暫停 Shell。

**Close**

- Shell Exited：顯示 Exit Code／Signal。
- Idle：可直接關閉。
- Foreground Process：顯示摘要與確認。
- Channel Disconnected：關閉 Local Tab；不宣稱遠端 Process 已停止。

#### 3.6.2 Terminal View

- 使用可用空間計算 Rows／Columns。
- Resize 送給 PTY。
- Resize 失敗：保留畫面；顯示提示；後續可重試。
- Scrollback 保留至 Tab 結束。
- 切換 Tab 保留位置。
- Touch Drag 預設捲動 Local Scrollback；不送 Arrow Key。

#### 3.6.3 Search／Selection／Clipboard

**Search**

- 只搜尋目前 Tab Scrollback。
- 顯示 Count、Previous、Next。

**Desktop**

- 有 Selection：Context Action Copy。
- 無 Selection：Context Action Paste。

**Mobile**

- Long-press 進入 Selection。
- Drag Handle 調範圍。
- Copy／Paste 使用明確按鈕。

**Clipboard Permission Denied**

- 顯示原因。
- Terminal 仍可輸入。

#### 3.6.4 Paste Protection

- Bracketed Paste 依 Terminal Protocol。
- Multi-line／Control Character／Long Content：可顯示 Preview Confirmation。
- Confirmation 只影響本次 Paste。
- Quick Command Execute 不經 Multi-line Paste Confirmation；視覺需與 Paste 不同。

#### 3.6.5 Quick Commands

**每項**

- Name。
- Full Command。
- Purpose。
- Paste／Execute。

**規則**

- 需要 Path／PID／Branch／Parameter：只用 Paste；游標放在待填位置。
- 不提供未確認即刪除資料／變更權限的 Command。

#### 3.6.6 Special-key Row

- Mobile 預設顯示。
- Desktop 可選開啟。
- Ctrl／Alt 可鎖定至下一 Key。
- Escape／Tab／Arrow 等單鍵立即送出。
- Arrow、Page Up／Down 按住時連續重複送出。
- 每次送出後 Focus 回到 Terminal。
- 使用 Special-key Row 不收起 Mobile 軟體鍵盤。
- Page Up／Down 預設捲動 Scrollback；需時可切換成送給 Remote Program。

### 3.7 Files

#### 3.7.1 Layout

**元件**

- Home／Root／Project Root／Current Working Directory Shortcut。
- Breadcrumb。
- Exact Path Input。
- Directory List。
- Action Toolbar。
- Remote Clipboard Status。
- Preview／Editor。
- Context Menu。

**Context Menu**

- Copy Name。
- Copy Absolute Path。
- Copy Project-relative Path。
- Set as Current Working Directory。
- Set as Project Root。

**版面**

- Desktop：Directory／Preview 可並排。
- Mobile：List Page／Content Page 切換。

#### 3.7.2 Directory List

**每列**

- Name。
- File／Directory／Symbolic Link。
- Size。
- Modified Time。
- Permission Summary。
- Link Target Status。

**操作**

- Directory：Open。
- File：Preview／Edit。
- Right-click／Long-press：Menu。

**失敗**

- 保留上一個可用 Path。
- 顯示 Error。
- Refresh 只重讀目前層級。

#### 3.7.3 Breadcrumb／Path Input

- Breadcrumb 顯示 Resolved Path。
- 點擊任一層直接前往。
- Input 接受 Absolute Path、Home Shorthand、可解析 Relative Path。
- Submit 先 Resolve，再更新 View。
- 失敗：保留原位置與輸入文字。

- Timeline 中的 File Link 接受 `path:line` 與 `path:line:column`；Windows drive colon 不得誤判為行號分隔符。
- 開啟 File Link 時先分離行列資訊，再以檔案 Parent 更新 Directory List，以 File 更新 Preview／Editor。
- 跳轉成功後顯示並定位目標行；不得把 File Path 傳給 Directory List，也不得使左側目錄失效。

#### 3.7.4 Symbolic Link

- 顯示 Target 與 File／Directory／Broken。
- Open 前顯示 Resolved Path。
- Relative Target 以 Link Parent 為基準。
- Broken Link 可 Rename／Delete／Inspect；不可當一般 File 開啟。

#### 3.7.5 New File／Folder

- 顯示 Current Directory 與 Name。
- 拒絕 Control Character、Path Separator、Directory Traversal。
- 同名項目存在：不覆寫；要求改名。
- 成功後只 Refresh 目前目錄；選取新項目。

#### 3.7.6 Rename

- 顯示 Source Path 與 New Name。
- 目的名稱存在：Cancel／改名。
- 不提供隱含 Overwrite。
- Result Unknown：重讀 Parent；確認 Source／Destination。

#### 3.7.7 Copy／Move／Duplicate

**Remote Clipboard 顯示**

- Operation Type。
- Source Machine。
- Source Path。
- Item Count。

**Scope**

- 只在同一 Machine 使用。
- 切換 Machine 時隱藏；回到原 Machine 後可恢復本次 App 內有效 Clipboard。

**Paste Conflict**

- Skip。
- Rename。
- Overwrite File。
- Apply to Batch。

**限制**

- Directory 不可 Copy／Move 到自己的子目錄。
- Cross-filesystem Move 可拆成 Copy＋Delete。
- 任一步失敗：顯示 Partial Result。
- Duplicate：同 Parent 建副本；先提供可改名稱。

#### 3.7.8 Delete

- 顯示 Full Path、Type、Item Count、Recursive Scope。
- Root 與 Home 本身不可刪除；拒絕並顯示原因。
- Symbolic Link Delete 只刪 Link。
- Result Unknown：重讀 Parent。
- File Missing：Completed。
- 仍存在：Not Completed。
- 部分內容刪除：Partial Success＋Remaining Item。

#### 3.7.9 Text Editor

**適用**

- Text／Code／Config／Log／CSV／Markdown／Hidden Text／合理的 Extensionless Text。

**元件**

- Path。
- Syntax Mode。
- Encoding。
- Line Ending。
- Dirty Indicator。
- Save。
- Find。
- Markdown Source／Preview。
- Reload。

**大小**

- 一般上限 256 KB。
- 超限：顯示 Size；提供 Preview／Download；不建立可 Save 的截斷 Draft。

**Save**

- 完整內容寫回同 Path。
- 開啟時偵測 Encoding 與 Line Ending；Save 沿用。
- 混合 Line Ending：統一為該檔主要行尾；開啟時告知。
- 檔尾有無換行維持原樣。
- 成功後更新 Metadata 與 Clean State。

**Encoding／Line Ending**

- Editor 持續顯示目前 Encoding 與 Line Ending。
- 兩者皆可手動切換。
- 切換 Encoding 提供以該編碼重新開啟或以該編碼儲存。
- Dirty 只由目前內容與開啟／最後保存內容的差異決定；Focus、游標、Selection 或單純開啟檔案不得設為 Dirty。
- 離開或切換 File 時，只有 Dirty 才顯示捨棄變更提示。
- 有 BOM 依 BOM；其餘預設 UTF-8。
- 偵測不確定時標示為推定值。

#### 3.7.10 External Modification Conflict

**開啟時記錄**

- Modified Time。
- Size。
- Content Identity；可用時。

**Save 前重查**

- Remote Changed：顯示 Reload／Save Copy／Compare／Overwrite／Cancel。

**各選項行為**

- Reload：捨棄 Draft；載入遠端目前內容。
- Save Copy：在同一 Directory 建新檔；先提供可改名稱；原 File 不變。
- Save Copy 成功後 Editor 對象切到新檔；Dirty 清除。
- Compare：並列本機 Draft 與遠端目前內容；唯讀；關閉後回到同一 Conflict Dialog。
- Overwrite：以 Draft 完整覆寫遠端內容。
- Cancel：保留 Draft。

#### 3.7.11 Binary Preview／Download

- 支援 Image、PDF、Media Preview。
- Unsupported：Metadata＋Download。
- Binary 不因未知 Extension 用 Text Decode。
- Download 保留 Exact Bytes、Safe Original Name、Best-known MIME。
- Mobile 使用 OS Document Save。

**大小處理**

- Preview 需完整載入：設上限；超過只提供 Download。
- 超過上限時顯示檔案實際大小與上限。
- Download 以串流寫入；不整份載入記憶體。
- Download 顯示進度、已傳位元組、可取消。
- 取消或失敗：刪除不完整的暫存檔；不留半份檔案。

### 3.8 Monitor

#### 3.8.1 Update State

**Header**

- Machine。
- Last Success Time。
- Collecting／Live／Partial／Stale／Disconnected。

**Snapshot**

- 同一組完成後整體替換，避免不同時間資料混用。
- Slow Source 可晚更新；每張 Card 顯示自己的 Time／Error。

#### 3.8.2 CPU Card

- Overall Usage。
- Logical Core Count。
- Busiest Core。
- Per-core Detail。
- 第一筆 Sample：Collecting；不顯示 0%。
- 使用兩次 Sample 差值計算。

#### 3.8.3 Memory Card

- Used。
- Total。
- Percentage。
- 三值來自同一 Snapshot。
- 取得失敗：Unavailable；不推估。

#### 3.8.4 GPU Card

- GPU Count。
- Average Utilization。
- Total／Used VRAM。
- Per GPU：Index、Name、Utilization、Memory、Temperature、Warning。
- 無支援 Telemetry：Unavailable；CPU／RAM 繼續。

#### 3.8.5 Storage List

- 預設排除 Temp、Pseudo、Virtual、Duplicate Mount。
- 每列：Mount Point、Filesystem、Used、Available、Total、Percentage。
- Update Failure：保留上一筆；標成 Stale。
- Near Full：提高警示；不因單一 Sample 宣稱 Disk Failure。

#### 3.8.6 GPU Process Table

- GPU Index。
- PID。
- User。
- Runtime。
- Command Summary。
- GPU Memory。
- 點擊顯示 Full Command＋Copy。
- Command 只在 Table 截斷。
- Process 下一 Snapshot 消失時自然移除。

### 3.9 Settings

#### 3.9.1 分類

- Local Device。
- Mobile。
- Current Machine。
- Remote Machine。

**每項顯示**

- 保存位置。
- 生效時間：Immediate／Next Session／Reconnect／Restart App。

#### 3.9.2 Remote Settings

- SSH Machine Connected 時讀取。
- 可含 Remote Mouse Mode、tmux／smux Session Rule、Managed Config Block Status。
- 只修改 CozyPad 管理區塊。
- Block 外內容保持原樣。
- Saved 但未套用：分別顯示 Saved／Not Applied；說明 Reconnect／Restart Session。

#### 3.9.3 Background Execution

- 支援平台顯示 Keep Connection in Background。
- Enabled：使用 OS Visible Background Service 維持 SSH。
- Disabled：OS 可 Suspend App／Connection。
- 遠端 Agent／Run 不受此開關影響。
- OS 拒絕／停止服務：顯示實際狀態；Switch 不保留假 Enabled。

#### 3.9.4 Appearance

- Theme。
- Text Scale。
- Terminal Font。
- Terminal Font Size。
- 修改後 Immediate Preview。
- Save Failure：回到原值。
- Font 優先 Monospace＋CJK。
- 放大文字後主要操作不可被裁切。

#### 3.9.5 Remote Cleanup

- 顯示 Delete Scope、Preserve Scope、Confirmation、Progress、Per-item Result。
- Machine Disconnected：Disabled＋Reason。
- Running 時切換 Machine／關閉 App：Warning；提供繼續清理、取消切換、中止清理。
- 中止只停止尚未開始的項目；已開始的項目照常回報結果。
- 中止後未執行與未完成的項目列入未完成清單。
- Retry 只處理未完成項目。

#### 3.9.6 About／Diagnostics

**顯示**

- App Version。
- Platform／Local／SSH。
- Protocol／Data Version。
- Agent Version／Feature Summary。
- Connection Status。
- Copy Diagnostics。

**Redaction**

- Password。
- Private Key。
- Passphrase。
- Token。
- Full Prompt。
- Attachment Content。
- 不必要 Private Path。
- Mock／Demo Data 明顯標示。

## 4. 技術行為

### 4.1 Target Host Core／本機與遠端分工

**CozyPad App**

- 顯示 UI、接收操作。
- 保存 Connection Profile、Project、Session、Study、Run 索引。
- 保存 Draft、Pending Attachment、UI State、Preference。
- 建立 Local／SSH Transport、PTY 與 File Transfer Channel。
- 將 ACP Event 轉成 Timeline Item；斷線後查詢目標主機狀態。

**共用 Host Core**

- Local 與 SSH 使用同一套 Node host runtime 語意處理 process、filesystem、stream 與 lifecycle。
- Process 一律以分離的 `command`、`args`、`cwd`、`env` 傳入；不把使用者內容拼成 shell command。
- File API 在擁有該檔案系統的 target host 上執行；Local Path 不送往 Remote，Remote Path 不交給 Local `node:fs`。
- UTF-8 stream decoder 跨 chunk 保存未完成的 multibyte sequence。

**Local Machine**

- Electron main process 直接呼叫共用 Host Core。
- Agent 為 CozyPad 子行程；CozyPad 結束時一併結束。
- Session Event、Attachment、Run 資料保存在本機。

**SSH Machine**

- CozyPad 以現有 SSH connection 啟動 target-host runner；SSH 只承載 RPC request、byte stream 與 lifecycle event。
- Agent、Shell、filesystem 與 Research Process 都在 Remote Machine 執行。
- Remote runner 使用 login `HOME`／`PATH`；`node` 必須是 absolute executable，Claude／Codex ACP 啟動還需可用的 `npx`。
- Remote Machine 保存 Project File、Agent Login／Native Conversation、Session Data 與 Run Data。

**生命週期邊界**

- SSH bridge 的連線生命週期與 Agent Process 的持續執行是兩件事；單一 SSH exec channel 不得被視為斷線續跑保證。
- 需跨 SSH disconnect／App close 持續的 Process，必須由 tmux、smux、systemd user service 或同等可重接機制持有。
- 不預設永久常駐 Daemon；若新增 Remote Program，需定義 Capability、Install、Version、Data Path、Reconnect 與 Removal。

### 4.2 物件 ID

#### 4.2.1 Machine

- Machine ID 對應 Local Machine 或已驗證 Remote Machine。
- Profile Rename 不改既有 Machine Relation。
- Host／Port／Username 變更：重新驗證 Credential 與 Trust。

#### 4.2.2 Project

- Project ID 綁定 Machine 與 Project Record。
- Root Path 可修正；修改後重新驗證。
- 已存在 Session／Run 保留建立時使用的 Path。

#### 4.2.3 Agent Session

- CozyPad 建立固定 Session ID。
- 綁定 Machine ID、Agent Kind、Working Directory、可選 Project ID、Native Conversation ID。
- Native Conversation ID 可在 Process Start 後取得。
- Native Conversation ID 可在 Resume 後更換；Session ID 不變。
- Title 可改。
- Process Exit／Resume／Replace 不改 Session ID。

#### 4.2.4 Agent Process／Execution Generation

- 同一 Session 每次啟動新 Process，建立新 Generation。
- Event 帶 Session ID＋Generation。
- 舊 Generation 的 Exit／Error／Status 只留歷史；不得覆蓋目前狀態。

#### 4.2.5 Run

- 正式 Launch 時建立 Run ID。
- Retry 建立新 Run ID，記錄 Source Run。
- Preview Label、PID、Queue Position、Display Name 不作 Run ID。

#### 4.2.6 Attachment

- Attachment ID 綁定 Machine、Session、User Turn。
- 同一原 File 加入另一 Session：建立新 Attachment ID。

### 4.3 遠端 Agent Process

**啟動位置**

- ACP wrapper／adapter 與真正 Agent Process 必須由 Remote Host Core 在遠端 `cwd` 啟動。
- CozyPad 本機只持有 protocol client 與 SSH bridge；不得以本機 child process 搭配遠端 path 冒充 Remote Agent。

**持續執行層需支援**

- Start Process。
- List Session／Process。
- SSH Disconnect 後保持 Process。
- Reattach I/O 或提供 Event Source。
- Interrupt。
- Stop。
- Check Alive。

**責任分開**

- Host Core：Process／filesystem 實際執行。
- SSH Bridge：request、stream、event 傳輸與 reconnect。
- tmux／smux／systemd 類工具：跨連線 Process Lifecycle。
- ACP Runtime／Agent Adapter：Session、Prompt、Mode、Approval、Question 與 Agent Event。
- Session Directory：Event／Attachment Data。

**Session Remote Data**

- Session Metadata。
- Execution Generation。
- Event Log／Position。
- Attachment Manifest。
- Attachment File。
- Bounded Diagnostic Log。

**Path 規則**

- 可由 Session ID 定位。
- 不使用可修改 Title 作唯一 Path。
- 預設不放 Project Root。
- Delete Session 不匹配其他 Session／Project File。
- Remote Cleanup 可列出並移除。
- Delete／Leave 必須確認真正 ACP child、持續執行層與 Session Data 的結果；只刪 Local Index 不代表遠端已停止。

### 4.4 ACP Runtime／Agent Adapter

**共用 ACP Runtime**

- 同一 client flow 處理 `initialize`、`session/new`／`resume`、`prompt`、`cancel`、`set_mode`、`set_config_option` 與 structured update。
- `session/request_permission` 與 Question／Elicitation 會阻塞 Agent，直到使用者作答或該 execution generation 結束。
- Timeline normalization、pending control、process exit 與 UTF-8 stream handling 不因 Agent 種類分叉。

**Agent-side 實作**

- Claude Code：已發布的 `claude-agent-acp` wrapper。
- Codex：已發布的 `codex-acp` wrapper。
- AGY：CozyPad 的 `adapter-agy`，將 print／stream output 轉成 ACP。
- 各實作負責 Agent-specific executable detection、native conversation、resume、model／mode 與 negative capability。

**Capability／Mode 規則**

- 不代表共用 LLM、Provider Account、Native Conversation Data。
- 不宣告 Agent 未提供的功能；Agent Upgrade 後重新檢查。
- Mode／Config 選單以 `session/new`／`resume` 實際回覆為事實來源，不從 CLI help 推定 Agent 已支援 ACP mode。
- 預先選擇的 Launch mode 必須映射到 Agent 回報的 canonical mode ID，並在 `set_mode` 成功後才顯示為 Active。
- 找不到 mode 或 `set_mode` 失敗時不得靜默 fallback；保留實際 current mode，顯示未套用原因。
- Agent 不送出 `session/request_permission` 時，標示為 Unmanaged／Always Proceed；不得顯示 Interactive Approval 可用。
- Workspace／Additional Directory 對 Agent 只是 inclusion hint 時，不得標示為 sandbox boundary。
- 有 Structured Event 時不得解析 Terminal Screen 猜測 Approval、Diff、Tool Result、Usage 或完整對話。
- Legacy AGY Session 無 Conversation ID：Resume 只聲明實際能確認的 continuity，不以 CozyPad Timeline 冒充 Agent memory。

### 4.5 Timeline Event

**類型**

- User Message。
- Assistant Start／Delta／End。
- Activity。
- Tool Start／Update／End。
- Diff。
- Approval Request／Resolution。
- Question／Answer。
- Usage。
- Attachment。
- Error。
- Process Status。

**必要欄位**

- Session ID。
- Generation。
- Event ID／Source Position。
- Time。
- Type。
- Turn／Tool／Approval／Attachment Relation ID。

**保存規則**

- Ordered Read。
- 從 Last Position 繼續。
- Replay 不重複。
- Sequence Gap 顯示 Missing Event。
- Streaming Message 原地更新。
- Raw Provider Event 可供 Recovery／Diagnostics；普通 Timeline 只顯示轉換結果。

### 4.6 Attachment Transfer

#### 4.6.1 Local Buffer

**Metadata**

- Original Name。
- Type。
- Size。
- Local Source。
- Preview Data。
- Status。

**規則**

- Buffer 屬於單一 Session。
- Local Path 不當成 Remote Path。

#### 4.6.2 Batch

- 一次 Send 建立一個 Batch ID。
- 包含本 Turn 尚未 Delivered 的 Attachment。

**Packaging 前檢查**

- File Exists。
- Size Limit。
- File Changed Since Selection。
- Safe Filename。
- Batch Size 可處理。

#### 4.6.3 Remote Landing

1. 傳到 Temporary Path。
2. 完整解包。
3. 驗證。
4. 移到 Session Attachment Directory。
5. 更新 Manifest。

**Atomic Rule**

- Batch 未完成前，Agent 看不到部分 Attachment。

**每個 File 保存**

- Attachment ID。
- Original Name。
- Safe Stored Name。
- MIME。
- Size。
- Hash。
- Session Path。

#### 4.6.4 Prompt Submission

- Attachment Ready 後，Adapter 依 Agent 支援方式送入。
- Prompt＋Attachment Relation 屬於同一 Turn。
- Delivery Unknown：查 Event；不直接重送。

#### 4.6.5 Retry

- Packaging Failed：保留 Buffer；重新打包。
- Transfer Failed／Remote Incomplete：沿用 Batch ID 重傳或清 Temp 後重傳。
- Transfer Complete／Response Lost：查 Manifest＋Hash。
- Prompt Failed：沿用 Delivered Attachment ID。
- App Closed：恢復 Pending Buffer；查 Remote Temp／Manifest。

### 4.7 Terminal Channel

- 使用真實 PTY 或 Local Equivalent。
- Input：Key Byte、Paste、Resize、Signal。
- Output：Terminal Byte、Exit。
- Terminal Output 不保存成 Agent Timeline。
- Scrollback 預設只在 Memory；若保存到 Disk，需提供 Clear 與 Scope 說明。
- SSH Disconnect 後不將失效 PTY 接回舊 Tab。
- 可開新 Tab 或連入 Remote tmux／smux。

### 4.8 Files Operation

- File Operation 使用 Structured Parameter；不拼 Shell Command。
- 保存 Operation ID、Source、Target、Start Time、Stage。

**Timeout 後判定**

- Not Started。
- Completed。
- Partial。
- Unknown。

**Move**

- Cross-filesystem 可拆 Copy＋Delete。
- Copy 成功、Delete 失敗：來源與副本保留；顯示 Partial。

**Save**

- 優先 Temporary File＋Atomic Replace。
- Filesystem 不支援 Atomic Replace：Error／Diagnostics 標示限制。

### 4.9 Research Execution／Event

**Launch 前**

- 保存完整 Resolved Config。
- 設定檔內容與 Lock 記錄一併納入 Provenance。
- Run、Queue Entry、Process 使用不同 ID。

**Run Event**

- State Change。
- Heartbeat。
- Stage Progress。
- Log Reference。
- Metric。
- Artifact。
- Resource Observation。
- Exit Result。

**規則**

- Event 可 Replay／Deduplicate。
- Metric 依 Run ID、Name、Step、Split、Version 去重。
- Launch／Cancel／Pause／Resume／Retry 使用 Operation ID。
- Response Lost：先查 Run／Process。
- Provenance／Metric／Artifact 保存在遠端可恢復位置。
- 本機保存索引與有限顯示資料。
- Download／Export 時同步完整內容。

### 4.10 Cross-module Handoff

#### 4.10.1 Files → Agent

- 傳 Machine ID、Source Path、File Metadata、Target Session ID。
- Agent Composer 建 Pending Attachment。
- Files 不直接提交給 Agent。

#### 4.10.2 Files → Current Working Directory

- 傳 Machine ID＋Directory Path。
- Project 更新 Default Directory。
- Running Process 不變。

#### 4.10.3 Agent Diff → Files

- 傳 Machine ID、Path、Diff／File Reference。
- Files 重新讀取目前 File。
- Timeline Diff 不視為目前 File State。

#### 4.10.4 Agent ↔ Research

- 傳 Object ID＋已確認內容。
- Link 不複製／合併 Object。
- Remove Link 只刪關聯記錄；兩端 Object 保留。

#### 4.10.5 Research Artifact → Files

- 傳 Machine ID＋Artifact Path。
- Files Open／Download。
- Artifact Record 仍由 Research 管理。

#### 4.10.6 Monitor → Agent／Research

- 傳 Timestamped Snapshot＋Process Info。
- Time Overlap 只作觀察關聯。

**Partial Handoff**

- 分別列出 Completed／Failed／Unknown Module。
- 已完成部分不回滾成失敗。

### 4.11 Unknown Result／Retry

| 狀態 | 處理 |
|---|---|
| Not Started | 可重試 |
| Explicit Failure | 修正後重試 |
| Success | 更新畫面；不重送 |
| Unknown | 先查遠端 |

**查詢方式**

- Prompt：Turn／Event。
- Agent Start：Session Generation／Process。
- Attachment：Manifest／Hash／Path。
- File Operation：Source／Destination。
- Run Launch：Run／Queue／Process。
- Approval：Resolution。
- Setting Save：Actual Setting。

**Operation ID**

- Query／Retry 期間保持一致。
- 避免重複建立結果。

### 4.12 Local Storage

**可保存**

- Connection Profile。
- Secure Credential Reference。
- Trusted Fingerprint。
- Project。
- Session Index／Bounded Timeline Cache。
- Draft／Pending Attachment Metadata／Temp Content。
- Study／Experiment／Run Index。
- 實驗設定檔位置與欄位 Lock 記錄。
- UI Selection／Filter／Scroll／Setting。
- Bounded Diagnostic Log。

**不保存到一般資料庫**

- Secret Credential。
- Full Provider Token。
- Agent Private Data。
- Unbounded Environment Dump。

### 4.13 結構化結果

**適用**

- Agent 執行的測試結果。
- Research Run 的 Metric 與 Artifact。

**規則**

- 不要求被執行的程式引入 CozyPad 套件或改用特定語言。
- 執行時提供結果輸出位置；程式依約定格式寫出。
- CozyPad 讀取該位置並登記。
- 讀不到或格式不符：退回原始輸出；不猜測結果。
- 同一份結果只登記一次；重複讀取不產生重複記錄。
- 格式版本隨結果保存；不同版本不自動合併。
- 結果只保存判定所需資料；不夾帶完整環境或 Secret。

## 5. 安全、資料與清理

### 5.1 Credential

- Password、Private Key、Passphrase 只由 Privileged Storage／Connection Code 讀取。
- Frontend 只取得 Saved／Missing／Error。
- Secure Storage Failed／Decrypt Failed：Profile 顯示 Credential Error。
- 不改用 Plaintext。
- 不自動刪除舊 Credential。
- UI Error、Log、Crash Report、Diagnostics 不含 Secret。

### 5.2 SSH Trust

- Trust Record 綁定 Host、Port、Host Key。
- Fingerprint 改變後舊 Trust 不適用。
- 普通 Workspace 不可修改 Trust。
- 只有 Fingerprint Dialog 可新增／替換。
- Weak／Obsolete Algorithm 預設拒絕。

### 5.3 Prompt／Attachment／Shell

- Prompt、Filename、Path 視為 Untrusted Input。
- 不拼成 Shell Command。
- 不以 `sh -c` 解析使用者內容。
- Argument 分離傳入。
- Attachment Extract 拒絕 Absolute Path、`..`、Control Character、Escape Symlink。
- Filename Collision 使用 Safe Name／Separate Directory；保留 Original Name 顯示。

### 5.4 Approval／Permission Mode

- Permission Mode 只控制 Agent 自身操作。
- CozyPad 只可攔截 Agent 實際送出的 `session/request_permission`；未送出時不得宣稱逐次 Approval 生效。
- Mode 選擇值、Agent 回報 current mode、實際 policy 必須一致。
- 預選 Mode 在 Agent 確認 `set_mode` 成功前不是 Active。
- 無對應 Mode 時顯示 Unsupported／Not Applied；不得以 Agent default 冒充使用者選擇。
- AGY `always-proceed` 必須明確顯示不受 CozyPad approval policy 控制。
- Workspace root 不是 sandbox 的 Agent 必須顯示該限制。
- 以下 CozyPad 確認不受 Agent Bypass 影響：
  - SSH Fingerprint Trust。
  - Profile／Credential Delete。
  - Session Multi-scope Delete。
  - Remote Cleanup。
  - Files Recursive Delete／Overwrite。
  - Research Launch／Cancel／Resource Increase。
  - Experiment 欄位解除鎖定。

### 5.5 Data Ownership

| 資料 | 所有權／管理 |
|---|---|
| Project File | 使用者；CozyPad 依明確操作讀寫 |
| Agent Native Conversation | Agent／使用者；CozyPad 保存 ID、Resume、可選 Delete Request |
| Agent Login／Token | Agent／使用者；CozyPad 不讀內容 |
| CozyPad Session Index | CozyPad |
| Session Event／Attachment | 使用者內容；CozyPad 管理 |
| Study／Experiment／Run | 使用者內容；CozyPad 管理 |
| Run Artifact | 使用者；CozyPad 索引／下載／依 Policy 清理 |
| Export／Download | 使用者；解除安裝不刪 |

### 5.6 Session Delete

**獨立範圍**

- Local Index。
- Agent Process。
- Remote Event。
- Remote Attachment。
- Native Conversation。

**Default**

- 只選 Local Index。

**限制**

- Remote Path 使用 Session ID 精確定位。
- 不包含 Project File、其他 Session、Study、Run、Artifact。
- Machine 未連線時只執行 Local Index；遠端 Scope 回報未完成。

### 5.7 Uninstall

**刪除**

- App Private Database。
- Connection Profile。
- Local Cache。
- Preference。
- CozyPad Credential in Secure Storage。
- Trusted Host Record。

**保留**

- Remote Project File。
- Remote Agent Process。
- Native Conversation。
- Remote Session Event／Attachment。
- Research Run／Artifact。
- Export／Download。

**規則**

- Uninstall 不連線遠端執行 Cleanup。

### 5.8 Remote Cleanup

- 只操作可證明由 CozyPad 建立的 Path／Config Block。

**執行前顯示**

- Path／Block。
- 所屬 Session／Feature。
- Estimated Size。
- Running Process Dependency。
- Delete Impact。

**Running Dependency**

- 預設不勾選。
- 顯示需先停止的 Agent／Run。

### 5.9 Diagnostics

**保留**

- App／Platform／Protocol Version。
- Machine Mode／Non-secret Connection Data。
- Agent Version／Feature。
- Limited Session／Run ID。
- Operation Stage／Error Category。
- Recent Connect／Reconnect Result。

**遮蔽**

- Password／Key／Passphrase／Token。
- Full Prompt／Agent Reply。
- Attachment Content。
- 不必要 Full Path／Username／Host。
- Full Shell Environment。

## 6. 驗收條件

### 6.1 Startup／Machine

- 啟動後為 Disconnected；不自動連線任何 Machine。
- Local 需明確 Connect；但不要求登入本機。
- 連線後 Working Directory 取該 Machine 最近一筆記錄。
- 同時只存在一個 Active Machine。
- Connected 時不能直接切換 Machine。
- Manual Disconnect 不啟動 Auto Reconnect。
- 切換後，Project、Agents、Research、Terminal、Files、Monitor 顯示目標 Machine 資料。
- 舊 Machine Live Data 不得短暫顯示成新資料。
- File Draft 未處理時阻止切換。

### 6.2 SSH／Credential

- 首次連線確認 Fingerprint。
- Fingerprint 改變時顯示 Old／New。
- 關閉 Fingerprint Dialog 不建立 Trust／Connection。
- Secret 無法從普通 UI、Log、Diagnostics 讀回。
- Host／Port／Username／Auth Method 變更後不沿用舊 Credential。
- Secure Storage 不可用時不建立相關 Connection。
- Delete Profile 只刪本機 Profile、Credential、Trust。
- Authentication、Trust、Transport、Remote Environment Error 分開顯示。

### 6.3 Project

- 建立前驗證 Path。
- 新 Terminal／Agent／Study 使用 Current Working Directory。
- 變更 Current Working Directory 不影響 Running Work。
- Root Missing 後 Project Record 保留並顯示錯誤。
- Delete Project Record 不刪 Directory。

### 6.4 Agent Session

- 建立時只設定 Name、Working Directory。
- Permission Mode 進入 Conversation Page 後設定。
- 新 Session 使用 Safe Default Mode。
- Invalid Directory 不建立 Session。
- 重複點擊 Create 不產生多個 Session。
- Start Failed 後可在同一 Session Retry。
- 會公布 Conversation ID 的 Agent 未取得時顯示 Starting。
- 不公布 Conversation ID 的 Agent 不因此停在 Starting。
- Rename 不改 Session ID。
- App Restart 後不自動選 Session。
- Select Session 只 Preview History。
- Preview 時 Composer Disabled。
- Resume Alive Process 不啟動第二個 Process。
- Resume Exited Process：延續原生對話、建立新原生對話、或顯示無法繼續。
- 不延續原生對話時 Timeline 標出分界；不冒充 Agent 記憶。

### 6.5 Permission Mode

- Control 固定顯示於已進入 Session 的 Composer 附近。
- 只列 Adapter 回報 Mode。
- High-risk Mode 顯示 Machine、Directory、Risk。
- 啟用期間持續顯示 Warning Style。
- 切換不建立新 Session。
- Mode 清單與 current value 來自實際 ACP Session 回覆。
- 建立時的 Launch mode 與 Agent canonical ID 不同時，需有明確 mapping 與測試。
- Agent 未確認 Mode 已套用前，UI 不顯示為 Active。
- 不匹配或切換失敗時不得靜默使用預設值。
- 不送 Permission Request 的 Agent 顯示 Unmanaged／Always Proceed，不顯示 Interactive Approval 可用。
- Running Turn 不受中途切換影響。
- New Mode 從下一 Turn 生效。
- Existing Approval 不自動通過。
- Switch Failed 後顯示原 Mode。
- 需 Restart Process 時 Session 不變；原生對話依 Resume 規則處理。

### 6.6 Timeline／Event

- Claude、Codex、AGY Event 可顯示為 Message、Tool、Diff、Approval、Question、Usage、Error。
- 共用 Timeline Item 不合併 LLM、Account、Native Conversation。
- 有 Structured Event 時不解析 Terminal Screen 作主要資料。
- Event Replay 不產生 Duplicate Item。
- Old Generation Event 不覆蓋 Current Process。
- Streaming Message 原地更新。
- 向上閱讀時不強制捲到底部。
- 每 Session 保存 Scroll Position。
- Test Plan 未確認前不視為同意。
- 無法取得結構化測試結果：退回原始輸出；不判定通過或失敗。
- 10,000 Visible Item 仍可操作。

### 6.7 Composer／Attachment

- IME Composition 中 Enter 不送出。
- Enter Send；Shift+Enter Newline。
- 每 Session 保存獨立 Draft／Pending Attachment。
- Select File／Paste Screenshot 後先留 Local。
- 加入 Attachment 時不發 Remote Request。
- Image 立即顯示 Local Preview。
- 每 Session 最多 10 個；每個 20 MB。
- 超限只拒絕新增項目。
- 一次 Send 只建立一個 Batch。
- Batch 未完整驗證前不送 Prompt。
- Attachment Failed 時保留 Draft／Tray。
- Attachment Delivered、Prompt Failed 時 Retry 不重傳。
- Success 後 Attachment 顯示於對應 User Message。
- App Restart 後已送 Attachment 可查看。
- 單一 Preview Failed 不隱藏 Message。
- Attachment-only Turn 不產生假文字 Prompt。
- Attachment ID 不可跨 Session 讀取。

### 6.8 Approval／Stop

- Approval 顯示 Machine、Directory、Action、Target、Impact。
- 同一 Approval 只 Resolve 一次。
- Generation 已結束的 Approval 標為 Expired；不改寫成 Allowed／Denied。
- Deny 顯示 Normal Result。
- Agent Bypass 不略過 CozyPad Host Trust、Files Delete、Remote Cleanup、Research Launch 確認。
- Stop 只中斷 Current Turn。
- Stop 不刪 Session、Conversation、Attachment、Project File。
- Stop Unknown 時先查 Process／Event。

### 6.9 Disconnect／Recovery

- CozyPad Close／SSH Disconnect 後，Remote Session Tool 中的 Agent Process 繼續。
- Local Agent Process 隨 CozyPad 結束；重開後顯示 Exited。
- 遠端有 CozyPad 會話、本機無記錄時列為 Orphan；不自動接入。
- Reconnect 後同一 Session 補回新 Event。
- 30 分鐘斷線後 Event 不遺失、不重複。
- Process 查不到時先顯示 Disconnected／Unknown。
- 取得明確 Exit 後才顯示 Exited。
- Terminal Tab 斷線後不假裝仍可輸入。
- Research Run 可在 App 關閉後繼續；重連後更新。

### 6.10 Terminal

- 每 Tab 使用獨立 PTY。
- Interactive Program、Editor、Pager、Monitor、Remote Multiplexer 可用。
- True Color、Alternate Screen、Mouse、Bracketed Paste、CJK、Emoji 正常。
- Resize 更新 PTY Rows／Columns。
- Search 只搜尋目前 Scrollback。
- Quick Command Paste／Execute 視覺不同。
- Missing Parameter Command 不可 Execute。
- Mobile Special-key Row 可送 Escape、Tab、Modifier、Arrow。
- Close Foreground Process Tab 前確認。
- Close Tab 不影響 Agent／Research。

### 6.11 Files

- Directory List 只讀目前層級。
- Large Directory 分批顯示並標示未載入內容。
- Broken Symlink 保持可見。
- Delete Symlink 不刪 Target。
- Name／Path Validation 阻止 Control Character／Traversal。
- Create／Rename 不隱含 Overwrite。
- Copy Success 後 Clipboard 可再 Paste。
- Move Complete 後 Clipboard Clear。
- Directory 不可 Move 到自己的子目錄。
- Move Partial 顯示 Source／Destination 實際結果。
- Save Failed 後 Draft 保留。
- External Modification 顯示 Conflict Option。
- >256 KB Text 不以截斷內容進 Editor。
- Binary 不因 Unknown Extension 用 Text Decode。
- Download 保留 Exact Bytes／Safe Original Name。
- Files → Agent 先進 Pending Attachment Tray。

### 6.12 Monitor

- First CPU Sample 顯示 Collecting；不顯示 0%。
- CPU／RAM／GPU 顯示各自 Update Time。
- Missing Data 顯示 Unavailable。
- Old Data 顯示 Stale。
- GPU Unavailable 時 CPU／RAM 仍更新。
- Storage 排除 Temp／Pseudo／Virtual／Duplicate Mount。
- GPU Process Click 只顯示 Full Command。
- Disconnect 後舊 Snapshot 不標 Live。

### 6.13 Research

- Study 綁定 Project。
- First Run Queue 後 Experiment Locked。
- 修改 Locked Baseline／Control 建新 Version。
- Pipeline Cycle 阻止 Run Preview。
- One-factor-at-a-time 只改一個 Factor＋Seed。
- Control／Dataset／Split／Metric Drift 阻止 Launch。
- Launch Timeout → Launch Unknown。
- Retry 建新 Run；不覆寫原 Run。
- Cancel 保留 Log、Metric、Checkpoint、Artifact。
- Duplicate Metric 只保存一次。
- NaN／Infinite／Missing 不改成 0。
- Same Name／Different Definition Metric 不自動合併。
- Provenance 缺必要資料時不標 Reproducible。
- Runs Table、Chart、Effect、Dashboard、Export 使用相同 Selection。
- Failed／Cancelled／Lost／Missing Metric Run 保留。
- 實驗定義以設定檔為權威來源；本機不另存一份。
- 欄位 Lock 記錄保存在本機；不寫入設定檔。
- Agent 修改被鎖欄位：判定違規；不套用該欄位。
- 未通過設定檔校驗不可 Launch。
- 靜態檢查任一項未通過不可 Launch。
- Smoke Run 未通過不可正式 Launch；略過需明確操作並記入 Provenance。
- 設定在 Smoke Run 後變動需重跑 Smoke Run。
- Smoke Run 的 Metric 標為 Smoke，不計入分析。
- Agent 產生的 Draft 需使用者確認才成為 Version。
- Agent Proposal 需手動 Apply。
- Apply Proposal 不自動 Launch。
- Agent Conclusion 可追到 Run／Metric Definition。

### 6.14 Settings／Cleanup／Retention

- 每項 Setting 顯示 Scope／Effective Time。
- Background Execution 顯示 OS Actual State。
- Appearance Save Failed 後 Restore Old Value。
- Remote Setting 只改 Managed Block。
- Remote Cleanup 前列 Delete／Preserve Item。
- 只刪 CozyPad 可識別 Path／Block。
- Partial Failure 逐項回報；可 Retry。
- Diagnostics 不含 Secret、Full Prompt、Attachment Content。
- Uninstall 刪 Local Private Data。
- Uninstall 不刪 Remote Project、Agent Process、Native Conversation、Run、Artifact、Download。

## 7. 最低測試範圍

1. Local First Launch。
2. Password／Private Key SSH。
3. First Fingerprint／Changed Fingerprint。
4. SSH Disconnect、Auto Reconnect、Cancel。
5. Project Create／Edit／Delete Record。
6. Claude／Codex／AGY Session Create。
7. Session Preview、Resume Alive、Resume Exited。
8. Permission Mode Switch、High-risk Confirm、Process Restart。
9. Prompt Success、Response Lost、Retry。
10. Screenshot、Single File、Multi-file、Remove、Attachment-only Turn。
11. Transfer Failed、Landing Success／Response Lost、Prompt Failed。
12. Approval Allow／Deny／Double Click／Replay。
13. Stop Success／Unknown。
14. App Closed 30 Minutes → Agent Timeline Recovery。
15. Terminal Interactive Program、Resize、Clipboard、Search、Disconnect。
16. Files Create、Rename、Copy、Move、Delete、Symlink、Partial Result。
17. Text Save、External Conflict、Large Text、Binary Download。
18. Monitor First Sample、Partial Failure、Stale、No GPU。
19. Pipeline Validation、Run Materialization、Control Drift、Launch Unknown。
20. Metric Dedup、Artifact、Provenance、Chart、Export。
21. Agent Research Proposal、Patch Apply、Separate Launch Confirm。
22. Machine Switch with File Draft、Agent Draft、Terminal、Monitor。
23. Session Delete Partial Success。
24. Remote Cleanup／Uninstall Retention。
25. Agent 產生實驗 Draft、使用者確認、成為 Version。
26. 欄位鎖定、Agent 修改被鎖欄位、違規處理、Launch 阻擋。
27. Test Plan 提出、審核、退回重列。
28. Test Result 結構化呈現、與上次比較、格式讀不到時退回原始輸出。
29. Preflight 靜態檢查逐項通過與未通過。
30. Smoke Run 通過、失敗、略過、設定變動後重跑。
31. 三家 Agent 使用同一版面；能力不可用時的降級呈現。
32. Local／SSH 對同一 Host Runtime contract 的 filesystem、process、UTF-8 stream parity。
33. Claude／Codex／AGY 實際 ACP Mode ID 與 Launch mode mapping；不匹配時不得假成功。
34. Permission Request 真正阻塞、Allow／Deny／Always option 回傳與 Agent 未送 Request 的降級呈現。
35. Remote Agent 跨 SSH Disconnect／App Restart 持續執行、事件補回、Delete 後無殘留 process／tmux session。

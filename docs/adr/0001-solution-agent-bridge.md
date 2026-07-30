# ADR 0001：採納 solution-agent handoff 的執行層設計

| 欄位 | 內容 |
| --- | --- |
| 日期 | 2026-07-29 |
| 狀態 | Accepted（概念層）；實作於 Phase 6A |
| 來源 | `cozypad_solution_agent_model_handoff_20260727.zip`（隱私清洗過的設計交接包） |

## 背景

handoff 包提出 CozyPad ⇄ solution-agent（確定性 Python 任務編排器）的整合設計。
打包時間早於 V3 定案，其中 CozyPad/Hermes 參考源碼已過時（V3 移除 Hermes），
但 solution-agent 側的執行層設計與 `SPEC.md` §18 Research Lab 高度互補。

## 決策

### 採納（融入 `SPEC.md` §18 的實作準則）

1. **信任邊界**（見 `docs/protocols/solution_agent_bridge_contract.yaml`）：
   - CozyPad 擁有 UI、互動 SSH、tmux、telemetry、使用者核准。
   - 執行層（runner）獨佔 task/run 身分、狀態機、排程、artifact 收集。
   - 模型只擁有提案與有界結構化 intent，**永不直接執行、永不碰憑證**。
2. **Mutation 一律走 durable action request**：帶 `expected_current_state`，
   執行時重新驗證；高風險動作需使用者可見核准。不提供直接 shell 執行。
3. **顯式狀態機**：轉移鄰接表 + 冪等同狀態寫入 + 顯式 `InvalidTransition` 錯誤
   （已移植為 `@cozypad/contracts` 的 `validateRunTransition`）。
4. **SSH 啟動不確定性語意**：`launch_unknown`（逾時、遠端狀態不明）不得與
   `launch_failed`（確定失敗）混同；對應 `SPEC.md` `lost` 的細化，reconciliation
   後才能收斂。
5. **Heartbeat**：遠端 run 目錄增加 `heartbeat.json`；UI 顯示 `heartbeat_age`；
   PID 消失且無 exit code → `lost`，不得推定成功或失敗。
6. **ExecutionSpec 白名單**：run 的命令來自 `script_id` 註冊表與驗證過的
   workspace/artifact 路徑，不執行模型產生的任意 shell 字串（`SPEC.md` §13）。
7. **單一事實來源**：舊 Flutter 的 `~/.dashboard_tasks.json` 與新執行層註冊表
   不得成為兩個可寫 master；遷移時一次性匯入後唯讀。

### 不採納／過時

- 包內的 Flutter/Hermes 參考源碼（V3 已移除 Hermes，repo 內另有最新版）。
- Phase 3「Hermes 整合」——由 V3 的 remote agent adapter（Claude/Codex）取代。
- solution-agent 以本機 Python 常駐服務運行——牴觸 `SPEC.md` §3（核心不內嵌
  Python）。改為：**執行層跑在遠端主機**，CozyPad 經 SSH 與 durable files 溝通
  （`SPEC.md` §17 既留此選項）。

## 影響

- `packages/contracts/src/research.ts`：run 狀態機 + heartbeat schema（本次落地）。
- Phase 6A Research Lab 的 runner 依本 ADR 的邊界實作；bridge contract 的
  read models 屆時轉為 Zod schemas。

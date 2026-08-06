# HANDOFF — Agent Page UI Edge Cases（2026-08-06）

給下一個 session 的交接。讀完這份就能接續，不需要翻舊對話。

## 任務

全自動修 CozyPad 的 UI edge case，直到收斂。終點：整理不出新的 general edge case，且已知的全部修掉或明確寫下不修的理由。

使用者的三個產品目的（影響優先序）：取代太肥的 VS Code、手機辦公、agent 跑 CV 實驗要有確定性驗證。使用者的話：「目前許多功能其實都已經有了，只是差 edge case 的 robustness」。

## 權威文件

- **`SPEC-hand.md`（repo 根目錄，約 3200 行）是行為權威。** 程式與它衝突時，先判斷是產品錯還是規格錯；本 session 已三輪稽核過規格，通常是程式錯。
- `docs/agent-page-inventory.json` — 37 條「規格 vs 程式」落差盤點，**每條含 fix_sketch、風險、工作量**（JSON 裡 `result.bySlice[].items[]`）。這是主要工作清單。
- `docs/TEST_HISTORY.md` — 歷次進度記錄，本 session 的在最後兩節。

## 目前狀態

- **測試基準：383 passed / 1 skipped，typecheck 乾淨。任何修改不得低於此。**
- **AGY UI smoke harness 全綠**（本 session 修到能跑完）：建 session → Resume → 用量同步 → 五個 overlay → 送 prompt → 收回覆 → Stop，18 個觀測點。
- 已修完：執行期 mock 全移除（詳見下）、啟動不自動連線（SPEC 2.1）、AGY quota 解析三處（`Weekly Limit Remaining` 標題、gauge fallback、空陣列≠undefined）、statusline 缺額度時的提示、harness 兩處過期斷言（context menu 要右鍵、進入要按 Resume）。

## 驗證迴路（每條修改都要走）

1. **啟動真 app**：`cmd /c "D:\CozyPad\CozyPad.bat"`（要絕對路徑），背景執行，約 20 秒。啟動後是 Disconnected，**先選 local 主機按 Connect** 再測。
2. **Smoke harness**（AGY 修改的主要驗證）：
   ```
   cd D:\CozyPad\apps\app && node node_modules\vite\bin\vite.js build
   cd D:\CozyPad\apps\desktop && node esbuild.mjs
   $electron = (node -e "console.log(require('electron'))")
   $env:COZYPAD_DEV_URL=""; & $electron . --agy-smoke-test
   ```
   **坑：renderer 的改動（apps/app 底下全部）要 `vite build` 才進包，`esbuild` 只建主行程。** 忘了會拿舊程式碼測，白跑一輪。
3. **raw vs rendered 比對**：結果在 `%TEMP%\cozypad-agy-ui-smoke\observations.json`，每個 stage 的 `terminalOutputTail`（原始 PTY bytes）對 `cozyPadText`（UI 渲染文字）是同一瞬間同一條流，用這個抓「終端說 X、UI 畫 Y」。
4. **截圖/點擊**：`scripts/dev/shot.ps1 -Out x.png`、`scripts/dev/click.ps1 -X n -Y n`（視窗座標）。細節坑都寫在 memory 的 ui-verify-by-running。
5. **單元測試**：`pnpm -r test`（PATH 要先加 node，見 memory dev-env-node-path）。
6. **測完關 app**（使用者要求）：kill 路徑在 `D:\CozyPad\node_modules` 下的 electron。

## 規則與授權邊界

- 使用者已委派日常決策。**例外**：刪使用者資料、改 git 歷史、動 Claude adapter 底層（本機無 Claude CLI，驗證不了）。
- **不要另開 localhost dev server 當驗證環境**（使用者明確反對）；一律走真實建置的 app。
- 執行期 mock 已刪除、不要加回來：`mockBridge`／`mockTransport`／`COZYPAD_MOCK` 都不存在了。`packages/test-fixtures` 的 `mockPty`、`sshFixtures` 是真測試在用的，保留。
- AGY＝Antigravity CLI 1.1.10（第三方，本機已裝、已登入），**不要動它**；改的是 CozyPad 的解析與 UI。「harness」指 `apps/desktop/src/main/main.ts` 裡 `--agy-smoke-test` 那段 CozyPad 自己的測試腳本。
- 每輪把進度追加到 `docs/TEST_HISTORY.md`。
- 修改哲學：先止血（封閉在 `AgyCliSurface.tsx` 內的），後統一版面（會碰共用元件與 Claude 路徑的往後放）。架構判斷已做過：AGY 的 bug 主因是「兩套元件各自處理狀態」不是終端解析——但解析層也有實錘 bug 在清單裡。

## 下一步（照優先序）

**（2026-08-06 晚間更新）37 條 inventory 已全數完成**——agy-vs-unified 8、
agy-parsing 5、codex-path 8、session-state 8、composer-attachment 8，
外加沿路發現的實錘（codex 啟動參數 kebab-case、persist 佇列毒化、
sync overlay 殘留、codex 用量解析、帶引號問句偵測等）。逐條驗證記錄
在 `docs/TEST_HISTORY.md` 的 2026-08-06 各節。

目前在最終階段：**general edge case 蒐集（實機工作流模擬）**，已跑四輪
（AGY draft/狀態、codex 全程、codex approval、AGY 問答卡），每輪仍有
新發現（第四輪抓到帶引號問句讓歷史 echo 變選項的解析 bug）。繼續逐輪
模擬使用者工作流直到整理不出新的為止；候選場景：AGY 互動卡實機點選、
長回覆捲動、附件實機收發、斷線中操作。

環境注意：Google 的 AGY eligibility 服務今晚間歇 503，會造成 smoke
「重建後首跑」偶發失敗（重跑即綠）與 AGY 偶發靜默不回；判讀失敗前先
排除這個外部因素。

## 給下一個 session 的啟動 prompt（使用者貼這段）

```
讀 D:\CozyPad\docs\HANDOFF.md，照裡面的規則接續任務。
從「下一步」第 1 項開始，全自動跑，決策照授權邊界，
每條修改走完驗證迴路，進度寫進 docs/TEST_HISTORY.md。
```

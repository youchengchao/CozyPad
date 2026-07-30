# CozyPad

**把手機／電腦連上遠端主機上的 coding agent 的工作站。**

CozyPad 讓你從 Windows 桌面或 Android 手機，透過 SSH 管理遠端 Linux 主機：
多分頁終端機、檔案瀏覽與編輯、CPU/GPU 監控，以及（開發中的）Claude Code /
Codex / agy 等 remote agent 的對話介面。Agent 全部跑在遠端 tmux 裡——關掉
app、斷線、換裝置，工作都不會中斷。

一套 **React + TypeScript** codebase，桌面包 **Electron**、Android 包
**Capacitor**；桌面安裝包約 100MB、Android APK 約 5MB。

> 完整規格見 [SPEC_V3.md](SPEC_V3.md)；本 README 只講怎麼跑起來。

## 現在能用的功能

| 功能 | 狀態 |
| --- | --- |
| SSH 連線管理（密碼以 OS 加密記憶、host key 首次信任／變更警告、斷線自動重連） | ✅ |
| 多分頁終端機（xterm.js、右鍵複製貼上、常用指令面板、手機 Termux 式按鍵列） | ✅ |
| 遠端檔案：類型圖示、symlink 跳轉、任意路徑導覽、右鍵／長按選單、兩段式複製搬移 | ✅ |
| 檔案編輯：Monaco（VS Code 引擎）語法高亮、Ctrl+S 直接存回遠端；Markdown 預覽；PDF 內嵌檢視 | ✅ |
| 監控：CPU／記憶體／GPU 與 GPU processes，每 5 秒更新 | ✅ |
| 遠端設定：tmux 滑鼠模式開關；tmux 缺失時一鍵使用者層級安裝 | ✅ |
| Agents 對話（Claude / Codex / agy） | 🚧 架構與 parser 完成，接線中 |
| Research Lab（實驗管理） | 🚧 UI 雛形 |

## 快速開始

### 需求

只需要 **Node.js LTS + pnpm**（不需要 Flutter、Rust、Visual Studio、Android Studio）：

```bash
corepack enable   # 或 npm install -g pnpm
pnpm install
pnpm test         # 全綠即環境就緒
```

### 日常使用

| 做什麼 | 操作 |
| --- | --- |
| 連真實主機使用 | 雙擊 `CozyPad.bat`，或 `pnpm --filter @cozypad/desktop start` |
| Demo（內建假主機，零設定） | 雙擊 `CozyPad-Demo.bat` |
| UI 開發（瀏覽器熱更新） | `pnpm dev` → http://localhost:5173 |
| 桌面開發（Electron 熱更新，mock） | `pnpm dev:desktop` |
| 桌面開發（真 SSH） | `pnpm dev:desktop:ssh` |
| Android APK | `pnpm --filter @cozypad/mobile apk`（需 Android SDK + JDK 21） |
| 檢查 | `pnpm lint` / `pnpm typecheck` / `pnpm test` |

第一次連主機：右上 **⚙** 新增連線 → Connect → 確認 host key 指紋即可。

更多細節：[docs/DEV_V3.md](docs/DEV_V3.md)（開發指南）、
[docs/TUTORIAL_ELECTRON_CAPACITOR.md](docs/TUTORIAL_ELECTRON_CAPACITOR.md)
（從零到日常 routine，含手機 live reload）。

## Repository 結構

```
apps/
  app/        共用 React UI（桌面與手機同一套；可純瀏覽器 + mock 開發）
  desktop/    Electron shell：SSH/ssh2、加密憑證、telemetry、檔案操作、tmux
  mobile/     Capacitor Android shell
packages/
  contracts/      Zod schemas、PlatformBridge、IPC 協定（跨平台唯一事實來源）
  telemetry/      /proc/stat、free、nvidia-smi 解析
  tmux-runtime/   tmux session 管理、reconciliation、佈建
  adapter-claude/ Claude CLI stream-json → normalized events
  test-fixtures/  mock 檔案系統／PTY／telemetry／agent 資料
docs/           開發指南、教學、ADR、協定
lib/ 等          舊 Flutter 版（cutover 前保留，勿改）
```

架構鐵則（lint 強制）：`apps/app` 不得直接 import 任何平台 API——一律經由
`PlatformBridge`。這使桌面殼未來可整顆替換（Electron ⇄ Tauri）而不動 UI。

## 完整移除

CozyPad 只寫三個地方，全部可以清乾淨：

| 位置 | 內容 | 怎麼清 |
| --- | --- | --- |
| Windows 本機 | 程式本體 + `%APPDATA%\CozyPad`（連線設定、加密密碼、known hosts、快取） | 從「設定 → 應用程式」解除安裝即可，**app data 會一併刪除** |
| Android | app 私有資料 | 一般解除安裝即可（Android 保證清除私有目錄）；你主動下載的檔案留在 Downloads |
| 遠端主機 | `~/.cozypad/`（建置暫存與 log）、shell rc 與 `~/.tmux.conf` 的 CozyPad 管理區塊、（若由 CozyPad 安裝）`~/.local/bin/tmux` | **Settings → 移除與清理 → 清除**（可選是否一併移除 tmux）；只動 CozyPad 自己的區塊，不碰你其他設定 |

安裝 tmux 用的建置暫存（數百 MB）在安裝成功後會自動刪除，不需手動處理。

## 安全性

- 密碼經 Electron `safeStorage`（OS keychain）加密，永不進 renderer／log
- SSH host key 首次信任 + 變更警告（防中間人）
- Renderer 全程 sandbox + contextIsolation + 嚴格 CSP；IPC 雙向 Zod 驗證
- 不執行模型產生的任意 shell 字串（見 [ADR 0001](docs/adr/0001-solution-agent-bridge.md)）

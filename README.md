# CozyPad

**把手機／電腦連上遠端主機上的 coding agent 的工作站。**

CozyPad 讓你從 Windows 桌面或 Android 手機，透過 SSH 管理遠端 Linux 主機：
多分頁終端機、檔案瀏覽與編輯、CPU/GPU 監控，以及（開發中的）Claude Code /
Codex / agy 等 remote agent 的對話介面。Agent 全部跑在遠端 tmux 裡——關掉
app、斷線、換裝置，工作都不會中斷。

一套 **React + TypeScript** codebase，桌面包 **Electron**、Android 包
**Capacitor**；桌面安裝包約 100MB、Android release APK 約 7MB
（實際大小依版本與簽章而異）。

> 完整規格見 [SPEC.md](SPEC.md)；本 README 只講怎麼跑起來。

## 現在能用的功能

| 功能 | 狀態 |
| --- | --- |
| SSH 連線管理（密碼／SSH Key、OS 安全儲存、host key 驗證、斷線自動重連） | ✅ |
| 多分頁終端機（xterm.js、右鍵複製貼上、常用指令面板、手機 Termux 式按鍵列） | ✅ |
| 遠端檔案：類型圖示、symlink 跳轉、任意路徑導覽、下載保留原始檔名、右鍵／長按選單、兩段式複製搬移 | ✅ |
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
| UI 開發（瀏覽器熱更新） | `pnpm dev` → http://localhost:5173 |
| 桌面開發（Electron 熱更新，mock） | `pnpm dev:desktop` |
| 桌面開發（真 SSH） | `pnpm dev:desktop:ssh` |
| Android debug APK | `pnpm --filter @cozypad/mobile apk:debug`（需 Android SDK + JDK 21） |
| Android signed release APK | 設定簽章環境變數後執行 `pnpm --filter @cozypad/mobile apk` |
| 檢查 | `pnpm lint` / `pnpm typecheck` / `pnpm test` |

第一次連主機：右上 **⚙** 新增連線 → 選擇「密碼」或「SSH Key」→ Connect
→ 核對並確認 host key 指紋。關閉「以 OS 安全儲存保留驗證資料」時，憑證只保留
到本次 app 結束，期間仍可自動重連。

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
```

舊 Flutter 完整原始碼已封存在 Git tag `v1.0.2`；目前 `main` 不再需要 Flutter／Dart toolchain。

架構鐵則（lint 強制）：`apps/app` 不得直接 import 任何平台 API——一律經由
`PlatformBridge`。這使桌面殼未來可整顆替換（Electron ⇄ Tauri）而不動 UI。

## 完整移除

CozyPad 只寫三個地方，全部可以清乾淨：

| 位置 | 內容 | 怎麼清 |
| --- | --- | --- |
| Windows 本機 | 程式本體 + Electron user data（連線設定、加密憑證、known hosts、快取） | 從「設定 → 應用程式」解除安裝即可，**app data 會一併刪除** |
| Android | app 私有資料 | 一般解除安裝即可（Android 保證清除私有目錄）；你主動下載的檔案留在 `Downloads/CozyPad`（Android 7–9 則是儲存時選擇的位置） |
| 遠端主機 | `~/.cozypad/`（建置暫存與 log）、shell rc 與 `~/.tmux.conf` 的 CozyPad 管理區塊、（若由 CozyPad 安裝）`~/.local/bin/tmux` | **Settings → 移除與清理 → 清除**（可選是否一併移除 tmux）；只動 CozyPad 自己的區塊，不碰你其他設定 |

安裝 tmux 用的建置暫存（數百 MB）在安裝成功後會自動刪除，不需手動處理。

## 安全性

- Desktop 以 Electron `safeStorage` 加密整份連線 profile 與 host trust（包含名稱、
  host、port、username、密碼、私鑰與 passphrase），舊版明文 metadata 會在首次載入時
  原子遷移；Android 以 Android Keystore 管理的 AES-256-GCM 金鑰保護 profile secret
  與 host trust。儲存後不再把 secret 回傳 renderer／WebView
- 已記憶的憑證綁定 profile ID、host、port、username 與驗證方式，避免
  profile metadata 遭竄改後把憑證送往其他主機
- SSH host key 使用標準 OpenSSH `SHA256:` fingerprint；首次或變更時必須確認，
  已信任資料只由 privileged platform layer 管理
- Desktop 與 Android 僅協商現代 SSH 演算法；SHA-1、DSA、CBC、3DES、RC4 與 MD5
  不會為相容老舊伺服器而自動降級
- Renderer 全程 sandbox + contextIsolation + 嚴格 CSP；IPC 雙向 Zod 驗證
- 不執行模型產生的任意 shell 字串（見 [ADR 0001](docs/adr/0001-solution-agent-bridge.md)）

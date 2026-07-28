# CozyPad 產品與系統規格

| 欄位 | 內容 |
| --- | --- |
| 文件版本 | 1.0 |
| 對應應用程式版本 | `1.0.0+1` |
| 文件狀態 | 現況基準（As-Is Specification） |
| 最後更新 | 2026-07-28 |
| 主要平台 | Windows Desktop |

> 本文件依目前 repository 的程式碼、`README.md` 與 Hermes 設計文件整理。若文件與實作不一致，現階段以可執行程式碼為準，並應在同一個變更中更新本文件。

## 1. 產品摘要

CozyPad 是一套以 Flutter 開發的桌面應用程式，讓使用者從本機透過 SSH 管理遠端 Linux 主機與專案工作區。核心能力包含系統與 NVIDIA GPU 監控、遠端檔案操作、多分頁終端機、遠端任務管理，以及內嵌的 Dart-native Hermes Agent。

### 1.1 目標使用者

- 使用遠端 Linux 工作站或 GPU Server 的開發者與研究人員。
- 需要同時管理多個 SSH 連線、專案路徑與長時間工作階段的使用者。
- 希望在單一 Windows GUI 中整合監控、檔案、終端機與 LLM Agent 的使用者。

### 1.2 產品目標

- 降低遠端主機與 GPU 工作負載的日常管理成本。
- 讓連線、專案、codebase 路徑與工作階段可以持續保存並快速恢復。
- 由桌面應用程式持有 Agent harness、權限政策與 SSH 執行入口。
- 不要求使用者另外安裝 Python sidecar、Docker、WSL 或完整 Hermes Python runtime。

### 1.3 非目標

- 不取代完整 IDE 或 Git 平台。
- 不負責自動安裝 Git、Python、Conda、Docker、CUDA 等專案工具。
- 不以 Discord、Telegram、Slack 或 WhatsApp 等訊息 gateway 作為遠端控制入口。
- 現階段不承諾 Windows 以外平台的正式支援。

## 2. 支援環境

### 2.1 本機

- Windows Desktop 為主要開發、測試與發佈平台。
- Dart SDK：`>=3.0.0 <4.0.0`。
- 原始碼建置需要 Flutter stable 與 Visual Studio 2022 的 Desktop development with C++ workload。
- UI framework：Flutter Material。

### 2.2 遠端主機

- 可透過 SSH 連線的 Linux 主機。
- 目前登入方式為帳號與密碼，預設連接埠為 `22`。
- 基本功能依賴常見 POSIX/Linux 工具，例如 `bash`、`cat`、`ps`、`free`、`kill`、`cp`、`mv`、`rm` 與 `mkdir`。
- GPU 監控需要 NVIDIA 驅動提供的 `nvidia-smi`。
- Persistent session 需要 `tmux`；應用程式可建立或檢查 `~/.ssh_dashboard/` 輕量 runtime。

## 3. 主要使用流程

1. 使用者建立或選擇 SSH Connection Profile。
2. 使用者建立 Project，並將專案綁定至指定連線上的遠端 codebase 路徑。
3. 應用程式以密碼驗證建立 SSH 連線。
4. 連線成功後，使用者可切換 Hermes、Monitor、Files 與 SSH Terminal 工作區。
5. 應用程式定期更新 CPU、記憶體、GPU 與任務狀態。
6. 使用者可透過 Hermes 對話，由 Agent 在權限政策允許範圍內讀取儀表板狀態或操作遠端主機。
7. 需要持續執行的工作可放入應用程式管理的 `tmux` session，斷線後再重新連接。

## 4. 功能需求

### FR-01 連線管理

- 應用程式必須支援新增、編輯、刪除與選擇多個 Connection Profile。
- Profile 必須包含名稱、Host、Port、Username、Password 與自動登入設定。
- 同一時間最多只能有一個 Profile 被設定為自動登入。
- SSH 連線逾時時間目前為 12 秒，keep-alive 間隔為 10 秒。
- 應用程式必須提供連線、重新連線與中斷連線操作。
- 連線失敗時必須顯示錯誤，並清除未完成的連線狀態。

### FR-02 專案與 codebase 管理

- 應用程式必須支援新增、編輯、刪除與選擇 Project。
- Project 必須保存名稱、說明、建立時間、各 Connection 的 codebase 路徑狀態及搬遷紀錄。
- 使用者必須能登記現有遠端 codebase 路徑。
- 使用者可登記從其他 Connection 搬遷至目前 Connection 的來源與目標路徑。
- 搬遷登記目前只建立狀態與歷史紀錄；實際檔案同步需由使用者或 Hermes 另行執行。

### FR-03 系統與 GPU 監控

- 連線後，應用程式必須顯示整體及各核心 CPU 使用率。
- 應用程式必須顯示記憶體使用量。
- 遠端主機提供 `nvidia-smi` 時，應用程式必須顯示：
  - GPU index、UUID 與名稱。
  - GPU 使用率。
  - 顯示記憶體已用量與總量。
  - 溫度。
  - GPU process 的 PID、使用者、執行時間、命令與顯示記憶體用量。
- 監控資料預設每 5 秒更新一次，並允許手動刷新。
- 未安裝或無法執行 `nvidia-smi` 時，不得阻止其他功能使用。

### FR-04 遠端檔案工作區

- 應用程式必須能列出及導覽遠端目錄。
- 使用者必須能建立檔案與資料夾。
- 使用者必須能重新命名、複製、移動、建立副本及刪除遠端項目。
- 使用者必須能複製檔名、絕對路徑及相對路徑。
- 支援的 inline preview 類型包含：
  - 純文字與原始碼。
  - Markdown。
  - 圖片。
  - 影片。
  - CSV、TSV 與 Excel spreadsheet。
  - PDF。
- 純文字、Markdown、CSV 與 TSV 必須可編輯並儲存回遠端。
- 有未儲存變更時，離開目前檔案前必須要求確認。
- 不支援的二進位格式必須顯示不可預覽訊息，不得嘗試以文字解碼。

### FR-05 SSH Terminal

- 應用程式必須提供互動式 SSH PTY terminal。
- 使用者必須能開啟並切換多個 terminal 分頁。
- Terminal 必須支援鍵盤輸入、IME 與目前平台對應的 xterm 行為。
- SSH 中斷時，終端機不得繼續送出遠端輸入。

### FR-06 任務管理

- 應用程式必須保存遠端任務清單及其執行狀態。
- 使用者必須能新增、啟動、取消與刪除任務。
- 執行中的任務必須保存遠端 PID，取消時嘗試終止該程序。
- Hermes 工作區必須能以 To Do、In Progress 與 Done 呈現任務。
- Hermes 的任務啟動與取消屬高風險遠端操作，必須通過權限政策。

### FR-07 Hermes Agent

- Hermes harness 必須以 Dart 原生方式內嵌於應用程式。
- 應用程式負責 LLM provider 呼叫、session、memory、tool registry、權限政策與 observation loop。
- 必須支援 Google Generative Language API 與 OpenAI-compatible `/chat/completions` API。
- 內建 provider profile 可涵蓋 Google AI Studio、OpenAI、Anthropic、Ollama 與 DeepSeek；實際相容性仍取決於 endpoint 是否符合目前 client 支援的 request/response 格式。
- 使用者必須能設定及切換 Base URL、Model 與 API Key。
- Agent 必須能保存並切換本機 session。
- Agent 必須有重複工具呼叫與單回合工具預算保護。
- Agent 必須能使用下列工具類別：
  - 儀表板狀態：`dashboard.context`、`gpu.snapshot`、`task.list`。
  - 遠端唯讀：`file.list`、`file.read_text`、`ssh.run_readonly`。
  - 遠端變更：`ssh.run_approved`、`file.write_text`、`task.launch`、`task.cancel`。
  - Persistent runtime：`remote.bootstrap` 與 `remote.tmux.*`。
  - 本機狀態：`memory`、`skill.list`、`skill.read`、`session.search`。

### FR-08 Persistent tmux control plane

- 應用程式必須能 bootstrap 或檢查 `~/.ssh_dashboard/`。
- 應用程式管理的 tmux session 名稱必須使用 `sdh_` prefix。
- 必須支援列出、啟動／接續、送出輸入、擷取畫面及停止 session。
- tmux session 必須在本機應用程式斷線後繼續存在。
- 遠端 package 安裝、危險命令與停止 session 必須取得明確核准。

### FR-09 本機設定與顯示

- 應用程式必須提供深色／淺色主題選擇。
- 介面縮放範圍必須為 50% 至 200%。
- 必須支援 `Ctrl+=` 放大、`Ctrl+-` 縮小及 `Ctrl+0` 重設。
- Theme、zoom、連線、專案與 API profile 設定必須可跨啟動保存。

## 5. 資料與儲存

| 資料 | 儲存方式 | 備註 |
| --- | --- | --- |
| Connection Profiles | `flutter_secure_storage` | 目前 Profile JSON 內含密碼，因此整份資料必須留在安全儲存區。 |
| Legacy 單一連線憑證 | `flutter_secure_storage` | 為向後相容保留。 |
| Theme、zoom、全域 API Key | `flutter_secure_storage` | API Key 不得寫入一般設定 JSON。 |
| Hermes provider API Keys | `flutter_secure_storage` | 每個 provider profile 分開保存。 |
| Projects 與 codebase 狀態 | `flutter_secure_storage` | JSON 編碼。 |
| Hermes sessions | 本機 JSON 檔 | Windows 預設位於 `%APPDATA%\cozypad_hermes\sessions\...`。 |
| Hermes memory | 本機 Markdown 檔 | 使用 `MEMORY.md`、`USER.md` 等有限大小的 memory store。 |
| Remote runtime | 遠端 `~/.ssh_dashboard/` | 包含 logs、sessions、tmux metadata、skills 與 tools。 |

## 6. 安全與權限需求

- 密碼與 API Key 不得顯示為明文或寫入一般設定檔、log 與 Agent prompt。
- Hermes 遠端工具必須可由設定全域停用。
- 唯讀 SSH 命令只允許政策所列的狹義命令集合；無法判定為唯讀時必須拒絕。
- 寫檔、啟動／取消任務、核准型 shell command 與停止 tmux session 必須帶有明確 approval。
- 刪除遠端檔案等不可逆 UI 操作必須先顯示確認。
- Remote runtime 目錄應使用只限帳號本人的權限（例如 `chmod 700`）。

### 6.1 已知安全缺口

- 尚未提供 SSH private key 登入。
- 尚未定義或實作可由使用者檢視與核准的 SSH host key 驗證流程。
- Hermes 的完整 mutating-tool approval UI 尚未完成；未核准操作應維持封鎖。

## 7. 非功能需求

### NFR-01 可用性

- SSH 連線、檔案載入、監控刷新、LLM 回應與遠端命令不得長時間阻塞 Flutter UI thread。
- 長時間操作必須呈現 loading、streaming、success 或 error 狀態。
- 功能在遠端依賴不存在時應局部降級，不應造成整個應用程式崩潰。

### NFR-02 可維護性

- `SPEC.md` 為產品／系統現況的規格入口。
- 安裝與操作方式留在 `README.md`。
- Hermes 實作決策與重構歷史保留在 `lib/HERMES_*.md` 與 `lib/README_REFACTOR.md`。
- 新功能應以可識別的 requirement ID 更新本文件，並新增相對應測試。

### NFR-03 相容性

- Windows Desktop 為 release gate。
- 遠端命令以一般 Linux 環境為基準；不同 shell、BSD userland 或受限帳號可能不相容。
- 本機套件 `packages/xterm` 透過 `dependency_overrides` 取代 pub.dev 版本，建置時不得遺漏。

## 8. 現況與限制

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| SSH 密碼連線與 Profile | 已實作 | 使用 `dartssh2` 與 secure storage。 |
| CPU／Memory／NVIDIA GPU 監控 | 已實作 | 5 秒輪詢；GPU 功能依賴 `nvidia-smi`。 |
| 遠端 Files 與多格式預覽 | 已實作 | 大型或不支援格式會降級處理。 |
| 多分頁 SSH Terminal | 已實作 | 使用本機覆寫的 xterm package。 |
| Project/codebase 狀態 | 已實作 | 實際跨主機同步不是自動流程。 |
| Dart-native Hermes harness | MVP | 不含官方 Hermes Python skills、scheduler 或 gateways。 |
| Persistent tmux | 已實作 | 遠端需安裝 `tmux`。 |
| Hermes approval UI | 未完成 | 高風險操作由 policy 封鎖或要求 approval 參數。 |
| Session database | 未實作 | 目前使用 JSON，不是 SQLite。 |
| SSH private key／host key UI | 未實作 | 正式對外使用前應優先補齊。 |
| 非 Windows 正式支援 | 未承諾 | Flutter scaffolding 存在，但不是目前 release gate。 |

## 9. 最低驗收條件

一次可發佈的 Windows build 至少必須通過：

1. `flutter pub get` 成功。
2. `flutter analyze` 無阻斷發佈的錯誤。
3. `flutter test` 通過。
4. `flutter build windows` 成功產生完整 Release 資料夾。
5. 使用測試 Linux 主機完成 SSH 連線、斷線與錯誤情境。
6. 驗證 CPU、Memory 與「有／無 NVIDIA GPU」兩種監控情境。
7. 驗證遠端檔案建立、讀取、修改、複製、移動與刪除。
8. 驗證至少兩個 terminal 分頁可獨立互動。
9. 驗證 Hermes 的唯讀工具可執行、未核准的高風險工具會被封鎖。
10. 驗證 tmux session 可在應用程式中斷 SSH 後存活並於重連後擷取。
11. 驗證重新啟動應用程式後，非暫態設定與 session 可正確恢復。

## 10. 相關文件

- `README.md`：安裝、建置與首次使用指南。
- `lib/HERMES_HARNESS_MVP.md`：Dart-native Hermes harness MVP 範圍。
- `lib/HERMES_DART_REBUILD_REMOTE_TMUX.md`：remote tmux control plane 決策。
- `lib/README_REFACTOR.md`：UI 與 `lib/` 重構說明。


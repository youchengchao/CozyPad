# CozyPad

CozyPad 是一套以 Flutter 開發的 Windows 桌面工具，用來透過 SSH 管理遠端 Linux 主機與專案工作區。

主要功能包括：

- SSH 連線管理
- CPU、記憶體與 NVIDIA GPU 監控
- 遠端檔案瀏覽與編輯
- 多分頁 SSH Terminal
- GPU-aware 任務管理
- Dart-native Hermes Agent
- Persistent `tmux` session

> [!NOTE]
> CozyPad 目前仍是早期版本，主要支援與測試平台為 **Windows Desktop**。

---

## 安裝方式

你可以選擇以下其中一種方式：

| 方式 | 適合對象 | 需要 Flutter |
| --- | --- | --- |
| [方式一：下載作者提供的執行檔](#方式一下載作者提供的執行檔) | 一般使用者 | 否 |
| [方式二：Clone Repository 並自行編譯](#方式二clone-repository-並自行編譯) | 開發者 | 是 |

---

# 方式一：下載作者提供的執行檔

這個方式不需要安裝 Flutter、Dart 或 Visual Studio。

## 1. 下載 Windows 版本

請從作者提供的下載連結，或本專案的 [GitHub Releases](https://github.com/youchengchao/CozyPad/releases) 頁面下載 Windows 壓縮檔。

## 2. 解壓縮完整資料夾

將 `.zip` 完整解壓縮，例如：

```text
C:\Tools\CozyPad\
```

資料夾內應包含：

```text
ssh_dashboard.exe
flutter_windows.dll
其他 DLL
data\
```

> [!IMPORTANT]
> 不要只取出 `ssh_dashboard.exe`。
>
> `.exe`、DLL 與 `data` 資料夾必須放在一起，程式才能正常啟動。

## 3. 啟動程式

雙擊：

```text
ssh_dashboard.exe
```

即可啟動 CozyPad。

## 4. Windows SmartScreen

若執行檔尚未經過程式碼簽章，Windows 可能顯示：

```text
Windows 已保護您的電腦
```

請先確認檔案來自本專案作者或可信任的 GitHub Releases，再執行：

1. 點選「其他資訊」。
2. 確認檔案名稱。
3. 點選「仍要執行」。

也可以在解壓縮前，對 `.zip` 按右鍵：

```text
內容 → 解除封鎖 → 套用
```

---

# 方式二：Clone Repository 並自行編譯

這個方式適合希望檢查程式碼、修改功能或自行產生執行檔的使用者。

## 1. 安裝必要工具

### Git

```bash
git --version
```

### Flutter SDK

安裝 Flutter stable channel，並將 Flutter 加入系統環境變數。

本專案使用的 Dart SDK 範圍為：

```text
>=3.0.0 <4.0.0
```

### Visual Studio 2022

安裝 Visual Studio 2022，並勾選以下 workload：

```text
Desktop development with C++
使用 C++ 的桌面開發
```

### 檢查環境

```bash
flutter doctor
```

請確認 Flutter、Windows Version、Visual Studio 與 Windows toolchain 沒有阻止建置的錯誤。

必要時啟用 Windows Desktop：

```bash
flutter config --enable-windows-desktop
```

## 2. Clone Repository

```bash
git clone https://github.com/youchengchao/CozyPad.git
cd CozyPad
```

## 3. 安裝 Flutter Dependencies

```bash
flutter pub get
```

`pubspec.yaml` 內的 Dart／Flutter packages 會自動安裝，不需要逐一手動下載。

## 4. 檢查程式碼

```bash
flutter analyze
```

## 5. Debug 執行

```bash
flutter run -d windows
```

## 6. 編譯 Release

```bash
flutter build windows
```

編譯結果通常位於：

```text
build\windows\x64\runner\Release\
```

若要將程式提供給其他使用者，請壓縮整個 `Release` 資料夾：

```text
Release\
├─ ssh_dashboard.exe
├─ flutter_windows.dll
├─ 其他 DLL
└─ data\
```

不要只複製 `.exe`。

## 建置問題排除

可以依序執行：

```bash
flutter clean
flutter pub get
flutter analyze
flutter build windows
```

若 `flutter doctor` 顯示 Visual Studio 或 Windows toolchain 不完整，請回到 Visual Studio Installer，確認已安裝「使用 C++ 的桌面開發」。

---

# 遠端主機需要哪些工具

CozyPad 會透過 SSH 在遠端主機執行監控、檔案與任務操作。

## 基本需求

遠端主機建議為 Linux，並具備：

- SSH Server
- 可使用的帳號與密碼
- `bash`
- 可寫入的使用者家目錄
- 常見 Linux 指令：
  - `cat`
  - `ps`
  - `free`
  - `kill`
  - `nohup`
  - `cp`
  - `mv`
  - `rm`
  - `mkdir`

> [!NOTE]
> 目前 Connection Profile 使用帳號密碼登入，尚未實作 SSH private key 登入。

## NVIDIA GPU 監控

要顯示 GPU 使用率、顯示記憶體、溫度與 GPU process，遠端主機需要：

```bash
nvidia-smi
```

確認方式：

```bash
nvidia-smi
```

沒有 NVIDIA GPU 或 `nvidia-smi` 時，SSH、Files 與 Terminal 等其他功能仍可使用。

## Persistent Session

要使用中斷 App 後仍能持續執行的遠端 session，需要安裝：

```bash
tmux
```

Ubuntu／Debian：

```bash
sudo apt update
sudo apt install tmux
```

Rocky Linux／RHEL／Fedora：

```bash
sudo dnf install tmux
```

## 專案環境

依實際專案需求，遠端主機可能還需要：

- Git
- Python
- Conda
- Docker
- CUDA
- Node.js
- 其他 CLI 或訓練工具

CozyPad 不會自動建立 these 專案環境。

---

# 第一次使用

## 1. 新增 SSH Connection

在 CozyPad 中新增連線並填入：

- Connection 名稱
- Host 或 IP
- Port，預設為 `22`
- Username
- Password
- 是否自動登入

連線資料會透過 `flutter_secure_storage` 儲存在本機。

## 2. 建立 Project

Project 用來表示一個邏輯上的專案，並記錄它在不同遠端主機上的 codebase 路徑。

例如：

```text
Project: Deepfake Localization
Server A: ~/projects/TRACE
Server B: /data2/user/TRACE
```

## 3. 連線到遠端主機

選擇已建立的 Connection 並連線。

成功連線後即可使用：

- Monitor
- Files
- Terminal

## 4. 登記 Codebase 路徑

選擇 Project 後，登記該專案在目前主機上的路徑：

```text
~/projects/CozyPad
```

完成後即可進入 Hermes Workspace。

> [!IMPORTANT]
> Project Transfer 目前會記錄來源主機、目標主機、路徑與搬遷歷史。
>
> 它不會自動複製整份 codebase。實際同步仍需使用 Git、`rsync`、Files、Terminal 或 Hermes 完成。

## 5. 設定 Hermes

要使用 Hermes Agent，請在設定頁面填入：

- LLM Base URL
- Model
- API Key
- Hermes Home
- Remote-tool permissions
- Approval policies

目前程式實作支援：

- Google Generative Language API
- OpenAI-compatible `/chat/completions` API

例如本機 Ollama：

```text
http://localhost:11434/v1
```

請使用你的帳號或本機服務目前實際可用的 Model。

API Key 會另外存入本機 secure storage。

---

# 使用提醒

- CozyPad 目前主要以 Windows Desktop 為目標。
- 遠端監控主要假設 Linux 環境。
- SSH private key 登入尚未實作。
- Remote Files 的刪除與覆寫會直接修改遠端主機。
- Hermes 執行檔案寫入、程序終止或任務啟動前，請再次確認主機、路徑與指令。
- 使用雲端 LLM 時，對話與相關內容會傳送到你設定的 API endpoint。
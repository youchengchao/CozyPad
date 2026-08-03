# CozyPad V3 開發指南（本機版）

> 這份文件刻意不納入版本控制。指令以 Windows PowerShell 為主，所有機器相關路徑都使用環境變數或 placeholder。

## 1. 架構總覽

CozyPad V3 是 pnpm monorepo。桌面版與 Android 版共用同一套 React UI，平台能力統一透過 `PlatformBridge` 暴露。

```text
apps/app（React + Vite）
        │
        └── getBridge()
              ├── Electron preload → IPC → ssh2 / safeStorage credential vault
              ├── Capacitor bridge → Kotlin plugin → sshj / Android Keystore vault
              └── Browser mock → test-fixtures

packages/contracts        PlatformBridge、Zod schema、IPC channel
packages/remote-services  遠端檔案、telemetry、tmux 安裝與設定
packages/tmux-runtime     tmux session/runtime
packages/telemetry        Linux CPU、RAM、GPU 指標解析
packages/adapter-claude   Claude stream-json 轉換
packages/test-fixtures    mock terminal、檔案、telemetry、agent 資料
```

重要邊界：

- `apps/app` 不應直接 import Electron、Capacitor、`ssh2` 或 Node API。
- 跨平台功能先定義在 `packages/contracts` 的 `PlatformBridge`，再補 Electron、Capacitor 與 mock 實作。
- Electron renderer 與 main 的 IPC 輸入輸出都要經過 Zod 驗證。
- Terminal 資料以 base64 傳遞，保持 binary-safe。
- 手機 WebView 沒有 raw TCP；SSH 必須走 `SshPlugin.kt`。

## 2. 環境需求

一般 UI／桌面開發：

- Git
- Node.js LTS
- pnpm `11.17.0`（根目錄 `package.json` 已指定）

Android 另外需要：

- JDK 21
- Android SDK Platform 36
- Android SDK Platform Tools
- 相容的 Android Build Tools
- USB 驅動（Windows 需要，依手機廠牌而定）

PowerShell 若因 execution policy 無法執行 `pnpm.ps1`，直接使用 `pnpm.cmd`。

```powershell
corepack enable
corepack prepare pnpm@11.17.0 --activate
pnpm.cmd install
```

Android 環境建議只設在使用者環境或目前 shell，不要把絕對路徑寫進 repository：

```powershell
$env:JAVA_HOME = "<JDK 21 路徑>"
$env:ANDROID_HOME = "<Android SDK 路徑>"
$env:Path = "$env:ANDROID_HOME\platform-tools;$env:Path"
```

也可在 `apps/mobile/android/local.properties` 設定 SDK；該檔已被忽略，不可提交。

## 3. 日常開發

### 瀏覽器 mock

```powershell
pnpm.cmd dev
```

開啟 `http://localhost:5173`。這是 UI 開發最快的模式，內建假 terminal、檔案與 telemetry；存檔後由 Vite HMR 自動更新。

### Electron mock

```powershell
pnpm.cmd dev:desktop
```

這會同時啟動 Vite 與 Electron，預設使用 mock transport，可驗證 preload、IPC 和桌面視窗行為。

### Electron 真實 SSH

```powershell
pnpm.cmd dev:desktop:ssh
```

也可以用一次性環境變數建立初始 profile；不要把密碼寫進 script 或 commit：

```powershell
$env:COZYPAD_SSH_HOST = "<host>"
$env:COZYPAD_SSH_PORT = "22"
$env:COZYPAD_SSH_USER = "<user>"
$env:COZYPAD_SSH_PASSWORD = "<temporary password>"
pnpm.cmd dev:desktop:ssh
Remove-Item Env:COZYPAD_SSH_PASSWORD
```

桌面端 profile 與 host trust 存在 Electron 的 `app.getPath('userData')`，整份內容
（名稱、host、port、username、credential 與 fingerprint）由 `safeStorage` 加密；
舊版明文 `profiles.json`／`known_hosts.json` 會自動原子遷移。Renderer 只能送入新
credential，profile list 只取得是否已有 credential，不能讀回內容。Host、port、
username 或 auth method 改變時會清除舊 credential，避免把 secret 轉送到不同 target。
不要在程式碼中拼接固定的 `%APPDATA%`、磁碟代號或使用者名稱。

## 4. Android 建置與真機測試

### 產生 debug APK

```powershell
pnpm.cmd --filter @cozypad/mobile apk:debug
```

這個指令會：

1. build 共用 React app。
2. 執行 Capacitor Android sync。
3. 由 Gradle 組出 debug APK。

產物：

```text
apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

只測 Kotlin 原生層時可以縮短迴圈：

```powershell
Push-Location apps/mobile/android
.\gradlew.bat :app:testDebugUnitTest
.\gradlew.bat :app:assembleDebug
.\gradlew.bat :app:assembleRelease
Pop-Location
```

### 安裝與啟動

手機先開啟開發人員選項與 USB 偵錯：

```powershell
$adbPath = "$env:ANDROID_HOME\platform-tools\adb.exe"
& $adbPath devices -l
& $adbPath install -r "apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
& $adbPath shell monkey -p com.cozypad.app -c android.intent.category.LAUNCHER 1
```

`install -r` 會保留現有 app data，適合重複測試既有連線 profile。若裝置顯示 `unauthorized`，解鎖手機並接受 RSA 偵錯授權。

### 手機即時 HMR

只改 React/CSS 時不需要每次重編 APK：

1. 執行 `pnpm.cmd dev`。
2. 建立 USB reverse：

   ```powershell
   & $adbPath reverse tcp:5173 tcp:5173
   ```

3. 暫時在 `apps/mobile/capacitor.config.json` 加入：

   ```json
   "server": {
     "url": "http://localhost:5173",
     "cleartext": true
   }
   ```

4. 重新執行一次 `apk:debug` 並安裝。
5. 此後修改 React/CSS，手機 WebView 會直接 HMR。

測完一定要移除 `server` 區塊並重新 sync；它是本機開發設定，不應出現在 commit 或 release APK。

```powershell
& $adbPath reverse --remove tcp:5173
```

若改到以下內容，仍需重編並重裝 APK：

- Kotlin plugin
- Gradle dependencies
- Android Manifest、resource 或 plugin registration
- Capacitor native 設定

檔案下載屬於原生能力：Android 10+ 透過 `MediaStore.Downloads` 寫入
`Downloads/CozyPad`，Android 7–9 使用 `ACTION_CREATE_DOCUMENT`。不得退回 WebView
blob download，也不得新增 `WRITE_EXTERNAL_STORAGE`／檔案管理權限。重裝後至少測試
無副檔名、未知副檔名、PDF 與 binary 檔案，並以 SHA-256 核對遠端與手機內容一致。

### 讓手機經 USB 連到電腦的 SSH

這和 WebView HMR 是兩條獨立通道。先確認 Windows 的 OpenSSH Server 確實在監聽：

```powershell
Get-Service sshd
Get-NetTCPConnection -LocalPort 22 -State Listen
```

確認有 listener 後：

```powershell
& $adbPath reverse tcp:2222 tcp:22
```

手機 CozyPad profile 使用：

```text
host: 127.0.0.1
port: 2222
username: 電腦上的 SSH 帳號
auth: 該帳號的密碼，或已加入 Windows OpenSSH `authorized_keys` 的 private key
```

測完移除：

```powershell
& $adbPath reverse --remove tcp:2222
```

若 Windows 沒有 `sshd` service 或 port 22 listener，ADB reverse 本身成功也無法 SSH。

## 5. 平台功能修改方式

### 共用 UI

主要位置：

- `apps/app/src/App.tsx`
- `apps/app/src/workspaces/`
- `apps/app/src/components/`
- `apps/app/src/styles.css`

UI 只呼叫 `getBridge()` 取得能力，不直接判斷作業系統。

### 新增跨平台能力

建議順序：

1. 在 `packages/contracts` 增加 request、response、event schema 和 `PlatformBridge` method。
2. 在 Electron preload 與 main IPC 實作。
3. 在 Capacitor bridge 與 Kotlin plugin 實作。
4. 在 browser mock 補可離線運作的行為。
5. 補 contracts、desktop、app 與 Android 測試。

漏掉 mock 實作通常會讓 `pnpm dev` 先壞；漏掉 Capacitor 實作則只會在真機才出現。

### Android SSH

呼叫路徑：

```text
React → capacitorBridge.ts → CozyPadSsh plugin
      → SshCredentialVault / SshHostKeyStore
      → SshPlugin.kt → sshj
```

Profile metadata 可留在 WebView storage，但密碼、private key、passphrase 與 host trust
不可留在其中：

- `configureCredential` 是單向輸入；後續 `load`／`connect` 不得把 secret 回傳 WebView。
- 持久 credential 由 Android Keystore 管理的 AES-256-GCM 金鑰加密，並以 profile ID、
  host、port、username、auth method 綁定。
- 不記憶的 credential 只放在 native process memory，讓同次執行仍可重連。
- 舊 secure-preferences credential 與 known hosts 由 native migration 搬移；成功才刪除
  舊 secret，失敗時保留以便重試。
- Host key 採標準 OpenSSH `SHA256:` fingerprint；WebView 只能回應當次 prompt，
  不能列舉、預先寫入或覆寫 trust store。
- `SshSecurityPolicy` 採安全白名單，禁止 SHA-1、DSA、CBC、3DES、RC4 與 MD5。

Android 系統可能預先註冊名為 `BC` 的舊 Bouncy Castle provider。`SshPlugin.connect()` 必須在建立 sshj `DefaultConfig` 前呼叫 `SshCryptoProvider.ensureInstalled()`，否則 X25519 key exchange 可能出現：

```text
no such algorithm: X25519 for provider BC
```

只升級 Gradle 的 `bcprov` 依賴不夠，因為 sshj 會依 provider 名稱查找。修改這段時
至少執行 `:app:testDebugUnitTest`、`assembleDebug`、`assembleRelease`，以及一次
密碼與一次 private-key 實機 SSH handshake。

## 6. 驗證清單

一般 commit 前：

```powershell
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
```

Electron：

```powershell
pnpm.cmd --filter @cozypad/app build
pnpm.cmd --filter @cozypad/desktop smoke
```

Android：

```powershell
Push-Location apps/mobile/android
.\gradlew.bat :app:testDebugUnitTest
.\gradlew.bat :app:assembleDebug
Pop-Location
```

真機 smoke test 至少確認：

- 密碼、未加密 private key、加密 private key 都可建立連線。
- 首次 host key 可核對並接受；fingerprint 變更、拒絕或提示逾時都會中止連線。
- 關閉 credential 記憶後，同次執行可自動重連，完全關閉 app 後會重新要求輸入。
- 非手動斷線會顯示倒數並自動重連；手動斷線不應自動連回。
- Terminal 可收發輸入。
- Files 可瀏覽、開啟、返回與切換目錄。
- PDF 可點擊縮放，不 crash。
- app 切到背景再回前景後，連線狀態正確。
- logcat 無 `AndroidRuntime`、`FATAL EXCEPTION`、`SSHRuntimeException` 或 X25519 錯誤。

抓取目前程序 log：

```powershell
$pidText = (& $adbPath shell pidof com.cozypad.app).Trim()
& $adbPath logcat --pid=$pidText
```

## 7. 打包與發布

### Windows

正式 package 必須提供 code-signing certificate，缺少任一變數會拒絕建置：

```powershell
$env:CSC_LINK = "<certificate path or encoded certificate>"
$env:CSC_KEY_PASSWORD = "<CI or local secret>"
pnpm.cmd --filter @cozypad/app build
pnpm.cmd --filter @cozypad/desktop package
```

產物在 `apps/desktop/release/`。`package:unsigned` 預設只供本機驗證；只有產品負責人
明確核准的內部原型 prerelease 才可上傳，且檔名與 release notes 必須標示 `Internal`、
unsigned 與 SHA-256，不得標成正式或 latest。
打包前關閉正在執行的 CozyPad 與舊 installer，避免 Windows 鎖住輸出檔造成 `EBUSY`。

### Android

正式 `apk` 必須提供四個簽章環境變數，缺少任一變數會拒絕建置：

```powershell
$env:COZYPAD_ANDROID_KEYSTORE = "<keystore path>"
$env:COZYPAD_ANDROID_STORE_PASSWORD = "<CI or local secret>"
$env:COZYPAD_ANDROID_KEY_ALIAS = "<key alias>"
$env:COZYPAD_ANDROID_KEY_PASSWORD = "<CI or local secret>"
pnpm.cmd --filter @cozypad/mobile apk
```

正式產物為 `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`。
`apk:debug` 用於真機開發；`apk:release:unsigned` 只供 R8／manifest 驗證。只有產品
負責人明確核准的內部原型 prerelease 才可附 debug-signed APK，且必須標示 `Internal`、
簽章狀態與 SHA-256。Keystore、certificate 與密碼只能放在本機環境或 CI secrets。

### Release checklist

1. `git status --short` 確認沒有 credentials、SDK 路徑、live-reload server URL、keystore 或暫存輸出。
2. 依改動範圍跑測試；Android 原生改動一定要實機 handshake。
3. 先 commit 並 push branch。
4. 正式發行用 signed build；核准的內部原型 prerelease 依上述規則清楚標示。
5. 建立 annotated tag，例如 `vX.Y.Z-alpha`，再 push tag。
6. 建 GitHub prerelease 並上傳必要資產。
7. 下載或檢查遠端 asset，核對 SHA-256、簽章與 release 指向的 commit。

Android-only 修正只需發 APK；共用 UI 或桌面端改動則應同時重建 Windows installer。

## 8. 不可提交的內容

- `.env`、密碼、token、私鑰與主機連線資料
- `apps/mobile/android/local.properties`
- `*.jks`、`*.keystore` 與 signing password
- 帶有 `server.url` 的本機 Capacitor live-reload 設定
- 使用者名稱、磁碟代號或 SDK/JDK 絕對路徑
- APK、installer、log、Gradle build output
- graphify 產物，除非團隊明確決定要版控

提交前用這兩個指令分別檢查工作樹與實際 staged 範圍：

```powershell
git status --short
git diff --cached --name-only
```

## 9. 常見問題

### `pnpm.ps1 cannot be loaded`

使用 `pnpm.cmd`，不需要放寬整台電腦的 PowerShell execution policy。

### `JAVA_HOME is not set`

確認 `JAVA_HOME` 指向 JDK 21 根目錄，而且該目錄下存在 `bin\java.exe`。

### `adb` 找不到裝置

重新插拔 USB、切換為資料傳輸模式、解鎖手機並重授權 USB 偵錯；再執行 `adb kill-server`、`adb start-server`。

### `no such algorithm: X25519 for provider BC`

確認 APK 包含目前的 `bcprov-jdk18on`，且 `SshCryptoProvider.ensureInstalled()` 在 sshj `DefaultConfig` 前執行。跑 Android unit test 後重建、重裝 APK，不要只更新 web assets。

### 手機 live reload 是空白頁

確認 Vite 正在 5173、`adb reverse --list` 有對應規則，並確認暫時的 `server.url` 是 `http://localhost:5173`。測完移除該設定。

### Electron 打包出現 `EBUSY`

關閉 CozyPad、installer、檔案總管預覽與可能掃描輸出資料夾的程序，再重試；不要用 hard reset 或刪除未確認的工作樹檔案。

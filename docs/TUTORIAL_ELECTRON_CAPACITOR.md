# Tutorial: Electron + Capacitor app development

**前情提要：CozyPad V3 = 一套 React code，桌面包 Electron、Android 包 Capacitor。**
**日常開發 99% 在瀏覽器和 Electron，手機只在需要真機手感和發版時碰。**

## 0. 從零安裝（新電腦一次性）

### 0.1 桌面開發（人人必裝，約 10 分鐘）

1. 安裝 [Git](https://git-scm.com/) 與 [Node.js LTS](https://nodejs.org/)（或 `winget install OpenJS.NodeJS.LTS`）
2. 裝 pnpm：`npm install -g pnpm`
3. Clone repo 後在根目錄：`pnpm install`
4. 驗證環境：`pnpm test`（全綠即完成）

**不需要** Flutter、Dart、Rust、Visual Studio、Android Studio。

### 0.2 Android 建置（只有要編 APK 的人裝）

1. Android SDK：任一位置解壓 cmdline-tools，安裝
   `platforms;android-36`、相容的 Build Tools、`platform-tools`
2. JDK 21（Temurin zip 版免安裝程式，解壓即可）
3. 設環境變數；只放在本機或 CI，不要提交絕對路徑：
   ```
   ANDROID_HOME=<Android SDK 路徑>
   JAVA_HOME=<JDK 21 路徑>
   ```
4. 驗證：`adb devices` 跑得動即可（`%ANDROID_HOME%\platform-tools\adb.exe`）

## 1. 日常 routine（每天的迴圈）

1. `pnpm dev` → 瀏覽器開 http://localhost:5173
   - **改 code 存檔即時熱更新**（等同 flutter hot reload，還不用按 r）
   - mock 模式內建假主機，不需要連任何真機
   - 手機版面：F12 → 裝置模擬（Ctrl+Shift+M）選 Pixel 尺寸——**手機 UI 開發九成在這裡完成**
2. 要看完整桌面 app：`pnpm dev:desktop`（UI 改動同樣熱更新；改到 `apps/desktop/src` 的 main/preload 才需要重啟）
3. Commit 前必跑：`pnpm lint && pnpm typecheck && pnpm test`
4. 桌面自動驗收：`pnpm --filter @cozypad/desktop smoke`（Electron 啟動＋IPC 往返，exit 0 即過）

平常使用（非開發）：雙擊根目錄 `CozyPad.bat`（真 SSH）或 `CozyPad-Demo.bat`（假主機）。

## 2. Android 真機測試

### 2.1 手機準備（同 Flutter 流程）

1. 手機開啟開發人員選項 + **USB 偵錯**
2. USB 接上電腦，`adb devices` 確認看得到（等同 `flutter devices`）
   - 不需要 USB 網路共用

### 2.2 Live reload（裝一次殼，之後改 code 免重編）

1. 電腦跑 `pnpm dev`
2. USB 模式：`adb reverse tcp:5173 tcp:5173`（讓手機的 localhost:5173 通到電腦；WiFi 同網段則改用電腦區網 IP 並以 `pnpm dev -- --host` 對外開放）
3. `apps/mobile/capacitor.config.json` 暫時加上：
   ```json
   "server": { "url": "http://localhost:5173", "cleartext": true }
   ```
4. `pnpm --filter @cozypad/mobile apk:debug` 編一次殼 → `adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`
5. 之後改 code 存檔，**手機畫面直接熱更新，不用重編 APK**
6. 測完把 `server` 設定拿掉（不要 commit）

只有動到原生層（新增 Capacitor plugin、改 Android 專案設定）才需要重跑步驟 4。

### 2.3 Debug APK（真機開發／離線驗證）

```
pnpm --filter @cozypad/mobile apk:debug
```
產物：`apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`
（debug 版含除錯資訊，會明顯大於 release）
安裝：`adb install -r <apk路徑>`，或傳檔到手機點開。

### 2.4 SSH 密碼與 Key 測試

在連線管理新增 profile，選擇「密碼」或「SSH Key」。Private key 可貼上或選檔；
加密 key 另填 passphrase。第一次連線要核對 OpenSSH `SHA256:` host-key
fingerprint；若 fingerprint 變更，先在主機端確認原因，不要直接接受。

關閉「以 OS 安全儲存保留驗證資料」時，credential 只保留到 app 結束，但同次執行
期間仍可用於斷線重連。Android 持久 credential 與 host trust 均由原生 Keystore
保護，不會從 profile list 回傳 WebView。

Desktop 的完整 profile 與 host trust（包含名稱、host、port、username、credential
與 fingerprint）由 Electron `safeStorage` 加密；舊版明文儲存會在首次啟動時自動
原子遷移。OS secure storage 不可用或資料無法解密時會停止載入，不會退回明文或
把原檔靜默清空。

### 2.5 Android 檔案下載測試

下載由 Android 原生層完成，不走 WebView blob download。Android 10+ 會寫入
`Downloads/CozyPad`；Android 7–9 會開啟系統儲存選擇器。改到 Kotlin download
plugin 後必須重新 build 並安裝 APK，再確認：

- 無副檔名與未知副檔名不會被改成 `.xml`。
- PDF、文字與 binary 檔案保留遠端原始檔名。
- 下載後的 SHA-256 與遠端檔案一致。

### 2.6 Signed release APK

正式 `apk` 命令要求四個簽章環境變數，缺少任一項就停止：

```powershell
$env:COZYPAD_ANDROID_KEYSTORE = "<keystore path>"
$env:COZYPAD_ANDROID_STORE_PASSWORD = "<CI or local secret>"
$env:COZYPAD_ANDROID_KEY_ALIAS = "<key alias>"
$env:COZYPAD_ANDROID_KEY_PASSWORD = "<CI or local secret>"
pnpm.cmd --filter @cozypad/mobile apk
```

產物：`apps/mobile/android/app/build/outputs/apk/release/app-release.apk`。
`apk:release:unsigned` 只供本機驗證，禁止上傳 release。Keystore 與密碼只能放在
本機環境變數或 CI secrets。

### 2.7 Signed Desktop package

正式 Windows 安裝檔必須提供 code-signing certificate：

```powershell
$env:CSC_LINK = "<certificate path or encoded certificate>"
$env:CSC_KEY_PASSWORD = "<CI or local secret>"
pnpm.cmd --filter @cozypad/app build
pnpm.cmd --filter @cozypad/desktop package
```

`package:unsigned` 預設只供本機驗證。若產品負責人明確核准延後原型簽章，內部
prerelease 的檔名與 release notes 必須清楚標示 `Internal`、unsigned 與 SHA-256；
不得當作正式或 latest release。

## 3. Flutter ↔ 本專案指令對照

| Flutter | 本專案 |
| --- | --- |
| `flutter doctor` | `pnpm install` 成功 + `adb devices` |
| `flutter devices` | `adb devices` |
| hot reload（按 r） | 自動（Vite HMR，存檔即生效） |
| `flutter run`（桌面） | `pnpm dev:desktop` |
| `flutter run`（手機） | Live reload（見 2.2） |
| `flutter build apk --split-per-abi` | 開發用 `pnpm --filter @cozypad/mobile apk:debug`；正式版用 `apk` |
| `flutter test` | `pnpm test` |
| `flutter analyze` | `pnpm lint && pnpm typecheck` |

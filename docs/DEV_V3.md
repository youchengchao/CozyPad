# CozyPad V3 開發指南

V3 是 TypeScript monorepo：**Electron（桌面）+ Capacitor（Android）共用同一套 React app**。
技術決策、SSH 安全邊界與 release gates 見唯一規格檔 [SPEC.md](../SPEC.md)。

## 需要安裝的東西

| 你要做的事 | 需要 |
| --- | --- |
| UI／共用邏輯／桌面功能（大多數工作） | Node.js LTS + pnpm，就這樣 |
| Android APK build | 再加 Android SDK（`platform-tools`、`platforms;android-36`、相容 Build Tools）+ JDK 21 |

不需要 Flutter、Dart、Rust、Visual Studio、Android Studio。

```bash
corepack enable
pnpm install
```

## 日常指令

```bash
pnpm dev            # 瀏覽器 mock 模式（不需 Electron、不需真主機）— UI 開發主力
pnpm dev:desktop    # Vite + Electron 一起起（COZYPAD_MOCK=1 預設走 mock transport）
pnpm lint           # 含 PlatformBridge 邊界規則
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @cozypad/desktop smoke   # Electron 自動驗證（載入 + IPC terminal 往返）
pnpm --filter @cozypad/mobile apk:debug # Android debug APK（真機開發）
```

Android build 需要環境變數（或寫入 `apps/mobile/android/local.properties`）：

```bash
JAVA_HOME=<jdk21 路徑>
ANDROID_HOME=<android sdk 路徑>
```

## Repo 結構

```
apps/
  app/        共用 React app（兩個殼都載入它；也能純瀏覽器跑）
  desktop/    Electron shell：main（SSH/transport）+ preload（typed IPC bridge）
  mobile/     Capacitor shell（Android）
packages/
  contracts/  Zod schemas、PlatformBridge interface、IPC channels — 跨平台唯一協定來源
  remote-services/  遠端檔案、telemetry、tmux 安裝與設定
  telemetry/  Linux CPU、RAM、GPU 指標解析
  tmux-runtime/  tmux session/runtime
  test-fixtures/  MockPtyEngine、ssh byte fixtures、mock agent 資料
lib/ 等       舊 Flutter 版（V3 cutover 前保持可發佈，不要動）
```

## 鐵則（lint 會擋，別繞）

1. `apps/app` 不准 import `electron`、`@capacitor/*`、`ssh2`、`node:*` —— 平台能力一律走 `PlatformBridge`。
2. `packages/contracts` 不准 import 任何 UI framework 或平台 library。
3. IPC 進出兩端都要過 Zod 驗證。
4. Terminal 資料是 binary-safe bytes（base64 over IPC），不准 line-based 處理。

## SSH credential 與 host trust

- UI 支援密碼與 SSH private key；加密 private key 可另填 passphrase。
- Secret 只會單向提交 privileged bridge。Profile list 只回傳
  `hasPassword`／`hasPrivateKey`，不得回傳內容。
- Desktop 在 Electron main process 使用 `safeStorage` 加密完整 profile 與 host trust；
  舊版明文 `profiles.json`／`known_hosts.json` 會自動原子遷移。Android 使用 native
  credential vault 與 Android Keystore AES-256-GCM 保護 credential 與 host trust。
- Desktop 與 Android credential 均綁定 profile ID、host、port、username 與
  auth method；target 改變後必須重新輸入。
- 關閉「以 OS 安全儲存保留驗證資料」時，secret 只保留在 main/native process
  memory，app 關閉後清除，同次執行仍可自動重連。
- Host key 採 OpenSSH `SHA256:` fingerprint。首次與變更都要提示，信任資料不得由
  renderer／WebView 直接讀寫。
- Desktop 與 Android 均使用安全演算法白名單，不可為舊主機重新啟用 SHA-1、DSA、
  CBC、3DES、RC4 或 MD5。

## 真實 SSH 主機手動測試

一般測試請執行 `pnpm dev:desktop:ssh`，再從連線管理 UI 建立密碼或 SSH Key profile。
也可以使用一次性環境變數建立密碼 profile；不要把值寫進 script：

```powershell
$env:COZYPAD_SSH_HOST = "<host>"
$env:COZYPAD_SSH_PORT = "22"
$env:COZYPAD_SSH_USER = "<user>"
$env:COZYPAD_SSH_PASSWORD = "<temporary password>"
pnpm.cmd dev:desktop:ssh
Remove-Item Env:COZYPAD_SSH_PASSWORD
```

至少驗證首次 host-key prompt、fingerprint 變更拒絕、密碼、未加密 key、加密 key、
手動斷線，以及非手動斷線後的自動重連。Android 原生改動還要重建並重裝 APK，
不能只更新 Web assets。

## Android 檔案下載

Android 不使用 WebView 的 `<a download>` 儲存遠端檔案。Android 10+ 由
`CozyPadDownload` plugin 透過 `MediaStore.Downloads` 寫入 `Downloads/CozyPad`；
Android 7–9 會開啟系統儲存選擇器。原始檔名與 bytes 必須保持不變，未知格式使用
`application/octet-stream`，且不要求 `WRITE_EXTERNAL_STORAGE` 或檔案管理權限。

改到 download plugin、plugin registration 或 contract 後，live reload 不足以驗證；
必須重建、重裝 APK，並至少測試無副檔名、未知副檔名、PDF 與 binary 檔案。

## 正式發行

正式命令會 fail closed：缺少簽章資訊就停止，不產生可誤發的 unsigned artifact。

Android signed release：

```powershell
$env:COZYPAD_ANDROID_KEYSTORE = "<keystore path>"
$env:COZYPAD_ANDROID_STORE_PASSWORD = "<CI or local secret>"
$env:COZYPAD_ANDROID_KEY_ALIAS = "<key alias>"
$env:COZYPAD_ANDROID_KEY_PASSWORD = "<CI or local secret>"
pnpm.cmd --filter @cozypad/mobile apk
```

Desktop signed package：

```powershell
$env:CSC_LINK = "<certificate path or encoded certificate>"
$env:CSC_KEY_PASSWORD = "<CI or local secret>"
pnpm.cmd --filter @cozypad/desktop package
```

`apk:release:unsigned` 與 `package:unsigned` 預設只供本機驗證。只有產品負責人明確
核准的內部原型 prerelease 才可附 debug-signed APK 或 unsigned Desktop installer，
且檔名與 release notes 必須標示 `Internal`、簽章狀態與 SHA-256；不得標成正式或 latest。
Keystore、certificate、password、`.env`、SDK/JDK 絕對路徑與 live-reload
`server.url` 都不得提交。

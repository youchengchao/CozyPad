# CozyPad V3 開發指南

V3 是 TypeScript monorepo：**Electron（桌面）+ Capacitor（Android）共用同一套 React app**。
技術決策與架構約束見 [SPEC_V3.md](../SPEC_V3.md)（特別是 3.1 的 PlatformBridge 規則）。

## 需要安裝的東西

| 你要做的事 | 需要 |
| --- | --- |
| UI／共用邏輯／桌面功能（大多數工作） | Node.js LTS + pnpm，就這樣 |
| Android APK build | 再加 Android SDK（`platform-tools`、`platforms;android-35`、`build-tools;35.0.0`）+ JDK 21 |

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
pnpm --filter @cozypad/mobile apk      # Android debug APK（需 SDK + JDK）
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
  test-fixtures/  MockPtyEngine、ssh byte fixtures、mock agent 資料
lib/ 等       舊 Flutter 版（V3 cutover 前保持可發佈，不要動）
```

## 鐵則（lint 會擋，別繞）

1. `apps/app` 不准 import `electron`、`@capacitor/*`、`ssh2`、`node:*` —— 平台能力一律走 `PlatformBridge`。
2. `packages/contracts` 不准 import 任何 UI framework 或平台 library。
3. IPC 進出兩端都要過 Zod 驗證。
4. Terminal 資料是 binary-safe bytes（base64 over IPC），不准 line-based 處理。

## 真實 SSH 主機手動測試（Phase 3 secure storage 落地前）

```bash
COZYPAD_MOCK=0 COZYPAD_SSH_HOST=<host> COZYPAD_SSH_USER=<user> COZYPAD_SSH_PASSWORD=<pw> pnpm dev:desktop
```

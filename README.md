# SSH Dashboard (Hermes Control Plane)

這是一個基於 Flutter 開發的桌面應用程式，用於管理遠端伺服器（透過 SSH 及 tmux），並提供 Dart-native 的 Hermes Agent 執行環境。

---

## 📂 專案同步與 Git Push 指南

本專案已設定好標準的 `.gitignore`，編譯產生的快取與二進位檔案會自動被忽略。如果您要在別台電腦上繼續開發，請**推送整個專案資料夾**（排除被忽略的檔案）。

### 推送步驟（以 GitHub 為例）：
1. 在 GitHub 或 GitLab 上建立一個新的空的 Repository。
2. 在本機專案目錄下執行以下指令連結遠端倉庫並推送：
   ```bash
   # 關聯遠端倉庫（請替換為您的倉庫網址）
   git remote add origin <您的倉庫網址>
   
   # 將分支命名為 main
   git branch -M main
   
   # 提交並推送到遠端
   git add .
   git commit -m "feat: init project"
   git push -u origin main
   ```
3. 在新電腦上，只需 clone 專案即可：
   ```bash
   git clone <您的倉庫網址>
   ```

---

## 🛠️ 開發環境配置

在開始開發或自行編譯前，請先配置好以下環境：

1. **安裝 Flutter SDK**：
   * 本專案使用的 SDK 版本為 `>=3.0.0 <4.0.0`。
   * 請至 [Flutter 官網](https://docs.flutter.dev/get-started/install) 下載並配置環境變數。
2. **安裝 Windows C++ 編譯工具 (Visual Studio)**：
   * 因為此專案會編譯成 Windows 原生應用程式，您必須安裝 [Visual Studio 2022](https://visualstudio.microsoft.com/)（社群版即可）。
   * 安裝時必須勾選 **「使用 C++ 的桌面開發」 (Desktop development with C++)** 工作負載。
3. **檢查環境**：
   ```bash
   flutter doctor
   ```
   確認 "Windows Version" 與 "Visual Studio" 均顯示綠色勾勾。

---

## 💻 本地開發步驟

在專案根目錄下執行以下指令：

1. **獲取相依套件**：
   ```bash
   flutter pub get
   ```
2. **執行 Debug 模式**：
   ```bash
   flutter run -d windows
   ```

---

## 📦 自行編譯與打包 (Build Release)

為了避免直接下載未簽章的 `.exe` 檔案導致 Windows SmartScreen 攔截，**建議使用者或您自己在新電腦上自行編譯**。自行編譯出的檔案在本地執行時不會觸發 Windows 安全警告。

### 1. 執行編譯指令
在專案根目錄下執行：
```bash
flutter build windows
```

### 2. 取得編譯產物
編譯完成後，二進位檔案與所有依賴項目會生成在以下目錄：
`[專案根目錄]/build/windows/x64/runner/Release/`

> [!IMPORTANT]
> **請注意**：`Release` 資料夾內的所有檔案（包括 `ssh_dashboard.exe`、多個 `.dll` 檔案以及 `data` 資料夾）**必須全部放在一起**才能正常運作。如果只複製 `.exe` 檔案，程式將無法啟動。
> 
> 若要分發給他人使用，請將整個 `Release` 資料夾壓縮成一個 `.zip` 壓縮檔。

---

## 🛡️ Windows 安全性與未知發行者簽章問題說明

當用戶直接下載您編譯好的 `.exe` 執行檔時，Windows 系統可能會跳出 **「Windows 已保護您的電腦」 (SmartScreen)** 的藍色警告視窗，這是因為該執行檔沒有經過付費的數位憑證（如 DigiCert、Sectigo 等）簽章。

### 解決方案：

#### 方案一：自行編譯（推薦開發者與進階用戶）
按照上述「**自行編譯與打包**」步驟，自行在本地安裝 Flutter 與 Visual Studio 並編譯。**在本地編譯產生的 `.exe` 檔不會受到 Windows SmartScreen 攔截**。

#### 方案二：手動解除封鎖
如果直接下載了編譯好的壓縮包，可以透過以下步驟解除封鎖：
1. 右鍵點擊 `ssh_dashboard.exe`（或其所在的壓縮包），選擇 **「內容」 (Properties)**。
2. 在「一般」索引標籤的最下方，找到「安全性」區段，勾選 **「解除封鎖」 (Unblock)**。
3. 按下 **「確定」 (OK)** 或 **「套用」 (Apply)**。
4. 或者，在開啟程式出現藍色警告視窗時，點擊 **「其他資訊」 (More info)**，然後點擊 **「仍要執行」 (Run anyway)**。
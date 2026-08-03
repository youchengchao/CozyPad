# AGY 畫面模板：資料結構

狀態：**已實作**（`apps/app/src/workspaces/agents/agyScreens.ts`）。

本文件原為提案。實作前用 `conhost --headless` 驅動本機 AGY 抓到五個畫面的真實輸出，
文件裡標 ❓ 的猜測欄位因此被真實資料取代——其中 `/resume` 的欄位與原本推測差很多
（沒有顯示 conversation ID，但多了分頁列與相對時間）。fixture 在
`apps/app/tests/fixtures/agyScreens.ts`，測試在 `apps/app/tests/agyScreens.test.ts`。

尚未取得真實畫面因而**未支援**：`/artifact`、`/diff`。

## 為什麼要改

現在 `deriveAgyScreenModel` 只吐出一個通用形狀：`mode` 加一個扁平的 `options[]`。
所有互動畫面——模型選擇器、session 清單、權限管理、diff——都被壓成同一個面板。

拿真實擷取的 `/model` 畫面實測，現況是：

```
mode      : viewer                    ← 只知道「是某種面板」
title     : "(Google AI Pro)"         ← 抓到被寬度截斷的帳號碎片
options   : [六個模型名稱]             ← 只剩一維
bodyLines : ["Effort ◂ ●━━━●━━━◉ ▸", "low medium high", ...]
```

Effort 滑桿是模型選擇器的第二個維度，卻降級成純文字：UI 不知道它停在哪一格，也點不動。
`(current)` 只是黏在字串尾巴，UI 不知道那代表「使用中」。

## 證據標記

本文件每個欄位標註來源，實作時不得把未驗證的欄位當成既定事實：

- ✅ **實機擷取**：本機或遠端真實 AGY 1.1.9 畫面，fixture 在 `apps/app/tests/agyRealScreens.test.ts`
- 📄 **官方文件**：antigravity.google/docs/cli 或 release notes 明確記載
- ❓ **未驗證**：尚未取得真實畫面，實作前必須先抓一份

---

## 0. 共用結構

```ts
/** 每個畫面都帶的信封。 */
export interface AgyScreenBase {
  /** 去除 ANSI 後的原始列，保留供診斷與 fallback。 */
  raw: readonly string[];
  /** 內容指紋；不變就不重繪。 */
  fingerprint: string;
  /** 這個畫面自己宣告的按鍵（來自它的 footer），供 UI 顯示與轉送。 */
  keys: AgyKeyHint[];
}

export interface AgyKeyHint {
  /** 畫面上印的樣子，例如 `↑/↓`、`shift+a`、`esc`。 */
  label: string;
  /** 畫面上印的說明，例如 `Navigate`、`Approve all`。 */
  action: string;
}
```

UI 不該自己猜按鍵。AGY 每個面板都會把可用按鍵印在底部（✅ 模型選擇器的
`Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Go Back`、
✅ 信任詢問的 `↑/↓ Navigate · enter Confirm`），解析出來直接顯示，
版本更動時 UI 會跟著變而不需要改程式。

### 動作模型

UI 不直接送按鍵位元組，而是送**意圖**，由轉換層決定送什麼：

```ts
export type AgyIntent =
  /** 把游標移到第 n 項（轉成對應次數的 ↑/↓）。 */
  | { type: 'focus'; index: number }
  /** 連續值調整，用於 effort 這類 ←/→ 控制。 */
  | { type: 'adjust'; delta: number }
  /** 直接跳到某個刻度（轉成多次 adjust）。 */
  | { type: 'adjustTo'; index: number }
  | { type: 'confirm' }
  | { type: 'cancel' }
  /** 畫面自己宣告的快捷鍵，例如核准卡的 `2`、artifact 的 `y`。 */
  | { type: 'press'; key: string }
  /** 輸入文字，用於清單的即時篩選。 */
  | { type: 'type'; value: string };
```

這一層是「不要抓鍵盤行為再刮畫面」的關鍵：UI 表達的是「我要選第 3 個模型」，
不是「我要按三次下再按 Enter」。

---

## 1. 二維選擇器 — `/model`

✅ 有實機擷取。

```ts
export interface AgyModelChoice {
  /** ✅ `Gemini 3.5 Flash` */
  label: string;
  /** ✅ 尾綴限定詞，`(Thinking)` / `(Medium)`。 */
  qualifier?: string;
  /** ✅ 該列標了 `(current)`。 */
  current: boolean;
  /** ✅ 該列是 `>` 游標所在。 */
  focused: boolean;
  lineIndex: number;
}

export interface AgyEffortGauge {
  /** ✅ `['low', 'medium', 'high']`，來自刻度下方的標籤列。 */
  levels: string[];
  /** ✅ `◉` 的位置；`●` 是其他刻度。 */
  selectedIndex: number;
  /** ✅ 目前刻度的說明，`Deepest reasoning for complex problems…`。 */
  description?: string;
}

export interface AgyModelPickerScreen extends AgyScreenBase {
  kind: 'modelPicker';
  /** ✅ `Switch Model` */
  title: string;
  models: AgyModelChoice[];
  /**
   * 📄 只有部分模型有多段 effort（release 1.1.5 說「for models that expose
   * multiple effort variants」）。沒有時為 undefined，UI 不顯示滑桿。
   */
  effort?: AgyEffortGauge;
}
```

UI 模板：左側模型清單（current 標記、focused 反白），下方 effort 三段式控制（可點刻度）。
點模型送 `focus`，點刻度送 `adjustTo`，確認送 `confirm`。

**開放問題**：切換模型後 effort 滑桿是否重繪成該模型的可用段數？需要實機確認。

---

## 2. 清單瀏覽器 — `/resume`

❓ **無實機擷取**，以下欄位全部來自 📄 官方文件（`/docs/cli/commands/resume`）。
實作前必須先抓一份真實畫面校正。

```ts
export interface AgySessionRow {
  /** 📄 對話標題。 */
  title: string;
  /** 📄 工作區；視窗窄時 AGY 會自己丟掉這欄。 */
  workspace?: string;
  /** 📄 最後活動時間，格式未知。 */
  updated?: string;
  /** 📄 步數。 */
  steps?: number;
  /** 📄 可用 ID 篩選，代表 ID 可能顯示在列上或可被比對。 */
  conversationId?: string;
  focused: boolean;
  lineIndex: number;
}

export interface AgySessionPickerScreen extends AgyScreenBase {
  kind: 'sessionPicker';
  rows: AgySessionRow[];
  /** 📄 直接打字即篩選，這是目前的篩選字串。 */
  filter: string;
  /** 📄 Tab 可切到 Antigravity 2.0 分頁匯入桌面版對話。 */
  tab: 'cli' | 'desktop';
  /** 📄 ←/→ 翻頁；未知是否顯示頁碼。 */
  hasMore: boolean;
}
```

📄 專屬操作：`F2` 改名（會出現預填目前標題的輸入框）、`Ctrl+Delete` 刪除
（要 `Enter`/`y` 確認）、桌面分頁的匯入提示是 `[Import this? (y/n)]`。

UI 模板：可篩選的清單，每列顯示標題與次要資訊，列上直接有改名／刪除按鈕。
這是唯一一個 UI 需要提供**行內編輯**的清單。

---

## 3. 確認卡 — 核准、信任資料夾、檔案編輯

✅ 箭頭式有實機擷取；📄 數字式與 `[y/n/f]` 來自官方文件。

同一個語意有**三種畫面形式**，必須都吃得下：

```ts
export type AgyConfirmAnswer =
  /** 📄 數字式：`1. Yes` / `2. Yes, and run without sandbox restrictions`。 */
  | { via: 'digit'; key: string }
  /** 📄 字母式：`[y/n/f]`，f = 全螢幕 diff。 */
  | { via: 'letter'; key: string }
  /** ✅ 箭頭式：`> Yes, I trust this folder`，用游標選再 Enter。 */
  | { via: 'cursor'; index: number };

export interface AgyConfirmChoice {
  label: string;
  answer: AgyConfirmAnswer;
  focused: boolean;
  /**
   * 語意分類，讓 UI 決定按鈕顏色與排列，而不是比對字串。
   * `approveAlways` 對應「這次之後都同意」這類選項。
   */
  intent: 'approve' | 'approveAlways' | 'reject' | 'inspect' | 'other';
}

export interface AgyConfirmScreen extends AgyScreenBase {
  kind: 'confirm';
  /** ✅ `Do you trust the contents of this project?` */
  question: string;
  /** 要被授權的對象。 */
  subject?: {
    type: 'command' | 'file' | 'url' | 'mcp' | 'workspace';
    value: string;
    /** 📄 file/URL/MCP 的目標字串可在卡片內改以放寬範圍；終端指令不行。 */
    editable: boolean;
  };
  /** ✅ 補充說明列。 */
  detail: string[];
  choices: AgyConfirmChoice[];
}
```

UI 模板：問題置頂、對象用等寬字強調、選項依 `intent` 排列（危險選項不與安全選項並排）。

**這是最重要的一類**——按錯的代價最高，而且 AGY 會在沒有斜線指令的情況下主動彈出。

---

## 4. 分頁式管理器 — `/permissions`

❓ **無實機擷取**，📄 全部來自官方文件（`/docs/cli/commands/permissions`）。

是三個**串接的階段**，不是單一畫面：

```ts
export interface AgyRuleManagerScreen extends AgyScreenBase {
  kind: 'ruleManager';
  /** 📄 Scope Picker → Rule Viewer → Add/Edit Rule。 */
  stage: 'scope' | 'rules' | 'edit';

  /** 📄 stage='scope'：Project / Shared / Global。 */
  scopes?: { label: string; focused: boolean }[];

  /** 📄 stage='rules'：←/→ 或 Tab 切 allow / deny / ask。 */
  activeScope?: string;
  tabs?: { id: 'allow' | 'deny' | 'ask'; label: string; active: boolean }[];
  /** 📄 規則格式 `action(target)`，例如 `command(git)`。 */
  rules?: { text: string; focused: boolean; lineIndex: number }[];

  /** 📄 stage='edit'：文字輸入，Enter 驗證後儲存。 */
  draft?: { value: string; error?: string };
}
```

📄 專屬按鍵：`a` 新增、`e` 或 `Ctrl+G` 編輯、`d` 或 `Backspace` 刪除、`Esc` 回上一層。

UI 模板：麵包屑（scope › 分頁）＋規則清單＋行內新增/編輯表單。
`stage` 是 discriminant，UI 依它決定顯示哪一段，不必猜。

---

## 5. 檢視器 — `/usage`、`/diff`、`/artifact`、`/codesearch`

**我建議把這一類拆成兩類。** 你原本說五類，但這裡實際上是兩種截然不同的東西，
硬塞成一類會重演「通用面板」的問題。

### 5a. 唯讀報表 — `/usage`、`/changelog`、`/help`

✅ `/usage` 有實機擷取（本機 ConPTY 抓到完整配額表）。

```ts
export interface AgyMeter {
  /** ✅ `Weekly Limit` */
  label: string;
  /** ✅ 由 `[████░]` 的填滿比例推得；同列也有 `98.13%` 可校驗。 */
  ratio: number;
  /** ✅ `98% remaining · Refreshes in 51h 54m` */
  note?: string;
}

export interface AgyReportScreen extends AgyScreenBase {
  kind: 'report';
  /** ✅ `Models & Quota` */
  title: string;
  sections: { heading?: string; lines: string[] }[];
  /** ✅ 進度條抽出來用原生元件畫，不要用文字方塊。 */
  meters: AgyMeter[];
}
```

### 5b. 逐項審閱 — `/artifact`、`/diff`

❓ 無實機擷取，📄 來自官方文件（含一份 ASCII mockup）。

```ts
export interface AgyReviewItem {
  label: string;
  /** 📄 artifact 用 ✓/✗ 標記已核准/已駁回。 */
  state: 'pending' | 'approved' | 'rejected';
  /** 📄 `💬` 表示有註解。 */
  comments: number;
  focused: boolean;
  lineIndex: number;
}

export interface AgyReviewScreen extends AgyScreenBase {
  kind: 'review';
  /** 📄 `/diff` 用 Tab 切 VCS / Turn / Commit。 */
  modes?: { id: string; label: string; active: boolean }[];
  items: AgyReviewItem[];
  /** 📄 開啟的項目內容；diff 要能逐 hunk 跳。 */
  detail?: { title: string; lines: string[]; hunks?: number[] };
}
```

📄 專屬按鍵：`y`/`n` 核准或駁回、`Shift+A`/`Shift+R` 全部核准或駁回、`p` 預覽、
`c` 註解、`n`/`N` 跳 hunk、`Esc` 送出審閱結果。

📄 離開時若有未送出的註解會跳確認：`Shift+Y` 送出、`Shift+N` 丟棄。

---

## 6. 辨識與預期

```ts
export type AgyScreen =
  | AgyModelPickerScreen
  | AgySessionPickerScreen
  | AgyConfirmScreen
  | AgyRuleManagerScreen
  | AgyReportScreen
  | AgyReviewScreen
  /** 都不符合時的退路：現行的通用形狀，保證不會比現在差。 */
  | AgyGenericScreen;

export interface AgyScreenRecognizer<T extends AgyScreen> {
  kind: T['kind'];
  /**
   * 便宜的特徵判斷。expectation 是剛送出的斜線指令所預期的種類，
   * 只用來**加權**，不是唯一入口。
   */
  matches(lines: readonly string[], expectation: AgyScreen['kind'] | null): boolean;
  parse(lines: readonly string[]): T | null;
}
```

**斜線指令當提示、不當入口**，理由：

1. AGY 會在沒有任何指令的情況下主動彈核准卡（跑到一半要權限）
2. 有快捷鍵入口：📄 `Ctrl+R` 開 artifact 審閱、`Shift+Tab` 切執行模式
3. 使用者可能在 CozyPad 之外的真實終端動同一個 tmux session

所以 `expectation` 的作用是：送出 `/model` 後顯示正確的載入骨架、
以及在兩個辨識器都宣稱吻合時決定優先序。辨識器是主，預期是輔。

## 實作順序建議

1. **確認卡**（第 3 類）——最高風險、AGY 會主動彈出、且已有實機資料
2. **模型選擇器**（第 1 類）——已有實機資料，涵蓋清單與連續值兩種控制
3. **報表**（5a）——已有實機資料，唯讀最單純
4. 其餘三類要先各抓一份真實畫面才動工

## 待你確認

1. 第 5 類拆成 5a／5b（變成六類）可以嗎？
2. 實作順序要照上面，還是先做你點名的 `/model`？
3. `AgyGenericScreen` 退路要保留嗎？保留的好處是沒認出來的畫面不會比現在差，
   代價是通用面板的程式碼要一直留著。

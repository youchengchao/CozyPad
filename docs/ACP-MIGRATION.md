# ACP 遷移：agent page 統一走 Agent Client Protocol

**決定日期**：2026-08-07　**狀態**：spike 已通，設計中

UI 只認一個協定（[ACP](https://agentclientprotocol.com)），不再有三家 agent
三條路徑。取代目前「刮 120×40 終端畫面推論狀態」的架構。

---

## 為什麼

| 目前 | 之後 |
|---|---|
| Claude → `-p --output-format stream-json` | 三家都 → ACP `session/update` |
| Codex → `codex app-server` JSON-RPC | |
| AGY → 刮 xterm.js 畫面 | |

AGY 那條的每個 bug 都是同一個根因：用畫面推論狀態。footer 多一行、prompt echo
捲出視窗、status sync 自己打的字被鏡射回輸入框、回合結束靠「畫面回到 prompt
列」去猜——全是這個架構的副作用，不是個別疏漏。

## 架構

```
   UI (renderer)     ChatTimeline / composer / approval / question / thinking
                                    ▲
                                    │  ACP SessionUpdate（typed）
   ACP client        ClientSideConnection
   (desktop main)    ├─ fs/*        → RoutingTransport（本機/SSH 同一層）
                     ├─ terminal/*  → 現有 PTY runtime
                     └─ requestPermission / elicitation → UI 卡片
                                    ▲
                                    │  JSON-RPC over stdio
              ┌─────────────────────┼─────────────────────┐
        claude-agent-acp     gemini-cli --acp      agy adapter（我們自己寫）
```

ACP 的 client 端幾乎等於 CozyPad 既有能力，這是選它的主因：

| ACP client 方法 | CozyPad 對應 |
|---|---|
| `session/request_permission` | approval 卡（SPEC 已定義） |
| `elicitation/create`（form / URL） | question 卡 |
| `fs/read_text_file` / `write_text_file` | Files workspace + SSH transport ⚠️ 見下方更正 |
| `terminal/create` / `output` / `wait_for_exit` / `kill` | Terminal workspace + PTY ⚠️ 見下方更正 |
| `session/list` / `load` / `resume` | session 清單 + Resume |

### ⚠️ 更正（2026-08-07 實測）：`fs/*` 不會讓遠端「自動一致」

上表那兩列是**我當初的推論，實測不成立**：

- **`claude-agent-acp` 從不呼叫 client 的 `fs/*`。** 我們確實有宣告
  `fs: {readTextFile:true, writeTextFile:true}`（側錄的 client→agent bytes 裡看得到），
  那一輪也真的讀了檔、寫了檔，但側錄到的 client fs 呼叫是 `[]`。靜態確認：它的
  dist 有 `readTextFile` 的轉發函式，但整包 bundle 裡**沒有任何內部呼叫者**。
  ⇒ **「fs/* 走 RoutingTransport，所以本機與 SSH 對 agent 是同一層」對 Claude
  不成立。** 遠端就是得把 agent 跑在遠端主機上，不是靠 client 代理檔案存取。
- **`claude-agent-acp` 的 terminal 開關是 `clientCapabilities._meta['terminal_output']`，
  不是規格的 `terminal: true`。** 我們的 terminal handler 對它永遠不會被呼叫，
  要啟用得傳整包覆寫的 clientCapabilities 帶那個 `_meta` key——沒有任何文件寫這件事。

這條更正直接影響遠端設計：ACP 是 stdio，遠端的答案是「agent 跑在遠端」，
不是「client 代理它的檔案系統」。

`session/update` 變體對上今天既有的 UI：`agent_message_chunk`、
`agent_thought_chunk`（thinking 卡）、`tool_call` / `tool_call_update`（tool
卡）、`available_commands_update`（slash menu）、`current_mode_update`
（permission mode）。

## Spike 結果（2026-08-07，本機實測）

`@zed-industries/agent-client-protocol@0.4.5`，`PROTOCOL_VERSION = 1`。
自寫 ACP agent 包 `agy -p --output-format stream-json`，自寫 ACP client 驅動它。

```
update kinds seen : agent_message_chunk
turn-2 text       : "ACP_SPIKE_OK"
context carried   : YES      ← 第二輪問「我剛叫你回什麼 token」，答對
```

已證實可行：handshake、串流文字、`--conversation <id>` 續接多輪、
`result` 事件給乾淨的回合邊界、每一步都有 usage。

**踩到的坑**：`spawn(..., { shell: true })` 在 Windows 會把 argv 串成一條沒跳脫
的字串，prompt 一有空白就被打散、`--output-format` 跟著失效，agy 收到空 prompt
還會若無其事回一句 Hello。**不要用 `shell: true`**；agy 有真的 `.exe`，直接 spawn。

## 真 wire 觀測（2026-08-07 第二輪對抗驗證）

以下全部來自實際跑真 agy 並側錄，不是推論：

**串流是真 delta，不是累積快照。** `count 1..40` 那輪產生 3 個
`agent_message_chunk`。決定性證據：數字 **21 被切在 chunk 邊界上**
（chunk 1 結尾 `…20\n2`、chunk 2 開頭 `1\n22…`）——累積快照不可能切開一個 token。
串接後與 agy 自己的 `result.response` byte-exact（111 == 111），零重複零遺失。
三個 delta 共用 `step_index=2`，state 為 ACTIVE/ACTIVE/DONE。

⚠️ **但串流開始得非常晚**：8062ms 的回合，第一個 token 在 +6684ms 才到 client
——**83% 的時間是死氣**。UI 需要在這段期間給明確的「進行中」訊號，否則使用者會
以為當掉了。

**`toolCallId` 在真 wire 上穩定**：`tool_call` 與 `tool_call_update` 都是
`"<conversationId>:<step_index>"`，一對一無孤兒。以 `step_index` 當 correlation
key 的設計成立。

⚠️ **但 `in_progress` 實質不可觀測**：tool 的 ACTIVE 與 DONE 相隔 **1ms**
（+5815ms / +5816ms）——agy 是在 tool 已經跑完之後才宣布它開始。任何綁在
「工具執行中」的 UI 狀態都不會被看見，不要設計成需要它。

✅ **`tool_info.output` 存在但曾被丟棄**（第二輪抓到，第三輪修掉）：真 agy 的
DONE tool step 帶 `tool_info.output: "alpha.txt\nbeta.txt"`，但 `wire.ts` 沒宣告
這個欄位、`mapper.ts` 只在有 error 時才建 content block ⇒ tool card 顯示
completed 但結果空白。錄 fixture 那次 list_dir 剛好沒有 output，所以單元測試看
不到。現在欄位已宣告、已對映到 `tool_call_update.content`，回歸測試釘在
`turn-tool-output.ndjson`（真錄音）上。

⚠️ **被拒絕的 tool call 在 wire 上完全不存在**：要求 agy 讀不存在的檔案，它在
散文裡準確報錯，但產生 **零個 tool step**——沒有 ACTIVE、沒有 DONE、沒有 ERROR。
對任何渲染 tool card 的 UI 都是隱形的。範圍限制：這是 agy 在**執行前**拒絕
malformed call，不等於「執行了但失敗」，後者見下一節。

## 真 wire 觀測（2026-08-07 第三輪）：executed-but-failed 錄到了

前兩輪都沒能讓工具「執行後失敗」，所以 `status: 'failed'` 那條分支一度只靠一份
自己手寫的 fixture 撐著。第三輪用一輪 agy（Sonnet）同時打五種故意會壞的操作，
拿到了真形狀。錄音：`packages/adapter-agy/tests/fixtures/turn-tool-error.ndjson`
（verbatim stdout，未經編輯）。手寫的 `*.RECONSTRUCTED.ndjson` 已刪除。

**2026-08-07 第四輪：這一輪與 `turn-tool-output.ndjson` 都用 checked-in 的
`tests/fixtures/record.mjs` 重錄了一次（agy 1.1.11，Sonnet，各 1 次呼叫）。**
兩份錄音都獨立重現了全部形狀——兩個 `TOOL_ERROR`、非零 exit 仍 DONE、無 output 時
`output` 鍵整個不存在、執行前被拒只有 `error_message` 而沒有 tool step。原因不是
懷疑舊錄音（它其實查得到：舊的 raw 檔還在 session scratchpad，md5 與 checked-in
的完全相同），而是**證據放在 temp 目錄等於有到期日**：session 一結束就沒了，下一個
人只能相信別人說「我錄的」。現在指令、日期、agy 版本、md5 都寫在
`tests/fixtures/README.md`，`tests/provenance.test.ts` 會在 fixture 與該表對不上時
爆掉——手改 fixture 不再是無聲的。

**兩個工具真的 ERROR 了**，欄位名跟原本照文件猜的一致：

```jsonc
{"step_index":10,"state":"ERROR","step_type":"tool","tool_name":"read_url_content",
 "tool_info":{"parameters":{"Url":"http://127.0.0.1:9/"},
   "error":{"type":"TOOL_ERROR","message":"Failed to fetch document content at http://127.0.0.1:9/"}}}
```

`type` 的實際值是 `"TOOL_ERROR"`（手寫 fixture 猜的是 `TOOL_EXECUTION_ERROR`，
錯的）。第二個是 `manage_task` 帶無效 TaskId，形狀相同。所以
`state === 'ERROR'` → `tool_call_update(status: 'failed')` + 把
`error.message` 放進 `content`，現在是有真證據的行為。

⚠️ **非零 exit code 不是 tool 失敗**（反例同樣重要）：`run_command` 跑
`cmd /c exit 7` 和 `cmd /c dir Z:\no-such-drive-here` 兩次都是 **DONE**，不是
ERROR。命令自己的抱怨只出現在 `tool_info.output` 裡。把非零 exit 判成 failed
會誤報——工具確實完成了它的工作。

⚠️ **沒有輸出時 `output` 鍵整個不存在**，不是空字串（`cmd /c exit 7` 那步）。
`tool_call_update` 因此必須完全不帶 `content`，否則 client 會畫一個空的結果框。

⚠️ **一個工具失敗會把整輪的 `result.status` 變成 `"ERROR"`**，即使 agy 完整回答
了問題（這一輪就是：五步都跑完、逐條回報，status 還是 ERROR）。

✅ **已解決（2026-08-07）：`ERROR` 對到 `end_turn`，不是 `refusal`。** 原本把所有
非 SUCCESS 一律對到 `refusal`，UI 會看到一個「被拒絕」的回合，其實只是中途有工具
壞掉。而 `refusal` 不只是標籤——ACP schema 自己的定義是：

> The turn ended because the agent refused to continue. **The user prompt and
> everything that comes after it won't be included in the next prompt**, so this
> should be reflected in the UI.

也就是說 `refusal` 是在**要求 client 把這一輪丟出歷史**。但 agy 什麼都沒丟：下一輪
`--conversation <id>` 接回去時那一輪還在它的 context 裡。所以舊對映不只是講錯，
還會讓 client 的 transcript 跟 agy 的分岔。

現在的對映（`STOP_REASONS` in `mapper.ts`）：`SUCCESS`/`ERROR` → `end_turn`，
其餘為未實測的猜測；**認不得的 status 一律 `end_turn` 加一筆
`unknown_result_status` diagnostic**，不再猜成 `refusal`——從一個沒見過的字串猜出
「丟掉這一輪」是所有選項裡破壞性最大的一個。

失敗沒有被吞掉：每個壞掉的工具本來就已經是一張 `tool_call_update`
（`status: 'failed'` + `tool_info.error.message` 進 `content`）。ACP 沒有「做完了
但中途有東西壞掉」這個 stop reason，failed tool card 就是那條管道。

另外實測：`result.error`（頂層）是**最後一個**失敗工具訊息的逐字複本，不是回合層級
的錯誤，因此刻意不對映——tool card 已經有了，再送一次等於同一個失敗報兩次。

### 使用者可見性缺口：被拒絕的工具只有散文會講

把兩種失敗擺在一起看：

| 情況 | tool step | `tool_info.error` | `result.status` | UI tool card |
|---|---|---|---|---|
| 執行後失敗（fetch 被拒） | ACTIVE + ERROR | 有 | `ERROR` | ✅ 紅色 failed 卡 |
| 執行前被拒（讀不存在的檔） | **零個** | 無 | `SUCCESS` | ❌ 什麼都沒有 |

第二列是真的缺口，而且 adapter 補不了：wire 上沒有任何可以掛成 tool card 的東西
（`error_message` step 連文字都沒有）。唯一的交代是 assistant 自己的散文，例如
`model output error: invalid tool call error (invalid_args) failed to read file: …`，
它會以 `agent_message_chunk` 正常送到 client。

**對 UI 的結論**：不能用「有沒有 failed 的 tool card」來判斷這一輪有沒有東西壞掉，
也不能用 `stopReason` ——被拒絕的那輪回的是 `end_turn`。使用者只會在回覆文字裡
讀到。要真正做到每個失敗都有結構化呈現，得走 connect transport（它有執行前的
逐次審批，拒絕發生在我們手上而不是 agy 內部）。

## ✅ 已解決（2026-08-07 第五輪）：workspace 要靠 `--add-dir`，不是 process cwd

**這是本 adapter 最嚴重的一個 bug，而且它不會報錯。** 第三方 client 開了一個
`cwd` 指向含 3 個檔案的目錄的 session，真 agy 卻在
`C:\Users\devbox\.gemini\antigravity-cli\scratch` 跑 `list_dir`，回答
「I found 0 files」。`cliTransport.ts` 一直都有把 `cwd` 傳給 spawn——**agy 1.1.11
根本不看 process cwd**。連帶後果：我們送出去的 `tool_call.locations[]` 指向
workspace 以外的路徑，client 拿去畫「跟著看檔案」會全部指錯。

**實測證明 `--add-dir` 有效**（1 次真 agy 呼叫，Sonnet，agy 1.1.11 / Windows）。
實驗刻意讓兩個槓桿互相矛盾：建兩個相鄰目錄，`the-workspace` 放一個唯一命名的
marker 檔，`process-cwd` 保持空的；然後 **spawn 的 cwd 給 `process-cwd`，
`--add-dir` 給 `the-workspace`**，prompt 裡不出現任何路徑（講了路徑等於讓 agy
可以直接讀絕對路徑答對，證明不了 scope）。結果：

```
init.cwd              …\process-cwd            ← agy 收到了 cwd，還回報了
tool list_dir         DirectoryPath: …\the-workspace   ← 但它用的是 --add-dir 的
output                second-file.md
                      zorblax-9471-workspace-marker.txt
result.status         SUCCESS      exit 0
```

`init.cwd` 那一行是關鍵：agy **收下** process cwd 並如實回報，然後在解 tool call
時完全不用它。所以「有設 cwd」永遠不能當成「workspace 設對了」的證據。

因此 `buildAgyArgv` 現在**每一輪都送 `--add-dir <cwd>`**，ACP 的
`additionalDirectories` 也逐一對映成重複的 `--add-dir`（順序：cwd 先，去重）。
`AgyTurnRequest.additionalDirectories` 是**必填**欄位，不是選填——這個缺陷的本質
就是「忘記傳就靜默答錯」，型別層面不該讓人忘得掉。

重跑這個實驗的指令本身也 checked in（理由與 `record.mjs` 相同：「我驗過了」不該是
要人相信的一句話）。

⚠️ **同一輪順帶再次確認 `permission_mode: "always-proceed"`**（見下方「已知缺口」）。
這是第 24 份 transcript，`request_permission` 依然是 0 次。

### ⚠️ 更正（2026-08-07 第七輪）：上面那一輪其實沒有隔離變因

第五輪的結論（`--add-dir` 有效）**是對的，但那個實驗證不出來**。`cliTransport.ts`
的 spawn 同時設了 `cwd: request.cwd` 和 `--add-dir`，第五輪的 script 也一樣兩個
槓桿都動；「marker 出現了」只能說明「至少有一個有效」，不能說明是哪一個。而
**「cwd 單獨夠不夠」才是決定遠端 / SSH 能不能承諾的那一格**——遠端 spawn 的 cwd
不見得握在我們手上。

第七輪把 2×2 的兩個對角格各跑一次（2 次真 agy 呼叫，Sonnet 明確指定，agy 1.1.11 /
Windows 10），而且 argv 是走**已經改好、真的會出貨的** `buildAgyArgv`（含
`--model`），不是事後補旗標：

| lever | spawn cwd | `--add-dir` | agy 回報的 `init.cwd` | `list_dir` 真的跑在 | marker | exit |
|---|---|---|---|---|---|---|
| `add-dir-only` | `…\process-cwd`（錯的） | `…\the-workspace` | `…\process-cwd` | `…\the-workspace` | ✅ | 0 |
| `cwd-only` | `…\the-workspace`（對的） | **沒有** | `…\the-workspace` | `~\.gemini\antigravity-cli\scratch` | ❌ | 1 |

**結論：要讓 agy「進得去」我們指定的目錄，`--add-dir` 單獨就夠，process cwd 單獨
完全沒用。**

`cwd-only` 那一列就是「靜默答錯」的完整標本：agy 收下正確的 cwd、如實回報成
`init.cwd`、然後在**別的目錄**跑 `list_dir`、exit 0、`result.status: SUCCESS`、
回答「The directory is empty — no files were found.」。整輪沒有任何一個地方是錯誤。

**對產品的意義（這才是跑這兩次的理由）**：遠端 / SSH 那條路上，即使 spawn 的 cwd
不是我們決定的，一個 `--add-dir` 就能讓 agy 讀到我們要它讀的目錄——遠端不必因此
降級。

### 🚫 更正（2026-08-07 第八輪）：這兩次量的是 inclusion，不是 confinement

原本這一段寫的是「`--add-dir` 一個旗標就能把 workspace **定住**，這個承諾可以寫進
規格」，`cliTransport.ts` 的註解也寫成「cwd 單獨對 **scoping** 沒用」。**兩句都超譯
了實測結果。**

上面兩次實驗問的都是同一件事：**「agy 找不找得到我們指名的目錄」（inclusion）**。
沒有任何一次問過**「agy 會不會拒絕我們沒指名的路徑」（confinement）**——而後者才是
「scoping / workspace 邊界」這個詞會讓使用者聽成的意思。

而現有證據是反過來的。本 repo 自己的 fixture
`packages/adapter-agy/tests/fixtures/turn-tool-error.ndjson` 是一輪逐字錄下的真實
turn，agy 在裡面：

- 跑 `cmd /c dir Z:\no-such-drive-here`（workspace 外，另一顆磁碟）
- `grep_search` 掃 `~\.gemini\antigravity-cli\scratch`（agy 自己的暫存區）
- `read_url_content` 抓 `http://127.0.0.1:9/`（根本不是檔案系統）

全部在 `permission_mode: "always-proceed"` 下直接執行，client 端的權限政策完全插不
上手（`session/request_permission` 一次都不會送）。

**所以 `--add-dir` 是「去哪裡找」的提示，不是 sandbox。** 規格裡不准出現「CozyPad
保證 workspace scoping」這類句子。這個限制現在是 `initialize` 會送出去的負向能力：
`_meta["cozypad.dev/agy-limitations"].confinesToWorkspace = false`（連同
`workspaceDetail` 的說明文字），跟 `requestsPermission: false` 並排——理由一樣：ACP
沒有「我收下的 roots 只是建議」這個欄位，不講就會被讀成保證。

真要做到 confinement，只有兩條路：走 connect transport 的逐次審批（拒絕發生在我們
手上），或把 agy 放進 OS 層級的沙箱。兩者都還沒做。

重跑：

```
node packages/adapter-agy/tests/fixtures/proveWorkspace.mjs --lever add-dir-only
node packages/adapter-agy/tests/fixtures/proveWorkspace.mjs --lever cwd-only
node packages/adapter-agy/tests/fixtures/proveWorkspace.mjs --lever cwd-only --dry-run
```

它 import 的是 `src/cliTransport.ts` 裡**正在出貨的** `buildAgyArgv`，不是複製品；
marker 檔沒出現就 exit 1。

⚠️ **`--dry-run` 以前的 exit code 是假的**：它在所有斷言之前無條件
`process.exit(0)`，所以「dry-run 過了」什麼都不代表——連 `buildAgyArgv` 完全不送
`--add-dir` 都照樣 exit 0。現在 `--dry-run` 會斷言 argv 真的隔離了那個 lever、
真的釘了 `--model`、`--output-format stream-json` 還在，不成立就 exit 1；用三份
突變副本（`withoutAddDir` 改成 no-op、把 `--model` 濾掉）驗過三份都被擋下來。

## agy step_type → ACP 對映

| agy `step_type` | 內容 | ACP |
|---|---|---|
| `user_input` | 無 | 略過（client 自己送的） |
| `unknown`（idx 1, 0s） | 無 | 略過（內部標記） |
| `agent_response` | `text_delta` + `usage` | `agent_message_chunk` |
| `tool` state=ACTIVE | `tool_name`, `tool_info.parameters` | `tool_call`（in_progress） |
| `tool` state=DONE | `duration_seconds`, `tool_info.output`（可能整個沒有） | `tool_call_update`（completed，output 進 `content`） |
| `tool` state=ERROR | `tool_info.error.{type,message}`，`type` 實測 `TOOL_ERROR` | `tool_call_update`（failed，message 進 `content`） |
| `checkpoint` | 只有 usage | 略過 |
| `system_message` | 待查 | 待定 |
| `result`（事件） | `status`, `num_turns`, `usage` | `PromptResponse.stopReason` |

## 已知缺口——全部來自 agy print mode，不是 ACP

| 缺的 | ACP 有嗎 | agy print mode |
|---|---|---|
| 推理文字 | ✅ `agent_thought_chunk` | ❌ 只有 `usage.thinking_tokens` 和 duration，**沒有文字** |
| 逐次審批 | ✅ `session/request_permission` | ❌ `permission_mode: "always-proceed"` 自動放行 |
| 互動提問 | ✅ `elicitation/create` | ❌ 自己把 `ask_question` 答掉 |
| workspace 邊界 | ⚠️ ACP 只有 `cwd` / `additionalDirectories`，本來就沒承諾是 sandbox | ❌ `--add-dir` 只是「去哪裡找」；實測同一輪內跑 `dir Z:\…`、掃 agy 自己的 scratch、抓 `http://127.0.0.1:9/`（見「第八輪更正」） |

TUI 那條路**有**推理文字（「▸ Thought for 2s」+ 摘要行）。所以直接切 print mode
是功能倒退。

### ✅ 已解決（2026-08-07 第五輪）：缺口要「宣告」出來，不是靠沉默

上表的缺口本身沒變，變的是**我們有沒有告訴 client**。ACP 沒有「否定能力」欄位，
沉默等同於「這個 agent 只是剛好沒需要問」——所以第三方 client 的 `--deny-all`
對我們完全沒作用，而且它無從知道。23 份 transcript 裡 `request_permission` 出現
**0 次**，包含 agy 真的執行了 `list_dir` 的那幾輪。

現在 `initialize` 與 `session/new` 都會講清楚：

- `agentCapabilities._meta['cozypad.dev/agy-limitations']`
  = `{ requestsPermission: false, permissionMode: 'always-proceed', replaysHistory: false,
  pinsModelByDefault: false, confinesToWorkspace: false, pinSurvivesResume: false, detail,
  workspaceDetail }`。
  這幾個 key 是**線上契約**（client 會存、會回送），字面值由
  `packages/adapter-agy/tests/wireKeys.test.ts` 逐字釘住——之前每個測試都是
  `import` 常數後拿它自己去比自己，改成任何字串都還是綠的。
- **session mode**：`session/new` 與 `session/resume` 都回
  `modes.currentModeId = 'always-proceed'`，`availableModes` 只有這一個，
  description 直接寫「client 的 permission policy 無法 allow / deny 任何 tool」。
  這是 ACP 標準且 client 已經會畫的欄位，比 `_meta` 更難被忽略。
  刻意**不提供第二個 mode**——多一個看起來會擋工具但其實不會的開關，就是同一個
  缺陷換個地方長。`session/set_mode` 有實作，但只接受這一個 id，其餘 `-32602`。

**沒有做的事：假裝審批。** 不會自己代答 `request_permission`，也不會偽造一張
approval 卡。真正的逐次審批只有 connect transport 給得起。

### ✅ 已解決（2026-08-07 第五輪）：其餘四個「講得跟做的不一樣」

| 缺陷 | 原本 | 現在 |
|---|---|---|
| 宣告 `loadSession: true` 但做的是 resume | `session/load` 契約是**把整段歷史 replay 回去**；agy print mode 印不出 transcript，我們 replay 了 0 則通知。第三方 client 信了這個宣告去打 `session/load`，拿到 `-32002`，exit 4 | `loadSession: false` + `sessionCapabilities.resume: {}`，方法改名 `resumeSession`。`session/load` 現在直接 `-32601`（方法不存在），與宣告一致 |
| `resource_link` prompt block 被靜默丟掉 | `flattenPrompt` 只留 `type === 'text'`。實測 4 個 block 進去、兩個檔案引用消失、無錯誤無 diagnostic、`stopReason: end_turn`，然後 agy 自信地回答它從沒看過的檔案 | Text 與 ResourceLink 是 schema 的 baseline content（**沒有** capability gate）。`resource_link` 現在會（a）以檔名＋路徑寫進 prompt 文字，（b）把它的目錄併進該輪的 `--add-dir`，檔案是真的讀得到。非 `file:` 的 URI 仍寫進文字，並記一筆 diagnostic 說明為何沒加 root |
| image / audio / resource block | 同樣被靜默丟掉 | `-32602 Invalid params`，訊息裡指名是哪個 type。這三個正是我們在 `promptCapabilities` 宣告 `false` 的，client 送了就是違反它自己收到的宣告——可見的失敗勝過安靜的刪除 |
| 未知 session id → 裸 `Error` | 到 client 是 `-32603 Internal error`，也就是「agent 壞了」。client 分不出「session 過期，重開就好」和「agent 死了，放棄」 | `-32002`，訊息說明要 `session/new` 或帶 `_meta.conversationId` 走 `session/resume` |
| `initialize` 把 `protocolVersion: 0` 原樣回傳 | `Math.min(client, PROTOCOL_VERSION)` 無法表達「我不會講那個版本」 | 只回它真的會講的版本；不在支援清單裡就回 `PROTOCOL_VERSION`，並記一筆 diagnostic。規格本來就是這樣寫的：支援就回 client 那個，否則回 agent 最新的，讓 client 自己決定要不要斷線 |

## ✅ 已解決（2026-08-07 第七輪）：model 選擇——決定性驗證的前提

**在這一輪之前，adapter 從來沒有送過 `--model`。** 每一輪都跑在 agy **持久化的**
預設模型上，也就是 `~/.gemini/antigravity-cli/settings.json` 的 `"model"` 欄位；
實測當下的值是 `Gemini 3.6 Flash (Low)`——而這個 package 的每一份 fixture 都是
用 Sonnet 錄的。第三方 client 想指定模型也沒有欄位可送，我們也沒有欄位可讀。

這不是「少一個功能」，是**直接打掉 CozyPad 的第三個產品目的**：agent 跑 CV 實驗
要能確定性驗證。使用者在別的工具（agy TUI、Antigravity IDE）裡改一次模型，
CozyPad 這邊兩次一模一樣的 prompt 就可能跑在兩個模型上，而且**任何一個地方都不會
提到這件事**——ACP 的 `session/update` 與 `PromptResponse` 沒有 model 欄位，agy 的
stream-json 輸出也從頭到尾沒有出現模型名稱。

### 走 ACP 既有機制，不自創

另外兩家出貨中的 ACP agent 都是用 `session/set_config_option`，所以我們照做：

- **`session/new` / `session/resume` 回 `configOptions`**：一個
  `type: 'select'`、`category: 'model'`、`id: 'model'` 的選單，選項來自
  `agy models`（`<id>\t<display name>`，一個 process 只跑一次並快取，~2.1s）。
  connect transport 之後改吃 `GetCascadeModelConfigData` 即可，seam 已經在
  `AgyTransport.listModels()`。
- **`session/set_config_option`** 設定；回傳完整的 `configOptions`。
  給不存在的 model id → `-32602`，訊息裡列出真的可用的 id。**不接受**再塞進
  argv：那要花一次 spawn ＋ ~5s，錯誤還埋在 agy 的 stderr 裡沒人看得到。
- 選好之後 `buildAgyArgv` **每一輪**都送 `--model <id>`。

### 「沒選」是一個要講出來的狀態，不是預設值

`currentValue` 一開始是 `agy-persisted-default` 這個**真的可選**的值，不是空的：

- 它在 client 的 model picker 裡就叫「Not pinned — agy's saved default
  (Gemini 3.6 Flash (Low))」——那個括號裡的名字是從 settings.json 的 display name
  反查 `agy models` 得到的 id/name，查不到就照實說查不到，不猜 id。
- **每一個 prompt response 的 `_meta['cozypad.dev/agy-model']` 都會講這一輪跑在
  哪個模型**：`{pinned, modelId, agySavedDefault, detail}`。pinned 與否都送——
  「沒有人選過，所以 agy 自己挑了」正是最需要被記下來的那一種。
- 沒選的那一輪也會往 stderr 記一行 `[model] session … has no model pinned; this
  turn runs on agy's saved default ("…")`。

**刻意不做的事**：不在 `session/new` 就把 settings.json 的預設值填進
`session.model`。那樣每個 session 看起來都是 pinned，argv 卻還是沒有 `--model`，
等於把一個沒解決的問題偽裝成解決了。

### ✅ 已解決（2026-08-07 第八輪）：一次 `agy models` 失敗曾經廢掉整個 process 的 pinning

用「失敗一次然後恢復」的假 agy 量到的：`agy models` 只會被 spawn **一次**，空的
catalog 同時被 `AgyCliTransport.#catalog` 和 `AgyAgent.#catalog` 存起來
（`this.#catalog ??= …`，而且 `#loadCatalog` 永遠不 reject），於是**之後每一個**
`session/set_config_option` 都回 `-32602`——**包含 agy 恢復之後才開的 session**——
那些回合就全部跑在 agy 持久化的預設模型上。

它**沒有**產出無標籤的結果（診斷會掛在 error 和 `configOptions[0]._meta` 上，是大聲
失敗），但唯一的恢復手段是重啟 adapter。對「要用 agent 跑 CV 實驗、需要決定性驗證」
這個目的來說，開機時的一次網路抖動就把那個 process 之後的每一次實驗都降級成 unpinned。

現在：

- **只有列得出模型的 catalog 會被快取**。失敗只保留
  `modelListRetryCooldownMs`（預設 10s）——夠久，壞掉的 agy 不會每個 request 都被
  重 spawn 一次（每次最壞要等 `modelListTimeoutMs` = 20s）；夠短，恢復了不用重啟。
- `AgyAgent` 那一層同樣不快取空 catalog，但重試政策歸 transport 管，兩層不會各自
  重試。in-flight 的呼叫仍然共用，N 個並行 `session/new` 還是一次 subprocess。
- **catalog 不再是開機那一瞬間的快照**：成功的 catalog 過了 `modelListTtlMs`
  （預設 10 分鐘）後，下一次呼叫會在**回答之後**（stale-while-revalidate）背景重抓，
  所以上游新增/下架的模型不必重啟才看得到，而且重抓永遠不會擋在某一輪的路徑上。
  重抓失敗**不會**丟掉已經有效的 catalog。

### ✅ 已解決（2026-08-07 第八輪）：`session/resume` 會把 model pin 歸零

歸零本身是對的——握著那個選擇的 process 已經不在了——但一個 resume 完就直接 prompt、
沒有重送 `set_config_option` 的桌面端，會安靜地跑在 agy 的預設模型上。現在兩邊都補：

- **可以帶回來**：client 把我們送出去的 `_meta['cozypad.dev/agy-model']` 存起來，
  resume 時原樣回送（`{modelId}` 或裸 id 字串都收），pin 就會還原，之後每一輪照樣
  送 `--model`。跟 conversation id 完全同一套契約。
- 帶回來的 id 不在 agy 的清單裡 → `-32602`，**不會**默默降級成 unpinned。
- **session 還在這個 process 手上**（只是 client 重連）時，pin 本來就沒丟過，
  resume 不再把它清掉；`_meta['cozypad.dev/agy-resume'].model.source` 會寫
  `in-process` 還是 `client-meta`。
- 沒帶回來 → `_meta['cozypad.dev/agy-resume'].model` 寫著
  `{pinned: false, modelId: null, detail: 'THIS SESSION IS NOT PINNED TO A MODEL…'}`，
  並記一行 `[resume] session … resumed WITHOUT a model pin`。
- `initialize` 的 limitations 也多一個 `pinSurvivesResume: false`。

## ✅ 已解決（2026-08-07 第七輪）：`_meta` key 命名與 resume 的誠實度

**`_meta.conversationId` → `_meta['cozypad.dev/agy-conversation-id']`（F3）。**
同一個檔案裡 `AGY_LIMITATIONS_META_KEY` 早就是 namespaced 的，註解還寫明了理由
（不能跟未來的 spec 欄位或別家 agent 的 extension 撞名），偏偏**真正 load-bearing
的那一個是裸的**。撞名的後果不是掉欄位，是**resume 到別人的 conversation**。
舊的裸 key 在**輸入端**還收一個版本（收到會記一行 log 叫 client 改），輸出只送
namespaced 的。

**`session/resume` 不再無條件相信外來 id（F4）。** 之前只要 sessionId 不是
`agy-` 開頭就當成 agy conversation id 收下，實測
`session/resume { sessionId: 'nope-does-not-exist' }` 回 OK 並把那個字串原樣
echo 回 `_meta.conversationId`；client 以為接上了，真正爆掉是下一個 prompt。
`-32002` 那條路只保護得到我們自己發過的 id。現在：

1. **形狀檢查**：agy 的 conversation id 一律是 UUID（本機
   `~/.gemini/antigravity-cli/conversations/` 214 個檔全是 `<uuid>.db`，零例外；
   每一份 fixture 裡的 id 也都是）。不是 UUID → `-32602`，訊息說明要送
   `_meta['cozypad.dev/agy-conversation-id']`。這條擋掉打錯字、貼一半、拿別家
   agent 的 id 過來這三種真實情況。
2. **檢查不到的部分直說**：形狀是這個 transport 唯一查得到的東西——agy print mode
   沒有「這個 conversation 還在嗎」的問法，除非花一輪。所以回應的
   `_meta['cozypad.dev/agy-resume']` 帶
   `{conversationId, source, verified, detail}`，`verified` **只有**在這個 adapter
   process 親眼看過 agy 在 `init` 事件裡命名它時才是 `true`；client 送回來的、或拿
   sessionId 當 id 的，一律 `verified: false` 並在 `detail` 寫明「下一個 prompt 才
   會知道」。

順帶修掉的：`prompt()` 現在要 await model catalog，AbortController 因此改在第一個
await **之前**安裝——否則 cancel 落在那個空窗期會完全沒作用（`session.abort` 還是
null），agy 照樣被 spawn。已經 cancel 的回合直接回 `stopReason: 'cancelled'`，不花
那次 spawn。

### P2 調查結果（2026-08-07）：Connect transport 存在，缺口 #2 可解

AGY 有一個 local language server。啟動與探索：

```
agy --log-file <path> --add-dir <workspace>
  → log 出現 "Language server listening on random port at 43617 for HTTP"
  → 等 ~2.1–2.6s 直到 GetAvailableModels 回非空（認證＋後端就緒）

POST http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/<Method>
Content-Type: application/json          （unary）
Content-Type: application/connect+json  （server-streaming，1 byte flags +
                                          4 bytes big-endian length + payload）
```

核心方法：`StartCascade`（回 `cascadeId`）、`SendUserCascadeMessage`
（`planModel` 必填，值取自 `GetCascadeModelConfigData`）、
`GetCascadeTrajectory`（輪詢狀態與累積 step；**要等進入非 IDLE 後，IDLE 才算完成**）、
`HandleCascadeUserInteraction`（回答 permission）。欄位名一律 lowerCamelCase。

它比 CLI 多給的：

- **執行前否決的逐次審批**——grant pattern 寫在
  `plannerConfig.toolConfig.permissionConfig.effectiveGrants`（`write_file(*)`
  這種 `action(target)` 形式）；在 `ask` 清單裡的動作會在工具執行前暫停，
  用 `HandleCascadeUserInteraction` 的 `permission: {allow, scope,
  userDenyInstruction}` 回答。實測 1.35–1.45s 跳提示，allow 後 60ms 落檔。
- **結構化 step**：typed protobuf，路徑是 URI，**diff 由 agy 自己算**
  （`codeAction.actionResult.edit.diff.unifiedDiff.lines[]`），不必再從文字猜。
- **快約 5 倍**：每輪 ~0.93s vs spawn-per-turn 的 ~5.2s（bootstrap 2.1–2.6s 一次）。

**三個風險，動手前要有對策：**

1. **private、undocumented API**，adapter 作者自己標明。agy 升級可能斷 →
   adapter 必須能退回 `cli` transport，並且要有版本偵測。
2. **安全旗標 fail-open**：「已知 message 裡拼錯的欄位會被 HTTP 200 接受然後
   靜默忽略」。permission config 打錯一個字＝防護悄悄消失。**送完必須回讀
   `USER_INPUT` step 裡 echo 的 `userInput.userConfig` 確認生效**，不可假設成功。
3. **127.0.0.1 的 HTTP**：遠端（SSH）情境要 port forward 或把 client 端放到遠端跑。
   這跟 RoutingTransport 的分層要一起設計。

**本機實測（2026-08-07，agy 1.1.11 / Windows）**：language server 起得來、
認證沿用現有憑證、unary RPC 有回應。

⚠️ **但它是 HTTPS + 自簽憑證，不是參考文件寫的 HTTP**——第一次 curl 直接被
「Client sent an HTTP request to an HTTPS server」打回。這佐證了私有 API 的
風險：文件與實作已經不同步。client 要 `rejectUnauthorized: false`（僅限
127.0.0.1）。

`GetAvailableModels` 回傳的形狀：

```json
"claude-opus-4-6-thinking": {
  "displayName": "Claude Opus 4.6 (Thinking)",
  "supportsThinking": true, "thinkingBudget": 1024,
  "maxTokens": 250000, "maxOutputTokens": 64000,
  "quotaInfo": { "remainingFraction": 0.293514, "resetTime": "2026-08-09T22:58:03Z" }
}
```

**這一份回應就取代掉 `agyScreens.ts` 的大半**：model picker、quota report、
context 上限全都在裡面，而且是型別化的。目前拿 quota 的方式是開機打 `/usage`
→ 等 overlay → 從 `[████░░] 29.35%` regex 出數字 → 按 Esc 關掉；那整套
status sync（也就是把 `/usa`、`/con` 留在使用者輸入框的那段）可以整段刪除。

附帶一提：`displayName: "Claude Opus 4.6 (Thinking)"` 正是 2026-08-07 早上那個
footer bug 的元凶字串。在這裡它是 displayName 欄位，旁邊有獨立的
`supportsThinking` boolean——不必再從 footer 猜「(Thinking) 是模型名稱還是狀態」。

### Connect 的線上形狀（2026-08-07 實測，非文件）

**欄位名或巢狀層級錯了不會報錯。** 我把 `planModel` 放 top-level，HTTP 200 收下，
然後執行期才炸：`failed to construct executor: neither PlanModel nor
RequestedModel specified`。fail-open 是真的，親自踩過。

正確形狀：

```jsonc
// StartCascade  → {"cascadeId": "..."}
{ "workspaceUris": ["file:///abs/path"],
  "trajectoryType": "CORTEX_TRAJECTORY_TYPE_CASCADE",
  "source": "CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT" }   // source 必填

// SendUserCascadeMessage  → {} （~5–20ms 立刻回，不等回合結束）
{ "cascadeId": "...",
  "items": [{ "text": "user prompt" }],
  "messageOrigin": "AGENT_MESSAGE_ORIGIN_SDK_EXECUTABLE",
  "cascadeConfig": { "plannerConfig": {
      "planModel": "MODEL_PLACEHOLDER_M35",   // 裸 enum 字串，取自 GetCascadeModelConfigData
      "toolConfig": { /* permissionConfig.effectiveGrants 放這裡 */ } } } }

// GetCascadeTrajectory
{ "cascadeId": "...", "verbosity": "CLIENT_TRAJECTORY_VERBOSITY_PROD_UI" }
// → { trajectory: { steps: [...] }, status: "CASCADE_RUN_STATUS_IDLE|_RUNNING|_CANCELING", numTotalSteps }
```

實測 step 序列：`CORTEX_STEP_TYPE_USER_INPUT` → `..._PLANNER_RESPONSE` →
`..._CHECKPOINT`。

### ✅ 缺口 #1 解決：Connect **有**推理文字

`PLANNER_RESPONSE` 的 `plannerResponse` 欄位：
`response`, `modifiedResponse`, **`thinking`**, **`thinkingSignature`**,
`messageId`, **`thinkingDuration`**, `stopReason`。實測值：

```
thinking          "17 * 23 = 17 * 20 + 17 * 3 = 340 + 51 = 391"
thinkingDuration  "0.445514600s"
thinkingSignature "RW9JQ0NuVUlFQkFDR0FJcVFNRStURXBP…"（不透明）
```

比 TUI 給的**更多**——TUI 只有一行摘要加約略秒數。thinking 卡不但保得住，內容變好。

⚠️ **`response` 是累積值，不是 delta**（參考實作驗證）。adapter 要自己跟上一次
比對後才發 `agent_message_chunk`，否則畫面會重複整段。

**三個缺口在 connect 全部可解**，設計沒有未知數了：

| 缺的 | cli transport | connect transport |
|---|---|---|
| 推理文字 | ❌ 只有 token 數 | ✅ `plannerResponse.thinking` |
| 逐次審批 | ❌ 自動放行 | ✅ `HandleCascadeUserInteraction`（執行前否決） |
| 互動提問 | ❌ 自己答掉 | ✅ 同一套 `requestedInteraction` 機制（未逐項驗證） |
| 速度 | ~5.2s／輪（每輪 spawn） | ~0.93s／輪（常駐） |
| 風險 | 低——公開 flag | 高——私有 API，fail-open |

**結論**：adapter 內含兩種 transport——`cli`（stream-json，簡單安全慢、無審批）
與 `connect`（快、真審批、結構化 diff、私有 API）。先出 `cli`，`connect` 當升級。
參考實作也是這樣切的。ACP 這層邊界把「要不要賭私有 API」關在單一 adapter 內，
UI 永遠不知道下面是哪條——這是統一協定最實際的回報。

AGY 也沒有原生 `--acp`（還只是
[antigravity-cli issue #31](https://github.com/google-antigravity/antigravity-cli/issues/31)
的 feature request；gemini-cli 和 claude 都已經有）。

## Transport 存活偵測：一個已修的 blocker 與兩個 Windows 盲區

`packages/acp-client` 的 transport 縫（`connectAcpAgent` 收兩條 byte stream，
而不是一個 `ChildProcess`）本來就是為了 SSH channel 存在的。以下三件事全部是
**Windows 10 / Node 24 實測**，不是推論。

### ✅ 已修（2026-08-07）：split transport 的 write half 有未讀 bytes 就永遠不會死

**症狀**：把 duplex（SSH channel、`net.Socket`）當 output half 交出去時，它的
read side 在這個 package 裡沒人讀。Node 的 `end` 只在「buffer 讀完 **且** 收到
EOF」才發，`close` 只在兩邊都結束才發——所以**只要有一個 byte 沒讀走，整個
物件的所有終結事件都不會發**。實測：21 bytes 未讀，對端 FIN 或 destroy 之後
1.2 秒，`events: []`、`destroyed: false`、`writableEnded: false`、`bytesRead: 21`。
配上出貨預設 `{default: null, prompt: null}`，request 永遠不 settle。

| 對端動作 | 有沒有 drain | events | `destroyed` | `writableEnded` |
|---|---|---|---|---|
| `end()`（FIN） | 沒有 | **無** | `false` | `false` |
| `destroy()` | 沒有 | **無** | `false` | `false` |
| `end()`（FIN） | `resume()` | `end`,`finish`,`close` | `true` | `true` |
| `destroy()` | `resume()` | `end`,`finish`,`close` | `true` | `true` |

**修法**：`writableToNodeStream` 預設 drain write half 的 read side
（`WritableToNodeStreamOptions.drainReadSide`，預設 `true`）。drain 後 `close`
在 0–1ms 內到。

兩個實作細節值得記：

- **一定要用 `resume()`，不能用「掛一個空的 `on('data')`」**。實測後者對
  explicitly paused 的 stream 完全無效，四格全部維持「無事件」。Node 文件寫得
  很清楚：`data` listener 只在 stream *沒被明確 pause* 時才會切 flowing mode，
  而「沒人讀的 write half」正好就是被 pause 的那種。
- **丟掉那些 bytes 是對的**。split transport 的 ACP input 是**另一個物件**，
  write half 上進來的 bytes 不是協定輸入。若同一個 socket 同時當 input
  （duplex 形狀），先掛的 `data` listener 仍然收得到全部（實測：buffer 裡的
  `PRELOAD` 和後來的 `AFTER` 兩種建構順序都拿得到），所以預設開著是安全的。

**前三輪為什麼沒抓到**：程式與測試裡都寫著「`ndJsonStream` 反正會把 input
drain 掉」。那句話對的是 **input stream**——split transport 下那是另一個物件，
沒有任何東西 resume 過 write half。測試甚至自己手動 `ours.resume()` 來繞過，
註解還寫「真的 split transport 會讀自己那半」，方向剛好相反。這兩處註解都已改掉。

**負向對照**：把 drain 關掉重跑新測試，兩個 cell 都是 `HUNG`；打開就過。

### ⚠️ 盲區一：活著的 child 關掉自己的 stdout，parent 收不到任何東西

`process.stdout.end()` 與 `fs.closeSync(1)` 都試過，8 秒內 parent 的
`child.stdout` **沒有 `end`、沒有 `close`、沒有 `error`**，`readableEnded` 一直
是 `false`，child 一直活著。所以 `connectAcpAgentProcess` 文件裡「stdout ending
or breaking 這條有接」在 Windows 上對這個形狀是**空頭支票**——它真正會觸發的
時機是 child *結束*（OS 關掉 pipe），或別的平台。

之前的註解說「libuv 把 pipe 的 write side 開著到 process 結束，真正的 agy 或
claude-agent-acp binary 沒有這個限制」。**這句話沒有實測支撐**：`fs.closeSync(1)`
是直接關 fd、完全不經過 libuv stream，一樣什麼都沒有，所以問題出在 Windows 的
pipe handle 模型，跟「是不是 Node 寫的 child」無關。這條路在 Windows 上對
production 是否可達，現在標記為**未驗證**；已驗證的是 socket transport 會走到
（acpClient.test.ts 用真 socket 跑 EOF），以及 EOF 真的來時 wiring 會動。

倉庫裡唯一的覆蓋本來是 `PassThrough` 做的 `SilentChild` stub，它重現不了這件事
（`PassThrough.end()` 立刻發 `end`，真 pipe 不會）。現在加了
`tests/fixtures/stdoutClosingAgent.mjs` 與一個**把盲區本身釘成斷言**的測試。

### ⚠️ 盲區二：活著的 child 不再讀 stdin，完全沒有訊號

沒有 `EPIPE`、沒有 `error`、沒有 `close`，write 只是被 buffer 起來。

⚠️ **這一段先前的數字是錯的，而且錯了四輪。** 舊文寫「第一個 200-byte write 2ms
內 callback，接下來兩個再也沒有 callback」。第九輪以 20 個全新 child 重測：

```
第一個 200-byte write   0.091–0.251 ms callback（沒有任何一次 ≥ 1ms）
200B × 3、200B × 5      全部 callback
2MB write               writableLength = 2 097 152（不是 2 097 552）
```

真正的規則是 **OS pipe buffer 約 48–64 KiB**，不是「第二次就卡住」。一個典型的
ACP 請求約 150 bytes，所以**一般請求永遠不會讓 `writePendingMs` 動**——這正是
UI 分不出「在想」和「卡死」的原因（見下方盲區三）。

這句話活過四輪的機制值得記下來：每一輪都改了程式碼註解、把這份文件留到下次。
**而這份文件是每一輪 agent 被指定去推導的設計源頭**，所以錯誤數字每輪都被重新
繼承一次。文件裡的實測數字和程式碼註解要一起改，否則改的那份會被沒改的那份覆蓋。

順帶更正：舊註解說「write-side EPIPE 配健康的 stdout 曾經 hang 了 6007ms」。
**這個測不出來**——這個形狀在 Windows 上根本不會產生 EPIPE。註解已改。

後果：`initialize` 只會靠 30s 預設 budget 收場；`session/prompt`（出貨 budget
是 `null`）會永遠轉圈，而且**一句診斷都沒有**。

### 對策：unbounded prompt 必須配一個 UI 看得見的東西

`prompt: null` 是刻意的（turn 要多久就多久，設 cap 早晚會砍掉真工作），但
ACP **沒有 heartbeat**——在想事情的 agent 和卡死的 agent 送出來的東西一模一樣，
就是什麼都沒有。所以「安靜」不能拿來當失敗判準，docs 前面量過 agy 一個 8 秒的
turn 有 83% 時間是安靜的。

能誠實給的是**事實**，不是判決：

- `AcpAgentHandle.status()`——pull-based，**預設就有，不用設定、不用註冊
  callback、不開任何 timer**。回傳每個還在等的 request 的 `elapsedMs`、
  `silentMs`、`writePendingMs`，以及連線層的 `alive` / `failure` / `silentMs`。
  UI 本來就要為進行中的 turn 畫經過時間，所以它本來就有 ticker。
- `ConnectAcpAgentOptions.onStall` + `stallAfterMs`（預設 30s）——push 版本，
  給沒有 ticker 的呼叫端。跨過門檻後每 `stallAfterMs` 重報一次，`silentMs`
  會長大。**這是 report 不是 verdict**：不取消、不 reject 任何東西。
- `AcpRequestStatus.reason` 分兩種，差別是有意義的：`'awaiting-reply'`（bytes
  已經交出去，agent 還沒回，跟「正在工作」無法區分）vs `'write-not-accepted'`
  （write 還卡在 transport 沒被接受——盲區二**唯一**會產生的可觀測量）。

門檻取 30s 是因為要躲開上面那個「healthy turn 也會安靜好幾秒」的事實；報太早
會被使用者訓練成忽略它，那比不報還糟。測試裡有一個 CONTROL 專門守這件事：
一直在吐 bytes 的 agent 不可以被報成 stalled（負向對照：把 inbound 記錄拿掉，
該測試立刻收到 4 個假 stall）。

## 影響範圍

```
清掉（純粹在補「沒有協定」）              留下（UI 層 + 協定層）
  agyTerminalModel.ts        1104          ChatTimeline.tsx          475
  agyScreens.ts               696          AgyReply.tsx              223
  AgyCliSurface.tsx          2333          AssistantMarkdown.tsx     306
  agyRealScreens.test.ts      697          ChatComposer.tsx          507
  agyTerminalModel.test.ts    559          MessageAttachments.tsx    296
  agyScreens.test.ts          381          styles/chat.css           493
  agyPtyIntegration.test.ts   151          streamParser.ts           321
  ─────────────────────────────────        ──────────────────────────────
                             5921                                   2621
```

**使用者 2026-08-07 已授權直接動這些程式碼，不需逐項確認。** 那些測試記錄的是
刮畫面架構本身的坑（footer 誤判、echo 捲出視窗、cursor 混入回覆）——架構刪掉後
這些知識就失效了，跟著一起刪，不必保留。

唯一的順序限制不是謹慎，是**讓每一次 commit 都還跑得起來**：刪除必須排在
「UI 已接上 SessionUpdate」之後。反過來做的話，中間會有一段 agent page 兩邊
都不通，而且測試基準（690 passed）失去比較意義，驗證就沒東西可靠。

## 驗收標準：Claude / Codex / AGY 三者都要跑通

使用者 2026-08-07 定的完成條件——**不是 AGY 能動就算完成**。好消息是三者的 ACP
路徑都有著落，而且只有一個要我們自己維護：

| agent | 怎麼講 ACP | 誰維護 |
|---|---|---|
| Claude | `@agentclientprotocol/claude-agent-acp`（亦見 `@zed-industries/claude-agent-acp`） | 協定官方 |
| Codex | `npx -y @agentclientprotocol/codex-acp`（`CODEX_PATH` 可換 binary） | 協定官方 |
| AGY | `packages/adapter-agy`（我們寫的） | **我們** |

Claude 與 Codex 因此是**設定問題不是開發問題**。CozyPad 長期只需維護 AGY 一個
adapter——這也是統一協定的回報之一。

`codex-acp` 值得注意的兩點：
- `INITIAL_AGENT_MODE` = `read-only` / `agent` / `agent-full-access`，直接對上
  CozyPad 的 permission mode 下拉選單。
- 它會在 `initialize` 宣告 **ACP auth methods**（ChatGPT 登入 / `CODEX_API_KEY`）。
  ⚠️ 我們的 adapter 目前 `authenticate` 直接回 `{}`，client 端也從未處理「agent
  要求認證」這條路徑。接 Codex 之前必須補。

## 參考實作：formulahendry/acp-ui

[formulahendry/acp-ui](https://github.com/formulahendry/acp-ui) 是同型產品，值得逐項
對照而不是重新發明：

- 桌面（Tauri）+ 手機 + web，對上 CozyPad 的 Electron + Capacitor。
- 已具備 session 管理、**權限核准**、**tool call 視覺化**、**可收疊的 agent
  thinking**——與 CozyPad 2026-08-07 做的三樣重疊。
- 每個 agent 的啟動指令集中在 `agents.json`（設定檔驅動，不是寫死的 adapter），
  設定存在 `%APPDATA%\acp-ui\agents.json`。**CozyPad 應照抄這個做法**：agent 清單
  是設定，加一個新 agent 不該需要改程式碼。
- 手機／web 用 `@rebornix/stdio-to-ws` 把本機 agent 包成 WebSocket endpoint。
  ⚠️ **這對 CozyPad 的 SSH 與手機情境是關鍵**：ACP 是 stdio，遠端只能靠 port
  forward 或這樣包一層。設計 RoutingTransport 與 ACP 的交界時要一起考慮。

## 參考實作：fathah/hermes-desktop（UI 與資訊架構）

使用者 2026-08-07 指定的視覺參考。技術棧是 **Electron + Vite + TypeScript**
——跟 CozyPad 完全相同，所以它的做法可以直接搬；`acp-ui` 是 Tauri + Vue，
思路可借但程式碼不能。兩者分工：

- **hermes-desktop → UI / 資訊架構**（同棧）
- **acp-ui → 協定與設定驅動**（同協定）

它有而 CozyPad 沒有、且明顯該有的：

1. **chat footer 顯示即時 token 與成本。** agy 的 stream 每一步都帶 `usage`
   （input / output / thinking / cache_read），現在全被丟掉。這正好餵養使用者的
   第三個產品目的（agent 跑 CV 實驗要能確定性驗證成本）。
   ⚠️ ACP 的 `session/update` 本身不帶 usage——要走 `_meta`，跟 conversationId
   同一條路。
2. **Sessions 是獨立畫面，且用 SQLite FTS5 做全文檢索。** CozyPad 目前只有側欄
   一個 filter 框，比對的是標題。ACP 的 `session/list` 有分頁，接得上。
3. **一個關注點一個畫面**（Chat / Sessions / Agents / Skills / Models / Memory /
   Tools / Schedules / Settings）。CozyPad 的 workspace 分法相近，但 agent 設定
   目前散在各處——對照 acp-ui 的 `agents.json`，這兩個參考指向同一件事：
   **agent 是資料不是程式碼**。
4. Chat 具備 markdown + syntax highlighting + tool progress + slash commands +
   session resumption——CozyPad 都有了，這部分不用抄，但可拿來對照完整度。

**不要抄的**：它的 Gateway / Soul / Office 是 Hermes Agent 專屬概念，與 CozyPad
的三個產品目的無關。

## 階段

- **P1** ACP client 骨架 + 自寫 AGY adapter（雙 transport：cli / connect）
  ← spike 已通 cli 路徑，待落地成 package
- **P2** ~~查 AGY local Connect API~~ ✅ 已查（見上）：Connect transport 存在，
  逐次審批可解；推理文字仍未知
- **P3** UI 改吃 SessionUpdate，刪刮畫面層
- **P4** Claude → `@zed-industries/claude-agent-acp`；Codex 包 app-server
  （2026-08-07 起 Claude Code 2.1.224 已裝在本機，**這半段現在可以實機驗證了**，
  先前的授權限制解除）

## 測試慣例

**實機測試一律選 Sonnet**（使用者指定）。驗證在意的是協定往返、串流、工具呼叫、
審批流程，不是回答品質；Opus 每輪成本與延遲都高得多，還會吃掉使用者自己的額度。
agy 對應 `Claude Sonnet 4.6 (Thinking)`（`modelId: claude-sonnet-4-6`，enum
`MODEL_PLACEHOLDER_M35`——會隨版本變動，要現查 `GetCascadeModelConfigData`）。
CLI 這條路直接下 `--model claude-sonnet-4-6`（`agy models` 可列出目前可用的 id）；
不下這個旗標會用**持久化的**預設模型（實測 `Gemini 3.6 Flash (Low)`），錄 fixture
或跑實驗時務必帶上。2026-08-07 第七輪起 `buildAgyArgv` 已經會送 `--model`，所以
`proveWorkspace.mjs` 之類的 script 是把 model 傳給**出貨的** builder，不是事後
自己在 argv 後面補旗標。

**fixture 一律是 verbatim 錄音。** `packages/adapter-agy/tests/fixtures/*.ndjson`
全部是 `agy -p … --output-format stream-json` 的原始 stdout，未經編輯。手寫 fixture
曾經讓 `status: 'failed'` 那條分支「有測試」卻沒有證據，還把 `error.type` 猜錯
（`TOOL_EXECUTION_ERROR` vs 真值 `TOOL_ERROR`）——**不要再用自己寫的樣本去證明
wire 的形狀**。真的錄不到，就刪分支並在這份文件寫下錄不到。

錄音的方法本身也 checked in，因為「這是真錄音」不該是一句要人相信的話：

- **`tests/fixtures/record.mjs`** 是唯一寫過這些檔的東西。prompt 寫在裡面，
  `--model claude-sonnet-4-6` 與 `shell: false` 寫死，跑完印出 argv、exit code、
  bytes、md5。用法 `node tests/fixtures/record.mjs <name>`。
- **`tests/fixtures/README.md`** 記日期、agy 版本、md5、每份錄音在證明什麼。
- **`tests/provenance.test.ts`** 在 fixture 與該表對不上時失敗（md5、大小、
  有檔沒記／有記沒檔、NDJSON 是否完整到 `result` 事件）。重錄本來就會改 md5——
  它要求的只是「順手把 README 一起改」，而那是 reviewer 看得見的改動。
- **測試不寫死 conversation id、step index、tool output**，一律從當下載入的
  fixture 讀回來。否則重錄一次就要改一堆斷言，而那個成本正是「乾脆手改 fixture」
  的來源。

## 用第三方 ACP agent 做一致性檢驗

`packages/acp-client` 目前只跟我們自己寫的 `packages/adapter-agy` 講過話。兩邊
出自同一次設計，可能共享同一個對協定的誤解——那種情況下測試全綠證明不了
一致性。

Claude Code 2.1.224 **沒有原生 `--acp`**（`claude --help` 查證過），但
`@zed-industries/claude-agent-acp`（Zed 寫的，ACP 作者本人）可以當獨立實作。
拿 acp-client 去驅動它，才是真的協定一致性檢驗。P4 之前就該做這一步。

Spike 程式碼在 session scratchpad 的 `acp-spike/`（`agy-acp-agent.mjs` +
`spike.mjs` + `probe-tools.mjs`），要落地時搬進 `packages/`。

### ✅ 已解決（2026-08-08 第十輪）：七個「值收得下、之後被默默丟掉」的缺口

前九輪的缺陷全部是同一種病：一個值在 API 邊界被接受，然後被安靜地丟掉或誤報
（`rawOutput` 被收窄、`tool_info.output` 沒宣告、`resource_link` 被過濾、`cwd`
被忽略、preload bytes 被排掉、「沒 pin」被升級成「已 pin」）。第十輪把最後七個
補上，每一條都用**變異測試**證明會咬，不是靠「加了測試」這句話：

| 變異 | 位置 | 結果 |
| --- | --- | --- |
| `pinsModelByDefault: false` → `true` | `adapter-agy/src/agent.ts` | KILLED |
| `AGY_LIMITATIONS` 偷加一個未主張的欄位 | 同上 | KILLED |
| `AGY_MODEL_CATALOG_TTL_MS` → `MAX_SAFE_INTEGER` | 同上 | KILLED |
| `AGY_PERMISSION_NOTICE` 清空 | 同上 | KILLED |
| `modelListTtlMs ?? 600_000` → `?? 0` | `adapter-agy/src/cliTransport.ts` | KILLED |
| `modelListTtlMs ?? 600_000` → `?? 1` | 同上 | KILLED |
| `nodeStreams.ts:545` 的 `stream.resume()` 刪掉 | `acp-client/src` | KILLED |
| `initialize` 永遠丟掉 `_meta` | `acp-client/src/connect.ts` | KILLED |
| `initialize` 預設版本改成 `999` | 同上 | KILLED |
| `prompt` / `cancel` 偷加一個欄位 | 同上 | KILLED ×2 |
| `logout` 丟掉 `params` | 同上 | KILLED |

`pinsModelByDefault` 是這一輪存在的理由：它在 `src` 出現一次、在 `tests` 出現
**零次**，翻成 `true` 可以通過當時全部 376 個測試與四個 tsc 專案。客戶端讀到
`true` 會認為新 session 已經在指定模型上，於是跳過 `session/set_config_option`，
整輪跑在 agy 的持久化預設（本機是 Gemini 3.6 Flash Low）——而同一個回應裡的
`cozypad.dev/agy-model` 區塊還寫著 `pinned: false`。六個負面能力布林值裡有五個
被釘住，唯一沒被釘住的正好是講 model pinning 的那個。

**新陷阱（這一輪自己踩到的）：vitest 綠燈 ≠ 測試有型別檢查。** 上一輪產出的
測試在 vitest 全過，但 `tsc -p tsconfig.tests.json` 抓到 `as const` 讓 `prompt`
變成 readonly tuple、不符 `PromptRequest`。vitest 用 esbuild 轉譯，型別是被丟掉的。
**任何新增的測試檔都要同時過 vitest 與該 package 的 tsc 專案**——`acp-client`
是 `tsconfig.tests.json`，`adapter-agy` 是 `tsconfig.json`（它的 `include` 已含
`tests`）。

**變異測試的操作規則**（第八輪 `spawnSync('npx')` 捏造七個假擊殺之後定下的）：
用 `process.execPath` 直接跑 `node_modules/vitest/vitest.mjs`，不要走 `npx`
（node 24 會回 EINVAL/ENOENT 且 `status: null`，把 `status !== 0` 當成「殺掉」
就會得到假信心）。變異一次只改一處、跑完立刻還原、最後用 `cmp` 逐檔確認
source 回到原狀——這一輪十二個變異全部照這個流程跑完，`git status` 只剩兩個
未追蹤目錄，沒有任何 source 被留下。

## ✅ 驗收達成（2026-08-08）：Claude / Codex / AGY 三家跑通同一支 client

`scripts/probe-acp-agent.mts` 用 **同一支 `packages/acp-client`、同一段程式碼**
驅動三家 agent，只有 spawn 那一行不同。這是整個遷移的核心主張，所以它必須是
可重跑的腳本而不是一段散文：

```
pnpm tsx scripts/probe-acp-agent.mts claude
pnpm tsx scripts/probe-acp-agent.mts codex
pnpm tsx scripts/probe-acp-agent.mts agy
```

Prompt 一律是 `Reply with exactly: OK`，三家都 `stopReason = end_turn`：

| | claude-agent-acp 0.23.1 | codex-acp 1.1.14 | adapter-agy（我們的） |
|---|---|---|---|
| protocolVersion | 1 | 1 | 1 |
| 回應耗時 | 1679ms | 3882ms | 6548ms |
| authMethods | （已登入，空） | `api-key`, `chat-gpt` | （不適用，空） |
| `loadSession` | ✅ | ✅ | ❌ |
| sessionCapabilities | fork, list, resume, close | resume, list, close, delete, additionalDirectories | resume, additionalDirectories |
| promptCapabilities | image, embeddedContext | image, embeddedContext | 全部 ❌ |
| mcpCapabilities | http, sse | http | ❌ |
| model 數量 | 3 | 7 | 12 |
| 實測釘住的 model | `sonnet` | （未釘，7 個 GPT 可選） | `claude-sonnet-4-6` |
| session/update 種類 | `available_commands_update`, `agent_message_chunk`×2, `usage_update` | `available_commands_update`, `session_info_update`×3, `agent_message_chunk`, `usage_update` | `agent_message_chunk`×2 |
| 審批請求次數 | 0 | 0 | 0（**永遠是 0**，見下） |

### 三個直接影響設計的量測結果

**一、model picker 是真的統一的。** 三家都用 ACP 標準的
`session/set_config_option` + `configId: "model"`，並在 `session/new` 回應裡
advertise 可選清單。`claude-agent-acp` 的 `dist/acp-agent.js` 裡就是
`else if (configId === "model")`，和我們 `adapter-agy` 的 `AGY_MODEL_CONFIG_ID`
是同一個機制——不是我們自己發明的慣例。**一個 UI 元件涵蓋三家。**

**二、能力差異正好落在「呈現為不可用」的那條線上。** agy 的
`loadSession: false`、`promptCapabilities` 全 false、沒有 MCP，另外兩家都有。
這正是 [[cozypad-product-goal]] 講的「差異只在 Adapter 層吸收，能力不足呈現為
不可用而非改變版面」——而且現在是**從線上讀到的**，不是猜的。

**三、審批那條缺口在協定層是看得見的。** agy 三次探測都是 0 個
`session/request_permission`，而且 `initialize` 的 `agentCapabilities._meta`
裡直接帶著 `cozypad.dev/agy-limitations`，client 一開始就讀得到
`requestsPermission: false`。另外兩家有真的審批機制。UI 要據此把 agy 的
審批相關控制項標成不可用，而不是假裝有。

### 兩個 CLI 都沒有原生 ACP（實測，非文件）

- **claude 2.1.224**：`claude --help` 沒有 `--acp`。只有雙向的
  `--input-format stream-json` / `--output-format stream-json`。走 ACP 要靠
  `@zed-industries/claude-agent-acp`（Zed 寫的，ACP 作者本人）。
- **codex-cli 0.146.1**：子指令有 `mcp-server`、`app-server`，**沒有 `acp`**。
  要靠 `@agentclientprotocol/codex-acp`，而且它會連帶裝自己的
  `@openai/codex@0.147.0`——**不是**使用者本機那支 0.146.1，版本會分岔。

兩個橋接器都依賴 `@agentclientprotocol/sdk`，和我們同一套，所以三方都在同一個
協定版本上。

### spawn 的硬規則

一律 `node <dist/index.js>`，**不要走 `.CMD` shim**（那需要 shell），而且
**永遠不要 `shell: true`**——Windows 上它會把 argv 串成一個未跳脫的字串。
`scripts/probe-acp-agent.mts` 把 argv 印出來就是為了這件事可被檢查。

腳本在送出任何 prompt 之前會先從 agent 自己的 model 清單確認身分，並且
`/opus/` 命中就中止（測試一律 Sonnet，見「測試慣例」）。這條是因為早先一次
CLI 預設值把探測導到了錯的 agent，花掉使用者的付費額度。

### 還沒解決的（B1）

`serveAgyOverStdio` 目前唯一的執行進入點是 `scripts/agy-acp-entry.mts`，靠 tsx
跑。**出貨要的是 esbuild entry**：`apps/desktop/esbuild.mjs` 現在只有
`src/main/main.ts` 和 `src/preload/preload.ts` 兩個 entryPoints，要加第三個把
adapter 打包成 `dist/agy-acp.cjs`，再由 main 用 `spawn(process.execPath, [...])`
拉起來。另外兩家不需要這一步——它們本來就是可執行的 npm 套件。

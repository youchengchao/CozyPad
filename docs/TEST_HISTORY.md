# CozyPad test history

This file records why a test run was performed and what actually passed. The
test source remains the exact inventory of assertions; this history records the
development evidence without copying hundreds of test names that would become
stale.

## How to read the record

- **Automated suite** means every Vitest test under `apps/` and `packages/`.
- **Focused regression** means the tests closest to the changed behaviour.
- **Real smoke** means a real executable, shell, archive tool, or runtime was
  used instead of a fake transport.
- Opt-in smoke tests are skipped by the ordinary suite because they may start a
  locally installed agent or depend on personal machine state.
- A change is complete only when its focused regression, relevant typechecks,
  and production builds pass. A real smoke is added when a fake cannot prove
  the behaviour that failed for the user.

## Current automated inventory

This is the complete current test-file inventory. The result column reflects
the full run on 2026-08-05; individual assertions and fixtures remain in the
linked source files so the inventory cannot silently diverge from executable
behaviour.

| Area | Test files | Motivation | Current result |
| --- | --- | --- | --- |
| Renderer — AGY native UI | `agyPtyIntegration`, `agyRealScreens`, `agyScreens`, `agyTerminalModel` | Keep real AGY screen recognition, terminal-to-chat projection, input modes, status, recovery, and reply extraction stable. | Passed |
| Renderer — Agent conversation | `agentSessionViewState`, `attachmentBuffer`, `chatComposer`, `messageAttachments` | Protect blank startup/preview/Resume state, buffered delivery, pasted media, prompt navigation, and sent-attachment presentation. | Passed |
| Renderer — platform and workspaces | `capacitorBridge`, `fileDownload`, `fileNavigation`, `mockBridge`, `pdfDocument`, `reconnectPolicy`, `terminalInteraction` | Preserve mobile telemetry bridging, safe downloads/navigation, deterministic mock state, PDF resource cleanup, reconnect backoff, and terminal scroll controls. | Passed |
| Desktop — Agent lifecycle | `agentCommunicationService`, `agyTranscript`, `codexAppServer`, `localAgentRuntime`, `routingAgentRuntime` | Protect session generations, transcript identity, Codex events, local runtime control, and local/remote runtime routing. | Passed |
| Desktop — real AGY Resume | `agyResume.integration` | Prove a persisted AGY record can resume through the installed executable under its real Windows user context. | Skipped by default; passed when explicitly enabled |
| Desktop — transport, profile, trust | `hostKeys`, `localTransport`, `profileStore`, `routingTransport`, `ssh2Transport` | Protect host verification, local and SSH transport behaviour, secret/profile storage, and routing boundaries. | Passed |
| Claude adapter | `command`, `streamParser` | Keep command construction isolated and normalize Claude streaming events safely. | Passed |
| Shared contracts | `agentCommunication`, `agentSession`, `contracts`, `research` | Reject invalid IPC/state data and preserve attachment, identity, connection, terminal, download, and research invariants. | Passed |
| Remote file services | `shellFilesListing`, `shellRemoteFiles` | Protect shell argument isolation, bounded metadata listing, writes, copies, moves, and deletion requests. | Passed |
| Telemetry | `telemetry` | Parse CPU, memory, and GPU observations without confusing unavailable values with zero. | Passed |
| Test infrastructure | `mockPty` | Keep deterministic terminal fixtures faithful enough to exercise interactive flows. | Passed |
| Persistent runtime | `tmuxRuntime`, `tmuxSetup` | Protect session naming/reconciliation, version detection, user-level installation, failure reporting, and scoped cleanup. | Passed |

## 2026-08-05 — AGY native media, direct paste, and attachment preview

**Motivation**

Sending a PNG to AGY produced `Agent execution terminated due to error`,
including the reported `-24` and `-27` error instances. Sent attachments also
needed to remain in the conversation and open in a modal for inspection.

**Diagnosis**

- The AGY log for the failed `123` turn recorded `items=1, media=0`, followed
  by `media has no inline data` and a provider `INVALID_ARGUMENT` response.
- The old prompt path was added twice and a path-only media item was persisted
  in AGY's native conversation. Resuming that same poisoned native history can
  therefore reproduce the provider error even for a later prompt.
- The supported local AGY media route is its native paste input. Remote native
  paste requests one compressed media archive over the terminal channel.
- CozyPad now keeps file transfer batching separate from Agent delivery:
  non-media files receive exact conversation-local path references, while
  images enter AGY through native media input.

**Real UI coverage and result**

- Started the production Electron application, opened the AGY page, and
  confirmed that a fresh launch left the conversation surface blank — passed.
- Created the real `cozypad-media-e2e` session, selected a PNG through the
  visible attachment flow, and sent one prompt — passed.
- AGY's log recorded `Clipboard image read (Windows Win32): 108 KB` and
  `items=1, media=1`; AGY then described the displayed CozyPad screenshot —
  passed.
- The submitted prompt appeared once, not twice — passed.
- Attached the real project `package.json`; AGY read its conversation-local
  copy and replied `FILE_OK` — passed.
- Clicked the submitted image card and observed the full image modal; clicked
  the submitted JSON card and observed its bounded text modal — passed.
- Closed the modal with Escape — passed.
- Put a PNG in the operating-system clipboard, focused the real AGY composer,
  pressed Ctrl+V, and observed an `image.png` buffered item; removed the unsent
  test buffer through the visible remove action — passed.

**Automated coverage and result**

- Native terminal error recovery, historical-error filtering, prompt
  reconciliation, compressed media archive construction, file-reference
  construction, and attachment preview classification — passed.
- Full automated suite: 37 test files passed; 387 tests passed; the 1 opt-in
  real AGY Resume smoke remained skipped by default — passed.
- Typecheck: renderer, desktop, and contracts — passed.
- Production build: Vite renderer and Electron main/preload — passed.

The real E2E session was intentionally separate from `123`. CozyPad prevents
new path-only media records, but removing the bad turns already stored inside
AGY's native `123` conversation requires an explicit history-changing recovery
such as rewind and is not performed automatically.

## 2026-08-05 — AGY session `123` Resume

**Motivation**

The persisted local AGY session named `123` remained in `disconnected`. Resume
accepted only `exited` and `error`, returned the disconnected bundle unchanged,
and the renderer surfaced that as an error. The legacy record also had no AGY
conversation identity, so `--continue` could later select a different
machine-wide latest conversation.

**Coverage and result**

- Focused service regression: a disconnected session with a missing in-memory
  runtime creates one replacement generation and reaches `ready` — passed.
- Existing live-runtime regression: an error/disconnected marker never kills a
  runtime whose bound generation is still alive — passed.
- Late-follower regression: an old runtime's delayed exit cannot overwrite the
  resumed generation — passed.
- AGY identity regression: the first legacy local Resume binds the discovered
  conversation ID, launches with `--conversation <id>`, persists the binding,
  and reads that conversation's transcript — passed.
- Real smoke: cloned the real persisted `123` record, used its AGY kind, local
  profile, terminal mode, working directory, and the installed AGY executable;
  no prompt was sent. Resume reached `ready` with a live runtime in 2.45 s —
  passed.
- Real Electron UI: selected `123` in preview, pressed Resume, and observed the
  managed runtime reach `ready`. The first UI run then regressed about 150 ms
  later because a historical error banner in restored terminal scrollback was
  classified as a new runtime error. Limiting error recognition to the current
  unrecovered terminal tail kept the resumed session ready — passed.
- Turn-error boundary: an AGY prompt failure remains visible as a failed turn
  while the live CLI stays ready for feedback or another prompt; it no longer
  changes a healthy runtime into an exited workspace session — passed.
- Isolation control: the same smoke under the restricted test user failed at
  `cd /c/Users/ycchao` with `Permission denied`; rerunning in the real Windows
  user context passed. This distinguishes sandbox access from a corrupt AGY
  conversation.
- Process hygiene: after smoke cleanup, no new `agy.exe` remained — passed.
- Focused tests: 33/33 passed.
- Full automated suite: 37 test files passed; 381 tests passed; the 1 real AGY
  smoke remained skipped by default — passed.
- Typecheck: desktop, renderer, and contracts — passed.
- Production build: Electron main/preload and Vite renderer — passed.

Run the real smoke explicitly on the machine that owns session `123`:

```powershell
$env:COZYPAD_REAL_AGY_RESUME_TEST = '1'
node node_modules/vitest/vitest.mjs run apps/desktop/tests/agyResume.integration.test.ts
```

## 2026-08-04 — Attachment batch, pasted screenshot, and timeline display

**Motivation**

Individual upload requests caused unnecessary round trips, Windows drive paths
failed during tar extraction, pasted screenshots were not accepted, and sent
attachments were not visible in the persisted conversation timeline.

**Coverage and result**

- One buffered archive per send, multiple attachment metadata records, batch
  limits, invalid base64, oversize files, failed-unpack cleanup, and retry —
  passed.
- Real tar archive listing/extraction and the Git Bash `cygpath` drive-path flow
  used by the desktop app — passed.
- Clipboard image buffering, attachment button behaviour, draft preservation,
  image/file timeline rendering, and persisted attachment metadata — passed.
- Full automated suite at that checkpoint: 37 test files and 380 tests —
  passed.

## 2026-08-04 — Session preview, explicit Resume, and contextual actions

**Motivation**

Opening CozyPad auto-selected an old conversation; selecting an exited session
implicitly started it; and a primary click exposed rename/delete instead of
only selecting the session. The requested behaviour separates preview from
runtime entry and reserves contextual actions for right-click or long-press.

**Coverage and result**

- Fresh-open blank state, per-agent selection, preview without runtime entry,
  explicit Resume, and exited/error fallback to preview — passed.
- Primary click/short tap/keyboard selection, desktop right-click, mobile
  long-press, and synthetic-click suppression after long-press — passed.
- AGY terminal parsing and UI edge cases remained in the automated suite —
  passed.

## 2026-08-06 — Mock removal, real-app verification loop, AGY UI smoke revival

**Motivation**

UI defects were being judged from unit tests alone. The runtime mock mode was
also drifting from the real transports, so what the tests exercised and what a
user meets had started to diverge. Both were removed as sources of false
confidence.

**Changes**

- Runtime mock mode deleted: `mockBridge`, `mockTransport`, `COZYPAD_MOCK`,
  the `Mock Host` profile and the `MOCK DATA` badge. `mockPty` and
  `sshFixtures` stay — the real test suite uses them.
- Startup no longer auto-connects to the local machine (SPEC 2.1). The app
  opens disconnected and waits for an explicit Connect.
- `agyScreens` limit parsing: AGY 1.1.10 prints `Weekly Limit Remaining`, so a
  heading anchored on a trailing "Limit" dropped every rate limit silently. An
  untouched limit reads `Quota available` instead of `N% remaining`, so the
  gauge line is now read as the fallback source of its number.
- A context screen with no total no longer reports 0% used. Unknown and empty
  are different claims.
- The AGY statusline said nothing when quota was unknown but context was
  known, because the hint required *both* to be missing. Each missing figure
  now names itself.

**AGY UI smoke harness**

The harness had stopped at assertions the product deliberately no longer
satisfies, so it had been failing before reaching any UI worth checking:

- It expected a primary click on a session row to open the Rename/Delete menu.
  Since 2026-08-04 that menu is right-click or long-press only.
- It waited for the chat surface without pressing Resume. Selecting a session
  previews it; entering the runtime is explicit.

Both were fixed in the harness, not the product. Each `markStage` records the
raw terminal bytes and the rendered surface text at the same instant, which is
what makes "the terminal said X, the UI drew Y" checkable at all.

**Result**

- Automated suite: 382 passed, 1 skipped. Typecheck clean.
- Harness now advances to the automatic context/usage status gate, where the
  quota figures still fail to reach the statusline. Open.

## 2026-08-06 (later) — AGY UI smoke harness green end to end

The quota gate that every run had died on turned out to be a second copy of
the same trailing-"Limit" anchor, inside `parseQuotaReport` itself. On AGY
1.1.10 every group parsed with zero gauges, `status.limits` became an empty
array — which is a claim, not an absence — and the statusline showed nothing
while the raw terminal plainly listed both limits. Fixed the heading match,
normalised the stored label, and made an empty parse leave the field absent.

Result: `--agy-smoke-test` passes end to end for the first time this session —
session create, Resume, status sync, all five slash overlays, a real prompt
round-trip, and Stop, with 18 raw-terminal/rendered-text observation pairs.
Suite: 383 passed, 1 skipped. Handoff for the next session: docs/HANDOFF.md.

## 2026-08-06 (cont.) — agy-vs-unified batch: all 8 inventory items fixed

First batch from docs/agent-page-inventory.json (`agy-vs-unified`), all
confined to `AgyCliSurface.tsx` plus one guard in `agyTerminalModel.ts`.
No Claude/Codex path was touched.

1. **Draft no longer hides the interaction area.** `showPanel` and the
   overlay render dropped their `draft === ''` conditions, and
   `isAgyComposerEditable` now refuses approval/question modes even with a
   non-empty draft — a leftover draft used to blank the approval card while
   silently routing keystrokes into a CLI waiting for y/n.
2. **Timeline no longer force-scrolls on every repaint.** The spinner
   changes the screen fingerprint several times a second; the effect now
   follows output only within 160px of the bottom (ChatTimeline's rule) and
   restores each session's position from a module-level scroll cache.
3. **Esc no longer clears the draft.** It dismisses the slash suggestion
   list (new `slashDismissed` state, as in ChatComposer) and forwards Escape
   so the CLI closes its own menu. Deviation from the fix sketch: with no
   menu open, Esc is local-only rather than forwarded — forwarding would
   clear the CLI's input row while the draft stays visible, so a bare Enter
   would submit an empty prompt while the timeline records the full text.
4. **Composer stays in the layout under overlays** (SPEC 1057), disabled,
   with the hint naming the reason; `hidden={overlay !== null}` removed and
   the overlay gate folded into `canCompose`.
5. **Transcript preview opens at the newest entry** and shares the same
   per-session scroll cache instead of always showing the oldest turn.
6. **Pending attachments survive leaving the session** via a module-level
   cache keyed by session; object URLs are revoked in
   `clearAgySessionCache` (delete flow) instead of on unmount.
7. **Approval/Question no longer wipes the streamed reply.** The turn
   scraper freezes while `mode` is approval/question — the panel frame was
   being scraped as reply text, which is why the render layer used to hide
   it; the render-layer hiding is gone.
8. **Tool cards no longer print a single-line detail twice**; AGY's
   DiffLines aligned to ChatTimeline's DiffBody (dropped the `diff-file`
   special case) so both agents colour `+++/---` the same way.

Verification: typecheck clean; suite 384 passed / 1 skipped (baseline 383 +
1 new composer-lock test). Real build (`vite build` + `esbuild.mjs`) and
`--agy-smoke-test` green end to end — 18 observation pairs; every overlay
stage now renders the disabled composer with the reason hint (grep over
`observations.json` rendered text), and screenshots confirm the layout
holds. No stray electron processes left behind.

Next: agy-parsing high items (KEY_HINT reply deletion, long-reply tail
overwrite).

## 2026-08-06 (cont.) — agy-parsing: both high-severity parser bugs fixed

1. **Key-hint filtering is now anchored to the row shape.** The old
   `KEY_HINT_PATTERN` matched any line containing `↑ ↓ ← →`, `arrow`,
   `esc to cancel`, … With `→` in an answer (`Renamed userId → user_id`)
   the whole screen turned selectable — the user's own prompt echo became a
   chosen option — and the answer line itself was deleted. New
   `KEY_HINT_ROW_PATTERN` requires a leading key token plus a `·`-separated
   action list (or a `Keyboard:` prefix), and `STANDALONE_KEY_HINT_PATTERN`
   catches bare rows like `esc to cancel`. Applied at the `selectable` gate,
   `isChromeLine`, and `cleanAssistantLine` (whose redundant loose test was
   removed); the loose pattern still serves the exclusion-only sites
   (adjacent-option collection, title picking) and `KEY_HINT_GLOBAL`
   fragment blanking is untouched. One iteration was needed: a leading-`?`
   token wrongly matched the ubiquitous `? for shortcuts … · hig` footer,
   which made transcripts selectable again — caught by the existing
   TRANSCRIPT and bullet-list tests, then dropped.
2. **Long replies no longer lose their opening.** When a reply grows past
   the 40-row window its prompt echo scrolls off, the extractor falls back
   to the last turn block, and the visible tail used to *replace* the
   accumulated text (persisted to localStorage — permanent loss).
   `extractAgyAssistantText` now stitches on the largest whole-line overlap
   (requiring at least one substantive shared row) and only accepts a full
   replacement when no line overlaps at all.

Tests: three new regression cases (arrow-in-prose, key-guidance prose,
scrolled-reply stitching) plus the existing 66 parser tests all green.
Suite: 387 passed / 1 skipped, typecheck clean. Rebuilt (vite + esbuild)
and re-ran `--agy-smoke-test`: green end to end, 18 observation pairs, real
prompt round-trip and all five overlays still parse. No stray electron.

Next: codex-path batch (8 items; requestApproval-produces-no-Card is the
urgent one — local codex CLI available for live verification).

## 2026-08-06 (cont.) — codex-path: launch was dead on arrival; three stuck-turn fixes

Live protocol probe against the actual `codex app-server` (0.146.0, local)
before touching the UI items — and it caught something the inventory
missed:

0. **Codex sessions could not start at all.** `thread/start` was sent with
   camelCase policy values (`unlessTrusted`, `workspaceWrite`); the server
   rejects them with -32600 — its schema wants kebab-case (`untrusted`,
   `on-request`, `workspace-write`, `danger-full-access`; verified via
   `codex app-server generate-ts` v2 AskForApproval/SandboxMode and live).
   Every launch died before binding a thread. `codexPolicyForMode` now
   emits the kebab-case variants; after the fix the probe runs a real turn
   end to end: approval request arrives as
   `item/commandExecution/requestApproval`, our `{decision:'accept'}` reply
   is accepted, the command executes, the turn completes.
1. **permissions/requestApproval black hole closed.** The control-request
   whitelist is now one exported constant (`CODEX_CONTROL_METHODS`) shared
   by the service and the adapter, so a method can no longer be registered
   as a pending control without a card. The permissions branch renders the
   requested profile verbatim; and per the generated schema its reply is a
   granted profile + scope (allow echoes the request for this turn, deny
   grants nothing) — the previously assumed `{decision}` shape would have
   been schema-invalid, exactly what the inventory feared.
2. **Partial answers no longer sent for mixed question batches.** Answer
   completeness is now measured against the request's own question count,
   not just the cards that survived rendering. Interim state, recorded
   deliberately: a batch containing an unrepresentable question now *waits*
   instead of replying with partial data; the fallback card + decline path
   (inventory codex item 2 step 2) is the follow-up that unblocks it.
3. **Approvals/Questions expire (SPEC 3.4.12).** `resolution` gained
   `expired` (questions: optional `expired` flag); pending cards are
   expired when the process exits, errors out, or is relaunched — content
   kept, buttons disabled, Expired chip — and the exit path now emits the
   timeline so the change actually reaches the renderer. Backend guards
   reject answering expired items.

Verification: four new tests (permissions card + granted-profile reply,
mixed-batch hold, exit expiry, adapter parse); suite 391 passed / 1
skipped, typecheck clean on touched packages (contracts/app/desktop; the
mobile package has no tsc setup — pre-existing). Rebuilt and re-ran
`--agy-smoke-test`: one flaky failure mid-harness on the first run
(real-CLI timing), clean green end to end on the immediate re-run. Live
codex probe transcript above is the real-binary evidence for the protocol
fixes. No stray electron/codex processes.

Remaining codex-path items: unrepresentable-question fallback + decline
(item 2 step 2), resume boundary notice (4), fileChange card content +
machine row (5), question batch counter (6), slash owner labels (7),
availability banner + capability matrix (8).

## 2026-08-06 (cont.) — codex-path: unrepresentable questions, decline path, batch counter, richer approval cards

1. **Unrepresentable questions become cards instead of vanishing (SPEC
   3.4.6).** Both adapters (codexAppServer and adapter-claude's
   streamParser had the identical dropping rule) now emit a
   `question_requested` marked `unrepresentable` for free-form input,
   unreadable payloads, and option counts outside 2-6 — raw content in the
   prompt, options empty. The card shows the raw request and offers 拒絕;
   schemas relaxed to `min(0)` options with the new optional flags
   (`unrepresentable`, `declined`, `batchId`).
2. **New decline path end to end.** `declineQuestion` service method → IPC
   channel `agent:question:decline` → preload/bridge → ChatTimeline button.
   One refusal answers the whole request (codex: JSON-RPC error -32800;
   claude: control response deny) and closes every sibling card. This
   resolves the deliberate interim state from the previous entry: a mixed
   batch now holds the reply *and* has an exit.
3. **Question batches are visible (SPEC 1288).** Question items carry
   `batchId` (the request id both protocols already encode in
   `id:index`); multi-question cards show 「本次詢問共 N 題，尚有 M 題未作答」.
4. **Approval cards say machine and, for fileChange, the touched paths.**
   `machine` (optional, additive) fills from the session host on every
   approval — Claude included (SPEC 2.9 requires it; risk is one extra meta
   line). For Codex fileChange approvals the adapter now remembers each
   fileChange item/started's paths in the parse context and uses them as
   the card body, falling back to grantRoot, then the old itemId — the
   generated schema confirms the approval request itself carries no
   file list at all.

Verification: suite 392 passed / 1 skipped (updated mixed-batch test now
walks answer-hold → decline → running; new adapter tests for
unrepresentable and permissions parsing), typecheck clean, rebuilt, AGY
smoke green end to end first try. Live probe addendum: could not get codex
0.146.0 to actually emit `item/tool/requestUserInput` within 180s (the
tool is EXPERIMENTAL per its own schema and may be disabled) — the decline
reply shape rests on the generated schema + unit tests, noted here
honestly. No stray processes.

Remaining codex-path: resume boundary notice (4), slash owner labels (7),
availability banner + capability matrix (8). Then session-state and
composer-attachment batches.

## 2026-08-06 (cont.) — codex-path complete: resume boundary, slash owners, availability banner

The last three codex-path inventory items, plus one persistence bug found
by the tests along the way.

1. **Resume boundary is visible (SPEC 275-278, 1217-1218).** New `notice`
   ChatItem kind (a CozyPad-authored divider, styled so it can never read
   as agent output). When identity rebinding detects a different native
   conversation, the timeline gets a boundary notice — Codex wording states
   a new conversation began; Claude/AGY wording states continuation cannot
   be confirmed. `revive()` records whether the Resume continued the native
   conversation; the session header now shows version + 是否綁定原生對話 +
   本次 Resume 是否延續.
2. **Slash menu says who runs a command (SPEC 1445).** Summary exposes
   `slashCommandOwners` (codex: status/diff → cozypad, compact/review →
   agent — matching the actual sendMessage split); ChatComposer shows a
   「CozyPad」tag on locally-completed commands. A separate field, not
   `slashCommandBehaviors`, which is an interaction hint. The hardcoded
   four-command list stays until a detection basis exists (inventory's own
   recommendation).
3. **Unavailable agents no longer hide the workspace (SPEC 1057, 256-262,
   1084-1097).** The full-pane replacement became a sidebar banner: reason,
   remote environment, and a capability matrix (installed+version,
   structured chat, resume — with the new `resumeStartsNewConversation`
   flag for codex — approval, skip-permissions, launch modes; absent values
   say 未知, not nothing). Session list, previews, and management stay
   usable; `resumeSession` refuses with the reason instead of failing
   downstream. `supportsResume` semantics untouched.
4. **Persistence could break forever after one transient error.** The
   persist queue chained `.then` onto a possibly-rejected promise, so a
   single EPERM (Windows scanner briefly holding the store file during
   rename — surfaced as an unhandled rejection in the test run) poisoned
   every later persist. The queue now clears rejection before each write,
   retries the rename once after 50ms, and fire-and-forget call sites no
   longer leak unhandled rejections.

Verification: suite 393 passed / 1 skipped (new rebind-boundary test;
desktop run clean of unhandled errors), typecheck clean, rebuilt, AGY
smoke green. Real-app visual pass per the loop: launched the built app,
connected local — the Claude tab (locally not installed, the branch this
machine exercises daily) now shows the banner + capability matrix with the
session sidebar intact, and the agy tab renders unchanged; screenshots
taken at each step; app closed after.

codex-path batch: all 8 inventory items done. Next: session-state batch.

## 2026-08-06 (cont.) — session-state: status authority, exit finalization, honest AGY binding, filter buckets

Six of the eight session-state inventory items (5: Claude ready-before-id
and 8: delete-dialog scopes remain).

1. **The service is the authority on liveness.** `liveStatus()` lets the
   screen-derived AGY activity refine only the alive states; a stored
   disconnected/exited/error now always wins, so a stale guess left behind
   by an unmounted surface can no longer resurrect a dead session as
   "ready". Leaving an entered AGY session clears its activity entry (a
   revive remount keeps the same id, so recovery is unaffected), and the
   tab badge now reads the same `liveStatus()` as the list — the dot and
   the rows can no longer disagree.
2. **Exit finalizes in-flight items (SPEC 1321-1325).** New
   `finalizeInFlightItems`: streaming messages become `interrupted`
   (rendered 已中斷), running tool cards become status `unknown` (rendered
   結果未知), applied on exit, on stream error, and on relaunch — alongside
   the existing expiry pass.
3. **AGY no longer binds whichever conversation is newest on the machine.**
   `latestAgyConversationId` takes a time window; revive only accepts a
   conversation last written within ±30 minutes of the session's own last
   activity, else falls back to `--continue`. Deterministic unit test with
   a fake home directory proves the wrong-session case is rejected.
4. **Resume continuity is now three-state and honest (SPEC 278).**
   `resumeContinuity: continued | new | assumed` replaces the boolean from
   the previous entry ('continued' only when the same bound id is
   reopened; disk-guessed or `--continue` is 'assumed' and pushes a
   boundary notice saying the match is unconfirmed; header wording
   follows). The opt-in real-AGY resume test was updated to the
   window-aware expectation but currently aborts at its precondition — the
   real store no longer has a session titled '123' — noted honestly; the
   window behaviour is covered by the new deterministic test instead.
5. **Deleted sessions stay deleted (SPEC 1514-1515).** Timeline events,
   error events (by their sessionId), and AGY surface notifications are
   now all dropped for forgotten sessions — previously only session
   updates were.
6. **Filter buckets follow 3.4.13 (SPEC 1136-1144).** running / needs
   input / idle / exited / error — waiting_approval no longer hides inside
   running, disconnected no longer masquerades as idle.

Verification: suite 394 passed / 1 skipped (new window test; extended exit
test covers interrupted/unknown), typecheck clean, rebuilt, AGY smoke green
end to end. No stray processes.

Next: session-state items 5 (Claude marked ready before conversation id —
riskiest, touches Claude launch path) and 8 (delete dialog scopes +
per-scope results, effort 大), then composer-attachment batch.

## 2026-08-06 (cont.) — session-state complete: Claude Starting semantics, delete scopes

The last two session-state items; the batch is now 8/8.

1. **Claude is Starting until its conversation id arrives (SPEC 219-221,
   1481).** The immediate `ready` after launch is gone; like Codex, Claude
   flips to ready only on system/init → session_initialized. Because SPEC
   207-209's own flow sends the first prompt during Starting, the composer
   now allows sending in that state for Claude specifically (its stdin is
   live from launch; Codex genuinely has no thread yet, so it stays
   gated) — this is also the escape hatch if a Claude build only emits
   init after the first prompt. The riskiest change of the batch: Claude
   is not verifiable on this machine; covered by updated unit tests
   (create and revive both assert starting → init → ready). The sketch's
   "no-id notice after a probe window" safety net was deliberately
   skipped — the status chip already says Starting; recorded here.
2. **Delete is scoped and reports per scope (SPEC 1496-1513).**
   `delete()` returns `DeleteAgentSessionResult`: localIndex / process /
   remoteEvents / remoteAttachments each report done, failed (with
   detail), or skipped (disconnected — with the residual path);
   nativeConversation is `unsupported` and shown as such rather than
   hidden. The two `onError` emissions are gone — a locally-successful
   delete no longer fires a red banner. The dialog now shows
   Session/Agent/Machine/Directory plus all five scopes with their actual
   impact; a partial result keeps a per-scope report panel on screen.
3. Test-infra fix along the way: the suite's temp-dir teardown now
   retries (fire-and-forget persists could still be writing at rmdir
   time on Windows — EBUSY).

Verification: suite 394 passed / 1 skipped, typecheck clean, rebuilt, AGY
smoke green. Real-app pass for the UI: created a real AGY session through
the new-session dialog, confirmed the header meta line (`agy 1.1.10 ·
未綁定原生對話`) and the five filter buckets live, opened the delete dialog
(scope list renders as designed), executed the delete — clean removal, no
error banner, no residue panel (connected path; the disconnected path's
skipped-scopes report is unit-tested). Screenshots at every step; app
closed after.

Remaining: composer-attachment batch (8 items), then the final general
edge-case sweep until no new ones emerge.

## 2026-08-06 (cont.) — composer-attachment, renderer half (items 3/4/7/8 + usage display)

The low-risk renderer items of the batch; the send/upload state machines
(items 1, 5, 6) are next, together, because they all re-cut the meaning of
`uploading`.

1. **Prompt history engages only at the caret boundary (SPEC 1350).**
   `canNavigate` is now `caretIsOnHistoryEdge()` on every press — once a
   multi-line prompt is recalled, arrows inside it move the caret instead
   of swapping the entry under the edit. Side effect that makes the spec's
   restore clause reachable for the first time: a non-empty draft can now
   enter history (it used to require an empty field, which meant the saved
   draft was always ''). Same gate applied to the AGY composer, which had
   a copy of the old logic and no caret check at all.
2. **Tray Remove/Attach are gated by Processing only (SPEC 1414/1395).**
   A buffered screenshot no longer becomes unremovable for the entire
   duration of an agent turn; Attach likewise only respects the count
   limit and in-flight packaging.
3. **A disabled composer explains itself (SPEC 1362-1364).** New
   `composerAvailability()` — one switch yields both the disabled flag and
   the reason+next-step, so they cannot drift — rendered above the
   composer (在 Approval 卡作答／按 Resume／等待完成或 Stop…). The AGY hint
   line gained the equivalent mapping from its own sources
   (connection/mode/statusSync); live smoke confirms the running-state
   hint and overlay hint actually render at the right stages.
4. **Tray rows show Type and readable Size (SPEC 1402-1408).**
   `formatAttachmentSize` moved to attachmentBuffer (re-exported from
   MessageAttachments so import paths hold) and both trays now print
   `狀態 · mediaType · size` — no more `20480 KB`.
5. **Usage is always stated in the header (SPEC 1225 display half).**
   Claude/Codex sessions show the last reported usage figures or 「用量未知」
   — never silence. The composer *gate* on usage sync is deliberately not
   implemented: with no host-side query for Claude/Codex it could only
   ever time out, which is a lock with no key (the inventory's own
   verify-notes reached the same conclusion); recorded here as a decision.

Verification: suite 394 passed / 1 skipped, typecheck clean, rebuilt, AGY
smoke green end to end; observations confirm the new unavailable-reason
hints render at the expected stages. No stray processes.

Next: composer-attachment items 1 (send-confirmation state machine), 5
(tray per-item states + retry), 6 (AGY re-upload on paste failure) — one
change, shared `uploading` split. Then the general edge-case sweep.

## 2026-08-06 (cont.) — composer-attachment complete; all 37 inventory items done

The three send/upload state machines, done together because they all
re-cut what `uploading` means.

1. **Unconfirmed delivery has an exit (SPEC 318-331).** A 20s fuse arms on
   every send; if neither success nor failure has come back, an indicator
   appears above the composer with 「再次查詢」 (re-reads the session from
   the host: delivered → adopt its timeline and clear the draft; not
   delivered → draft and tray were never cleared, so they are simply
   usable again) and 「明確重送」 (always explicit, never automatic). New
   sends are refused while a prompt is unconfirmed (SPEC 1360); deleting
   the session clears the timer. This closes the one real gap the
   inventory's verify pass identified: a hung IPC used to lock the
   composer forever with no escape.
2. **Tray items carry the full state machine (SPEC 1401-1415).**
   `ComposerAttachment.state`: buffered → packaging → transferring →
   verifying → ready / error (+ errorMessage, remotePath). The unified
   send marks each stage; failures mark only the items that never landed —
   red, with a per-item 重試 that re-uploads just that file. Removal is
   blocked only during processing states. `uploading` now means exactly
   "attachments in flight", so a text-only send no longer flashes
   Packaging.
3. **AGY retry reuses landed attachments (SPEC 315).** The tray swaps to
   its delivered form (remote ids, no Files) right after upload — the same
   move the unified path already made — so a paste-step failure leaves a
   batch that re-enters send without re-encoding or re-uploading; upload
   bytes are cached per remote id for the retry paste
   (`createAgyMediaUploadArchive` now accepts cached bytes), and pasted
   media ids are tracked so a mid-loop failure retries only the remainder.

Verification: suite 395 passed / 1 skipped (buffered-state assertion
added), typecheck clean, rebuilt; AGY smoke failed mid-run once
immediately after the rebuild and passed clean on re-run — second
occurrence of this first-run-after-rebuild flake (also 2026-08-06
codex-path entry); worth a look in the sweep phase. The unconfirmed
banner and single-item retry need a hung IPC / failed upload to trigger,
which the loop cannot fabricate against the real app — exercised at the
code level only, noted honestly.

**All 37 agent-page-inventory items are now closed.** Next per HANDOFF:
the final general edge-case sweep (workflow simulation) until no new
general edge cases emerge.

## 2026-08-06 (cont.) — edge-case sweep, round 1

First round of the final phase: live workflow simulation on the built app
plus a root-cause hunt for the recurring smoke flake.

1. **The smoke flake was an external outage, diagnosed and closed.** Three
   consecutive smoke failures captured the real error: AGY's backend
   eligibility check returning 503 (`Eligibility check failed: UNAVAILABLE
   (code 503)`) — the prompt round-trip cannot complete while Google's
   service is down. The earlier "first-run-after-rebuild" flakes were
   almost certainly early samples of the same intermittent 503. Not a
   product bug; the service recovered within the hour and the smoke went
   green again.
2. **New edge case found by the outage, and fixed:** during the startup
   status sync, a busy CLI (mid eligibility-check) can swallow the Escape
   that closes the auto-opened /usage report — the sync times out to
   'failed' and its overlay stays covering the conversation until the user
   presses Esc themselves. The surface now closes the report it opened
   when the sync gives up (guarded to contextReport/quotaReport, the two
   kinds the sync itself opens). Observed live before the fix; smoke green
   after.
3. **Live-verified in one continuous workflow** (create → sync → type →
   tab-switch → return): draft survives the surface unmount and remount
   (SPEC 300 — the remote input-row backfill restored it verbatim); the
   composer explains itself while disabled (sync and running states show
   their reasons; the overlay hint shows while a report is up — all three
   observed on screen); statusline metrics appear after sync; the list
   chip and tab dot agree throughout. Session deleted cleanly afterwards.
4. Automation notes for this machine recorded in memory: the Bopomofo IME
   intercepts synthetic keystrokes (use clipboard paste), right-click and
   modal scrolling techniques.

Verification: suite 395 passed / 1 skipped, typecheck clean, rebuilt,
smoke green end to end. Sweep continues next round (codex live chat
round-trip via UI, resume-after-exit boundary notice, long-reply scroll).

## 2026-08-06 (cont.) — edge-case sweep, round 2: Codex live end to end

The Codex chat path — dead on arrival before this session's launch fix —
driven through the real UI for the first time, full circle.

Live-verified in one continuous run: create (Workspace + approvals) →
thread bound within seconds → ready; prompt round-trip renders user
bubble and reply; header meta shows `Codex codex-cli 0.146.0 ·
已綁定原生對話`; app restart leaves the session exited with its timeline
previewable without a process (SPEC 256-262); Resume relaunches onto a
new thread and the timeline shows the dashed boundary notice 「以下開始
新的原生對話：Codex 不記得這條分隔線之前的內容」 with the header flipping
to 「本次 Resume 開啟新原生對話」 (SPEC 275-277, 1217-1218); a further
round-trip works below the divider. Session deleted cleanly.

One gap found and fixed: **Codex publishes per-turn token usage
(`thread/tokenUsage/updated`, generate-ts v2) and the adapter ignored
it** — the header stayed at 用量未知 forever. The adapter now maps the
notification's `last` breakdown to a usage event; live check after the
fix shows 「用量 in 16,031 / out 8 tokens」 in the header and the usage
row in the timeline, one per turn.

Verification: suite 396 passed / 1 skipped (new adapter usage test),
typecheck clean, AGY smoke green. Sweep continues (long-reply scroll
behaviour, codex approval card via a sandbox-restricted command).

## 2026-08-06 (cont.) — edge-case sweep, round 3: Codex approval card live

Triggered a real approval through the UI (Workspace + approvals policy,
untrusted `python -V`): the card rendered with the risk summary, the full
command, and the machine row (`ycchao@localhost · cwd: …`); the session
chip and filter moved to **needs input**; the composer disabled itself
with 「Agent 正在等待你的回覆——在上方的 Approval／Question 卡片作答」.
Allow once → green Allowed chip with content preserved → command executed
(codex's own Windows sandbox then blocked it with
CreateProcessWithLogonW 267, honestly reported by the agent — not a
CozyPad defect) → status back to ready. Every element on that card came
from this session's fixes, all confirmed live.

Two more findings:

1. **Usage rows laddered** — codex emits several tokenUsage updates per
   turn, and each became its own timeline row (three per turn observed).
   Consecutive usage rows now collapse into one, keeping the turn's final
   figures; Claude's single-usage-per-result behaviour is unaffected.
2. **Round-2's session deletion had silently missed** — the taller scoped
   delete dialog moved the confirm button ~18px below the old click
   target, and without a verification screenshot the miss went unnoticed
   (automation error, not a product bug; the leftover session also proved
   session persistence across app restarts once more). Both codex
   sessions were deleted this round with verified screenshots — empty
   list, no error banners, no residue panel.

Verification: suite 396 passed / 1 skipped, typecheck clean, rebuilt, AGY
smoke green. Next round: AGY-side approval/question card live (numbered
permission card + the reply-freeze behaviour), then assess whether the
sweep has dried up.

## 2026-08-06 (cont.) — edge-case sweep, round 4: quoted-question parser bug found live

Asked AGY for a numbered riddle through the real UI and hit a genuine
parser defect the unit fixtures never covered:

1. **A quoted question defeated the question detector.** The riddle ended
   with `…請問這是什麼？」` — question mark, then closing quote. The
   numbered-answer run detector requires a question-shaped line within the
   five lines above, tested with `/[?？]$/` — which fails on the closing
   quote. The run was discarded, and the fallback panel then offered the
   **user's own transcript echoes** as clickable options (the `>` history
   rows). Fixed by allowing trailing closing punctuation after the
   question mark (question gate and card title both), with a regression
   test built from the captured live frame.
2. **The card's own `Question` heading became an option** via the
   adjacent-row collector once the run was recognised. The collector now
   runs only for undecorated menus — a numbered/keyed card is already a
   complete answer set.
3. The composer's unavailable-reason hint gained a menu/viewer case
   (previously the vague 「目前無法輸入」).

Precision confirmed on both sides live: a later AGY run chose to pose the
same riddle as plain prose (「請選擇你的答案：」 + numbered list, reply by
typing a digit) — those numbered lines correctly stayed text, exactly the
boundary the question gate is supposed to hold.

Also observed: a failed usage sync this round left **no** lingering
report overlay (round-1's cleanup fix at work), and the exited session
after an app kill showed the correct `exited` chip and bucket. Google's
eligibility service kept flapping throughout (one silent no-reply turn;
one first-run smoke failure that passed clean on re-run).

Verification: suite 397 passed / 1 skipped, typecheck clean, rebuilt, AGY
smoke green (on re-run). Test sessions deleted with screenshot proof.

## 2026-08-06 (cont.) — edge-case sweep, round 5: the workspace survives disconnection

Clicked Disconnect with a live session and found the biggest gap of the
sweep: **the whole Agents workspace was replaced by the "先連線到遠端主機"
setup pane** — session list gone, even though the backend explicitly
supports offline session management (the delete-with-skipped-scopes
report existed precisely for this) and SPEC 256-262 says saved timelines
preview without a process.

Fixed: while disconnected, the workspace now loads and shows the selected
profile's saved sessions (the store is local; only agent detection needs
the host), with a 「尚未連線」 banner in the sidebar. Preview, rename, and
delete work offline; entering/creating stay gated (Resume button was
already connection-gated; the handler gained a reason message as a second
net).

Live-verified end to end while disconnected: session listed with the
offline chip in the error bucket; timeline preview opens; **the offline
delete produced its per-scope outcome panel on screen for the first
time** — 本機索引 完成, 原生對話 不支援, process/遠端事件/遠端附件 未執行
with each residual path and the reconnect guidance (SPEC 1509-1513
realized visibly). Residual test directories cleaned up manually after.

Verification: suite 397 passed / 1 skipped, typecheck clean, rebuilt, AGY
smoke green first try. The sweep keeps yielding — next candidates: AGY
interactive card click-through (still unluckily untriggered — AGY keeps
choosing prose), long-reply scroll during streaming, reconnect-reconcile
behaviour after offline deletes.

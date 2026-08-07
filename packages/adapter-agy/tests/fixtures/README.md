# Fixture provenance

Every `*.ndjson` here is **verbatim stdout** of one `agy -p … --output-format
stream-json` run: same bytes agy wrote, no reformatting, no trimming, no editing.
Nothing is hand-written. A branch that only a fabricated fixture could reach is a
branch nobody has evidence for — that mistake has already been made once in this
package and it put a wrong value (`TOOL_EXECUTION_ERROR`) into the type
declarations for a day.

The point of this file is that you should not have to take that on trust.

## Re-deriving them

`record.mjs` is the recorder, and it is the only thing that has ever written
these files:

```
node packages/adapter-agy/tests/fixtures/record.mjs              # list names
node packages/adapter-agy/tests/fixtures/record.mjs turn-tool-error
```

It prints the exact argv it spawned, the exit code, the byte count and the md5,
and it writes straight to `<name>.ndjson` in this directory. The prompts live in
that file, so "what question produced this recording" is answerable by reading
code rather than by asking whoever recorded it.

**A re-run does not reproduce these bytes, and is not supposed to.** A live model
picks its own wording, agy mints a new `conversation_id`, durations and token
counts differ, and the sandbox path is machine-specific. What a re-run reproduces
is the **shapes** — which is all the tests assert. The md5 column below is not a
target to hit; it pins the checked-in bytes so that a later hand-edit of a
"recording" is visible in review. `provenance.test.ts` fails if a fixture's md5
stops matching the table, which also means this file cannot quietly rot.

Because of that, the tests derive `conversation_id`, step indices and tool output
from the fixture they load rather than hard-coding values — re-recording must not
require editing assertions.

## What is checked in

Recorded on **Windows 10**, `agy --version` = **1.1.11**, node **v24.18.0**,
`--model claude-sonnet-4-6` (the project's test convention: see
docs/ACP-MIGRATION.md, "測試慣例").

| fixture | recorded | md5 | bytes | model flag |
|---|---|---|---|---|
| `turn-plain.ndjson` | 2026-08-07 | `de808740a98096e80d5fce59da099cd1` | 2936 | ✗ none |
| `turn-with-tool.ndjson` | 2026-08-07 | `505381cec3d88d58a23ed236176572ec` | 4059 | ✗ none |
| `turn-tool-output.ndjson` | 2026-08-07 | `eb42df3ec4642eae76fa538b219bb516` | 6957 | ✓ `claude-sonnet-4-6` |
| `turn-tool-error.ndjson` | 2026-08-07 | `ad35e92f5b75c56bd5976d0243c2887d` | 12242 | ✓ `claude-sonnet-4-6` |

The two with `--model` were re-recorded by `record.mjs` on 2026-08-07 (exit 0,
empty stderr, 16.8s and 31.9s). The two without predate the convention; their
recipes are in `record.mjs` so they can be re-derived, but a re-run of those uses
Sonnet and so will differ from the checked-in bytes in more than the usual ways.

### The one edit these files have had, and why it does not weaken them

agy echoes the machine's real working directory in `init.cwd`, and names it again
inside tool errors. That put a local account name and a temp path into files
bound for a **public** repository. On 2026-08-08 a single mechanical substitution
was applied to all four: the account name → `devbox`, and the recording
workspace → `%LOCALAPPDATA%\Temp\cozypad-agy-fixture`. The md5 and byte columns
above are post-substitution, which is why two of the byte counts shrank.

This is the one exception to "verbatim", and it is deliberately the narrowest
one possible. The rule exists because a hand-written fixture once made
`status: 'failed'` look tested while getting `error.type` wrong
(`TOOL_EXECUTION_ERROR` for the real `TOOL_ERROR`) — that is, because *invented
wire shapes* are indistinguishable from recorded ones. A path string is not a
wire shape: no field was added, removed, retyped or reordered, every event and
every `step_index` is byte-for-byte what agy wrote, and the tests read paths
back from the fixture rather than asserting them. Redacting an account name
cannot make a mapping look correct when it is not.

If you re-record, `record.mjs` runs from a temp directory of its own making, so
new recordings carry the account name again — apply the same substitution and
update the table, or the check below goes red.

## What each one is evidence for

- **`turn-plain.ndjson`** — a turn with no tool steps. Also the first sighting of
  `error_message`: agy refused a `view_file` on a missing path *before* running
  it, and the refusal produced no tool step.

- **`turn-with-tool.ndjson`** — a `list_dir` whose DONE step carries **no
  `output` key at all**, not an empty string. The seeded `alpha.txt`/`beta.txt`
  are a red herring: agy resolved "this directory" to its own scratch dir
  (`~/.gemini/antigravity-cli/scratch`), which was empty. This is the shape that
  hid the dropped-output bug, so it is kept deliberately.

- **`turn-tool-output.ndjson`** — the counterpart: `list_dir` with
  `output: "alpha.txt\nbeta.txt"`, which must reach the client or the tool card
  renders "completed" with a blank body. In the same turn a read of a missing
  file is refused pre-execution: one bare `error_message` step, **no** tool step,
  and `result.status: "SUCCESS"`. The only account of that refusal is the
  assistant's prose.

- **`turn-tool-error.ndjson`** — five deliberately hostile steps, and the only
  recording of tools that **executed and then failed**:
  - `read_url_content` on a closed port and `manage_task` with a bad id both give
    `state: "ERROR"` with `tool_info.error.type: "TOOL_ERROR"`. `TOOL_ERROR` is
    the real value; a hand-written fixture once guessed `TOOL_EXECUTION_ERROR`.
  - `cmd /c exit 7` and `cmd /c dir Z:\no-such-drive-here` both end **DONE**. A
    non-zero exit code is not a tool failure — the command's own complaint shows
    up in `tool_info.output`, and the first of the two sends no `output` key.
  - `result.status` is `"ERROR"` even though all five steps ran and agy reported
    on each. That is why `stopReasonFor` maps `ERROR` to `end_turn`, not
    `refusal`; see the comment on `STOP_REASONS` in `src/mapper.ts`.
  - `result.error` is a byte-identical copy of the **last** failed tool's
    message, not a turn-level fault, so it is deliberately not re-emitted.

## Live experiments (not fixtures): `proveWorkspace.mjs`

`proveWorkspace.mjs` is not a recorder — it answers **which lever moves agy's
workspace**, and it is checked in for the same reason the recordings are. It
builds argv with the shipped `buildAgyArgv` (not a copy), so a change to the flags
the adapter really sends changes what this runs.

```
node packages/adapter-agy/tests/fixtures/proveWorkspace.mjs --lever add-dir-only
node packages/adapter-agy/tests/fixtures/proveWorkspace.mjs --lever cwd-only
node packages/adapter-agy/tests/fixtures/proveWorkspace.mjs --lever cwd-only --dry-run
```

`--dry-run` spends nothing and **asserts** — it checks that argv isolates the
lever under test, pins `--model`, and still carries `--output-format stream-json`,
then exits non-zero if any of that is untrue. It previously called
`process.exit(0)` *before* its assertions, so its exit code meant nothing at all
— a build emitting no `--add-dir` would still have passed. Checked by mutation:
two altered copies (`withoutAddDir` turned into a no-op; `--model` filtered out
of the builder's output) fail the dry run in all three lever combinations.

Run on 2026-08-07, agy **1.1.11**, Windows 10, `--model claude-sonnet-4-6`, one
agy call each:

| lever | spawn cwd | `--add-dir` | `init.cwd` agy echoed | where `list_dir` ran | marker seen | exit |
|---|---|---|---|---|---|---|
| `add-dir-only` | `…\process-cwd` (wrong) | `…\the-workspace` | `…\process-cwd` | `…\the-workspace` | ✅ | 0 |
| `cwd-only` | `…\the-workspace` (right) | *absent* | `…\the-workspace` | `~\.gemini\antigravity-cli\scratch` | ❌ | 1 |

**`--add-dir` alone is sufficient to get agy *into* the directory; the process
cwd alone does nothing.** The `cwd-only` row is the silent wrong answer in
miniature: agy accepted the cwd, echoed it back as `init.cwd`, ran `list_dir`
somewhere else entirely, exited 0 with `result.status: SUCCESS`, and replied
*"The directory is empty — no files were found."* Nothing anywhere in that turn
is an error.

### What these two runs did **not** measure

Both levers answer **inclusion** — "can agy find the directory we named". Neither
asks **confinement** — "will agy refuse a path we did not name" — and that is the
question the word *scoping* makes a reader hear. This README, the source comment
on `buildAgyArgv` and `docs/ACP-MIGRATION.md` all used to state the inclusion
result in confinement's words.

The evidence available points the other way, and it is in this directory:
`turn-tool-error.ndjson` is one recorded turn in which agy ran
`cmd /c dir Z:\no-such-drive-here`, `grep_search`ed
`~\.gemini\antigravity-cli\scratch` and fetched `http://127.0.0.1:9/` — all
outside the workspace, all executed, under `permission_mode: "always-proceed"`
with no `session/request_permission` for a client to refuse.

So `--add-dir` is a hint about where to look, not a sandbox. The adapter now says
so on the wire: `initialize` reports
`_meta["cozypad.dev/agy-limitations"].confinesToWorkspace = false`. Nothing in
CozyPad may promise a user "workspace scoping" on the strength of these two runs;
that would need per-call approval (the connect transport) or an OS-level sandbox,
and a new experiment that actually tests refusal.

## Earlier provenance, for the record

Before `record.mjs` existed, these were recorded by throwaway scripts in an
editor-session scratchpad under `%LOCALAPPDATA%\Temp\…` — a directory that is
deleted with the session, and which is *not* `D:\CozyPad\scratchpad`. An
audit that looked in the repo for it concluded the recordings were unverifiable.
They were not: on 2026-08-07 the originals were still present and md5-identical
to the checked-in files (`turn-tool-error.ndjson` = `d2-a-raw.ndjson`;
`turn-tool-output.ndjson` = the concatenated `raw` chunks of
`acp-spike/lens-c/out/tools/agy-raw.ndjson`).

That the claim held up is beside the point. Evidence that lives in a temp
directory is evidence with an expiry date, and "I checked, trust me" is what this
file exists to replace.

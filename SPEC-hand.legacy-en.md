# CozyPad

## Overview

CozyPad is responsible for:

- selecting and connecting to one machine context at a time;
- keep agent running while cozypad is disconnected;
- presenting different coding agents through a consistent conversation model;
- providing direct terminal and file access to the selected machine;
- monitoring machine resources and active workloads;
- defining, running, comparing, and exporting reproducible research experiments;
- making risky, destructive, or identity-changing actions explicit to the user.

CozyPad is not responsible for:

- implementing an agent's reasoning loop, model provider, memory, or native conversation store;
- treating terminal screen text as a complete source of chat meaning when structured events exist;
- silently changing remote project files, research controls, credentials, or trusted host identity;
- claiming that an unknown remote state is successful or failed before reconciliation.

## Core objects

- **Machine**: the local machine or one SSH-accessible remote machine.
- **Connection profile**: the saved identity and authentication policy used to reach a machine.
- **Project context**: a machine-bound working directory shared by Agents, Terminal, Files, Monitor, and Research.
- **Agent session**: one conversation with one agent, backed by a persistent remote runtime when the machine is remote.
- **Study**: one research question and its shared data and metric meaning.
- **Experiment**: one versioned plan under a study.
- **Run**: one immutable materialization and execution of an experiment plan.
- **Artifact**: a file or logical output produced by an agent session or research run.

## Global principles and constraints

### Machine context

- Exactly one machine is active at a time.
- Local machine is the default context and requires no artificial login step.
- Selecting a different machine while connected does not create a second hidden connection. The current connection is disconnected before the new one becomes active.
- Every workspace clearly reflects the active machine. Data from a previously selected machine must not appear as current data.
- Switching workspace does not terminate remote work. Switching machine may close live local views, but persistent remote runtimes continue until explicitly stopped.

### Identity

- Display names are mutable labels and are never treated as permanent identity.
- An agent session is distinguished by machine identity, managed runtime identity, agent kind, and the agent's conversation identity.
- A research run, its execution process, an agent session, and a terminal session always have separate identities, even when they are linked.
- Reconnection merges discovered remote state with known local state. It must not silently create duplicate sessions or runs.
- If an identity is incomplete during startup, the object remains in a visible starting state until the authoritative identity is known.

### Structured information

- Agent chat uses structured events whenever the agent provides them.
- Terminal output and structured chat events are separate information streams.
- A terminal view may be used as a fallback or diagnostic view, but its screen text must not be presented as reliably classified messages, approvals, diffs, or tool results.
- Raw provider events remain available for recovery and diagnosis but are not shown as ordinary chat content.
- Official activity summaries may be shown. Hidden reasoning, reconstructed chain-of-thought, stderr, and debug output must not be presented as model reasoning.

### Safety and security

- Credentials are handled only by the privileged storage and connection layer. A normal workspace can know that a credential exists but cannot read a stored secret back.
- Saved credentials are bound to the exact profile, host, port, username, and authentication method for which they were created.
- If secure storage is unavailable, corrupted, or cannot be decrypted, CozyPad fails closed. It never falls back to plaintext storage or silently discards the problem.
- Unknown host identity requires explicit fingerprint verification. A changed fingerprint is treated as a high-risk event and never inherits earlier trust.
- Weak or obsolete connection algorithms are rejected rather than silently enabled for compatibility.
- Agent credentials remain owned by the agent on the selected machine and are not copied into CozyPad.
- User prompts and attachments are isolated from shell command construction.
- Approval requests show the exact machine, working directory, action, target, and likely effect. The default choices are allow once or deny; there is no global allow-everything shortcut.
- Destructive actions identify the exact target and require confirmation. Deleting an index, stopping a runtime, deleting a remote event archive, deleting an agent-native conversation, and deleting project files are separate actions.

### Data lifecycle

- Local application data includes profiles, encrypted credentials, trusted host records, local indexes, preferences, and caches.
- Uninstalling CozyPad deletes its local application data.
- User-exported or downloaded files outside application-private storage remain user-owned and are not deleted by uninstall.
- Remote project files are never deleted by uninstall.
- Buffered Agent attachments remain application-owned temporary data until they are delivered, and delivered attachments remain isolated inside the conversation that received them.
- Deleting an Agent session removes only that session's CozyPad-owned attachment directory; attachment cleanup never broadens to project files.
- CozyPad-created remote metadata, logs, managed configuration blocks, and optional user-level tools are removed only through an explicit remote cleanup flow.
- Remote cleanup touches only CozyPad-owned paths and managed blocks. It does not overwrite unrelated shell or terminal settings.

### State, failure, and recovery

- Long operations expose pending, progress, success, failure, and cancellation states.
- Errors remain visible until acknowledged or replaced by a successful retry.
- A network timeout that leaves remote execution uncertain is shown as unknown or lost, not failed.
- Reconnection is idempotent: replaying the same event or discovering the same remote object does not duplicate it.
- When a view is temporarily unavailable, it shows the reason and the next useful action instead of an empty surface.
- User drafts, selection, filters, scroll position, and open subviews are preserved when switching between workspaces or agent pages whenever their underlying context still exists.

### Interaction quality

- All essential actions are reachable by keyboard and touch as well as pointer input.
- Focus is visible, dialogs trap focus, and controls have meaningful accessible names.
- Chinese input methods, emoji, wide characters, combining characters, and pasted code must not corrupt text or layout.
- Desktop and mobile use the same information hierarchy, but may use different layouts appropriate to screen size.
- Large lists, timelines, tables, diffs, and logs remain responsive through bounded rendering or virtualization.
- Streaming content updates the affected item without repeatedly re-rendering the full history.

## Application shell

**Widget**: [top bar, machine selector, connection status, mode badge, connect/disconnect action, connection settings action, workspace navigation, workspace content, global warning area]

**Flow**:

    - Load the local profile and all saved remote connection profiles -> Select the local profile and connect it automatically unless another connection flow is already active -> Show the default workspace -> Let the user switch workspaces without stopping their sessions or losing page state -> Propagate connection, machine, and project-context changes to every workspace.

**behaviour**:

- The top bar is always reachable from every workspace.
- Connection state is one of disconnected, connecting, connected, reconnecting, or error.
- The mode badge distinguishes Local, SSH, and explicit demonstration/mock data.
- Startup storage or migration warnings appear above the workspace and can be acknowledged without hiding the underlying problem from diagnostics.
- Workspaces that require a machine show a connection placeholder while disconnected.
- A workspace that does not require a live connection may remain readable while disconnected, but cannot imply that stale data is live.
- Navigation order is Agents, Research, Terminal, Files, Monitor, and Settings.

## Mode selector

1. Local machine (default)
2. ssh remote machine
**Widget**: [scroll list, connect/disconnect botton, connection setting button]
**Flow**:

    - start in Local machine -> disconnect before changing machine context -> unfreeze the scroll list -> select Local machine or one saved ssh remote machine -> press connect -> verify the selected machine -> freeze the scroll list

**behaviour**: 
    - local mode: default, freeze the scroll list
    - remote ssh mode: disconnect first -> unforzen scroll list -> use scroll list to select the wanted machine -> press connect button -> freeze scroll list
    - switch to Local / another remote machine: disconnect first -> unforzen scroll list -> use scroll list to select the wanted machine -> press connect button -> freeze scroll list

### ssh connector

plain-text saved: IP, port, user name
encrypted: password, ssh key

**Note**: all information should be deleted while uninsalled from the local machine 

**Widget**: [profile name, IP or host, port, user name, authentication method, password or SSH key input, remember option]

**Flow**:

    - create or edit an ssh connector -> save IP, port, and user name as readable connection metadata -> protect password or SSH key as encrypted credential data -> use the connector only for its exact saved machine identity -> delete its local metadata, credential, and trust association when the profile or application data is removed

**behaviour**:

- Connection metadata and encrypted credentials remain separate kinds of data.
- A stored password or SSH key cannot be read back through the normal interface.
- Changing host, port, user name, or authentication method requires the credential binding to be validated again.
- Removing the connector does not delete files or processes on the remote machine.

### Mode selector details

**Widget**: [profile scroll list, connect/disconnect button, connection settings button, connection status, mode badge]

**Flow**:

    - Local machine is selected by default -> To use a remote machine, disconnect the current machine, unfreeze the list, select the wanted profile, and press Connect -> To switch back to Local or to another remote machine, disconnect first, select the target, and connect -> Freeze the profile list while a connection is connecting or connected.

**behaviour**:

- Local mode connects automatically and freezes the selector once active.
- Remote mode is always a deliberate selection.
- The selector never suggests that one profile is active while another profile actually owns the connection.
- Manual disconnect cancels pending automatic reconnection.

### Local machine

**Widget**: [Local profile row, Local mode badge, connection status]

**Flow**:

    - Discover the built-in Local profile -> Connect without asking for host, username, password, key, or host trust -> Expose the same workspace concepts available for a remote machine where the local operating system supports them.

**behaviour**:

- The Local profile cannot be deleted.
- Local mode does not open a network connection to the same machine.
- Local work follows the same safety and destructive-action rules as remote work.

### SSH remote machine

1. Connection workflow

**Widget**: [remote profile, authentication prompt when required, host identity prompt, connection progress, reconnect banner]

**Flow**:

    - Read the selected profile -> Request a credential only when the profile has no usable stored credential -> Open the connection and verify the remote host identity -> Complete capability checks and remote reconciliation -> Mark the profile connected only after the connection is usable.

**behaviour**:

- Password and private-key authentication are supported.
- An encrypted private key may use a separate passphrase.
- Authentication, trust, transport, and remote setup errors are distinguishable to the user.
- A failed initial connection retries a limited number of times, then returns control to the user.
- A previously established connection may continue retrying with a capped backoff until cancelled.

#### Connection workflow

1. Connection profile manager
2. Credential prompt
3. Host identity verification
4. Automatic reconnection
5. Remote runtime prerequisite

**Widget**: [selected profile, credential state, host identity state, connection progress, capability check, reconciliation state]

**Flow**:

    - select one remote profile -> obtain a usable credential -> verify the host identity -> establish the SSH connection -> check remote capabilities and persistence prerequisites -> reconcile existing remote work -> expose the machine as connected

**behaviour**:

- Each stage finishes or returns an explicit decision before the next security-sensitive stage proceeds.
- Cancelling credential entry, host trust, connection, or runtime setup leaves the remote machine disconnected.
- A connection is not considered usable until identity verification, capability checks, and initial reconciliation complete.
- Retrying the workflow reuses the same profile identity and does not create a duplicate active connection.

##### Connection profile manager

**Widget**: [profile list, add button, edit button, delete button, profile form, authentication-method selector, remember-credential option]

**Flow**:

    - Create or select a remote profile -> Enter profile name, host, port, username, and authentication method -> Enter a password, or supply a private key and optional passphrase -> Choose whether the credential is remembered after the application exits -> Validate the profile and save it -> Edit or delete an existing remote profile through an explicit action.

**behaviour**:

- Profile name, host, port, username, authentication method, and whether a secret exists may be displayed.
- Password, private key, and passphrase are never displayed after storage.
- Editing identity fields invalidates a credential that was bound to the old identity unless a new valid credential is supplied.
- Leaving a credential field empty while editing means keep the existing credential only when the connection identity and authentication method are unchanged.
- Deleting a profile requires confirmation and removes its saved credential and trust association from local application storage.
- The built-in Local profile is visible but cannot be edited or deleted as a remote profile.

##### Credential prompt

**Widget**: [machine identity summary, password or private-key field, passphrase field when relevant, remember option, cancel button, connect button]

**Flow**:

    - Show the exact username, host, and port that will receive the credential -> Accept the credential for the profile's selected authentication method -> Optionally remember it in secure storage -> Submit it once and continue the connection flow.

**behaviour**:

- Cancelling leaves the machine disconnected.
- A non-remembered credential stays only for the current application lifetime so automatic reconnection can still work during that lifetime.
- Secret input is never copied into ordinary error text, logs, or workspace state.

##### Host identity verification

**Widget**: [host and port, key type, current fingerprint, previous fingerprint when changed, risk explanation, abort button, trust button]

**Flow**:

    - On first contact, show the host fingerprint and require the user to compare it with a trusted source -> On mismatch, show both the previous and current fingerprints and explain the possibility of host replacement or interception -> Abort or explicitly trust the presented fingerprint -> Save trust only after explicit acceptance.

**behaviour**:

- No response, timeout, dismissal, or rejection aborts the connection safely.
- A changed fingerprint is never auto-accepted.
- Trust records cannot be read or overwritten by a normal workspace.

##### Automatic reconnection

**Widget**: [reconnect reason, attempt number, countdown, reconnect-now button, cancel button]

**Flow**:

    - Detect an unexpected disconnection -> Preserve persistent remote work and mark live views unavailable -> Schedule a retry with increasing delay -> Allow immediate retry or cancellation -> On success, reconcile remote sessions, runs, events, files, and telemetry before declaring the workspaces current.

**behaviour**:

- Manual disconnect never starts automatic reconnection.
- Only one connection or reconnect attempt may be active for the profile.
- Reconnection restores identity and missing events before accepting new actions that depend on them.
- Terminal tabs whose live channels cannot be restored close visibly; agent and research runtimes continue if their remote supervisors are still alive.

##### Remote runtime prerequisite

**Widget**: [runtime status dialog, explanation, install action, progress, elapsed time, estimated remaining time, bounded live log, copy-error action, dismiss action]

**Flow**:

    - Check whether the remote persistence supervisor exists and meets the required capability level -> If missing or outdated, explain why persistent agent sessions depend on it -> Offer a user-level installation when the host has the necessary build tools -> Show download, build, install, and verification progress -> Verify the installed runtime and refresh machine capabilities.

**behaviour**:

- Installation does not require administrator access and does not replace a system-wide installation.
- Temporary build material is removed after a successful installation.
- Closing the application while installation is using the active connection requires warning.
- Installation failure preserves a concise, copyable diagnostic and may be retried safely.
- Dismissing setup keeps general machine access available but marks persistent Agent features unavailable.

## Project context

**Widget**: [active project label, machine label, root path, project selector, add/edit action]

**Flow**:

    - Choose a machine -> Select an existing project root or create a project context from a directory -> Use that root as the default working directory for new Terminal tabs, Agent sessions, file navigation, and Research studies -> Allow a module to choose a different directory without changing the project root unless the user explicitly selects Set as project root.

**behaviour**:

- A project belongs to one machine identity and one root path.
- Two projects may point to different directories on the same machine.
- Changing the active project does not stop existing Agent sessions or Research runs; it changes defaults and filtering for new work.
- File selection may set the current working directory used by new Terminal tabs and Agent sessions.
- Project deletion removes only CozyPad project metadata by default, not the directory or its contents.

## Agents

1. Agent selector
2. Agent availability
3. Session sidebar
4. Session creation
5. Session lifecycle and reconciliation
6. Chat timeline
7. Composer
8. Slash commands and native interaction
9. Approval
10. Session deletion

**Widget**: [agent page selector, agent availability state, session sidebar, chat timeline, composer, session action menu]

**Flow**:

    - Connect to a machine -> Select an agent kind -> Detect whether that agent is installed and which interaction capabilities it supports -> Select, revive, resume, or create a session -> Exchange messages and structured actions while the remote runtime remains persistent -> Reconcile the session after application restart or connection loss.

**behaviour**:

- Claude, Codex, agy, and future custom agents remain separate first-level pages.
- During one application run, each agent page preserves its selected session, filters, draft, attachments, and scroll position; a fresh application launch intentionally starts with no selected session.
- Switching agent pages never terminates or restarts a running session.
- Common messages, tools, diffs, approvals, questions, usage, and errors share one visual language.
- Agent-specific controls may appear only when their capability is detected.

### Agent selector

**Widget**: [Claude tab, Codex tab, agy tab, custom-agent action, running indicator, approval indicator, unread count]

**Flow**:

    - Select an agent page -> Restore that page's most recent state -> Display only sessions belonging to that agent.

**behaviour**:

- Running, needs-input, unread, and error state are visible without opening the agent page.
- An unavailable agent shows detection and setup guidance instead of an empty conversation.
- A custom agent can be added only through a versioned capability contract; it cannot bypass global safety rules.

### Agent availability

**Widget**: [detection progress, remote environment summary, installed/unavailable result, supported modes, setup guidance]

**Flow**:

    - Detect the executable and version on the active machine -> Detect structured output, resume, interrupt, approval, attachment, slash-command, and native-interaction capabilities -> Publish only modes that are supported by the detected version.

**behaviour**:

- Capabilities are detected per machine and refreshed after reconnect or agent upgrade.
- Full Chat mode requires a reliable structured event source.
- An agent without structured output is labelled Terminal or native-interactive mode and is not represented as a full structured chat.
- Experimental capabilities are version-gated and always have a stable fallback when one exists.

### Session sidebar

**Widget**: [session search, all/running/idle/exited filters, status counts, session rows, new-session button, rename/delete menu]

**Flow**:

    - Open CozyPad or change machine -> Leave every Agent page unselected and show a blank conversation surface -> Filter the selected agent's sessions by status or search text -> Left-click, short-tap, or keyboard-activate a session to select it and show its persisted timeline in preview state without opening its action menu or entering its runtime -> Press Resume explicitly -> If its local or remote runtime exited, revive the same recoverable conversation and settle it to idle -> If its remote runtime is still alive, attach to it without restarting it and preserve running or needs-input state -> Enable the interactive Agent surface -> Right-click on desktop or long-press on mobile to open that session's action menu -> Use the session menu to rename or manage deletion.

**behaviour**:

- Sessions are ordered by most recent activity by default.
- Search covers title, project, host, and working directory within the current agent page.
- Human-friendly status groups are running, idle, and exited; the detailed state remains available on each row.
- Status includes starting, ready, running, needs input, disconnected, exited, and error.
- A session title can change without changing session identity.
- Reviving an exited conversation starts a new remote process bound to the same recoverable conversation when the agent supports resume.
- Restoring the session list never selects the first or most recently used conversation automatically.
- Session selection is a read-only preview action: it shows stored history but does not revive a process, attach a native terminal, enable the composer, answer a question, or resolve an approval.
- Resume is the only action that changes a selected preview into an entered session.
- Preview shows the saved conversation for every Agent kind, including an AGY conversation, without opening an interactive terminal, attaching to the runtime, resuming the conversation, or changing its status.
- Selecting an exited session -> Keep the session exited -> Show its saved conversation immediately -> Wait for explicit Resume -> Revive or reconnect the runtime -> Settle to idle only after recovery succeeds.
- Resume never restarts a runtime that reconciliation proves is still alive; a running remote session remains running and an idle live session remains idle.
- Resuming an error-marked session -> Verify its bound runtime generation -> If that runtime is still alive, clear the stale turn-level error and enter it without killing or relaunching it -> If it is no longer alive, launch one replacement generation and resume the recoverable conversation.
- Resuming a disconnected session -> Reconcile its bound runtime generation -> If that generation is still alive, enter it without relaunching -> If it is gone, treat it as exited and launch one replacement generation -> Never report a still-disconnected session as a successful Resume.
- Resuming a legacy local AGY session without a stored conversation identity -> Resolve the conversation selected by AGY -> Bind that identity to the CozyPad session -> Use the exact bound identity for later Resume and transcript recovery instead of repeatedly choosing the machine-wide latest conversation.
- An exited local or remote session becomes idle only after its explicit Resume succeeds; a failed Resume leaves it selected but not entered.
- If an entered session exits or errors, its history remains selected while the interactive surface returns to preview state and offers Resume again.
- A primary click, short tap, Enter, or Space selects the session preview only; it never enters the runtime or reveals rename, delete, or other contextual actions.
- Desktop right-click and mobile long-press are the only pointer gestures that open the session action menu.
- A completed long-press consumes the following synthetic click so opening the action menu does not also switch sessions.

### Session creation

**Widget**: [directory picker, exact-path input, optional title, launch mode, risk explanation, create-and-start action]

**Flow**:

    - Start from the active project's working directory or the selected session's directory -> Browse Home, Root, parent, subdirectories, or enter an exact path -> Enter an optional title -> Choose one of the detected launch modes -> Review any elevated-risk mode -> Create a persistent runtime and start the selected agent -> Keep the session in starting state until its runtime and conversation identities are known.

**behaviour**:

- Invalid, inaccessible, or unresolved directories prevent creation.
- The selected launch mode determines the permission posture for that session.
- A mode that reduces per-action confirmation is clearly marked dangerous and is never selected without an explicit user choice.
- Creation is idempotent for one request; retries do not silently create multiple sessions.
- Every remote agent conversation runs under a persistent remote supervisor.

### Session lifecycle and reconciliation

**Widget**: [session status, reconnect state, revive/resume action, stop action, lifecycle error]

**Flow**:

    - Create a provisional local session identity -> Start the managed remote runtime -> Bind the discovered runtime and agent conversation identities -> Receive ordered events and persist the last processed position -> On reconnect, discover the runtime and conversation, replay missing events, and merge state -> Mark the session ready, running, needs input, disconnected, exited, orphaned, or error.

**behaviour**:

- Closing CozyPad or losing SSH does not stop a healthy remote session.
- Stop interrupts the current agent turn; it does not automatically delete the conversation or project files.
- Runtime termination, session deletion, and conversation deletion are different operations.
- Missing remote state is shown as disconnected or orphaned until reconciliation proves it exited.
- Replayed events are deduplicated and sequence gaps remain visible until resolved.
- Every runtime follower is bound to one launch generation; events, errors, and exit notifications from an older generation cannot change the status, event position, or interactive state of its replacement.

### Chat timeline

**Widget**: [user message, assistant message, inline image attachment, file attachment card, streaming indicator, activity row, tool card, diff card, approval card, question card, usage row, error row, reconnect progress]

**Flow**:

    - Append each normalized event in session order -> Bind every delivered attachment to the user message that submitted it -> Show supported images inline and other files as attachment cards -> Activate an attachment to open its conversation-scoped preview dialog -> Show a bounded full image, bounded readable text, or file metadata according to the attachment kind -> Close the dialog and return focus to the same conversation -> Update an in-progress assistant message or tool card in place -> Keep the view pinned to the bottom only when the user is already near the bottom -> Preserve scroll position per session when switching sessions -> Restore persisted history and its attachment presentation before appending replayed events after reconnect.

**behaviour**:

- Assistant content supports Markdown, tables, syntax-highlighted code, and copyable code blocks.
- Tool cards show status, summary, duration, output, and error, with verbose content collapsed by default.
- Diff cards show file path, additions, deletions, and readable changed lines; large diffs are bounded and expandable.
- Questions expose mutually exclusive choices and lock the chosen answer after submission.
- Usage is tied to the exact session and turn when available.
- A delivered attachment remains visible with its user message after the composer clears, after switching sessions, and after reopening CozyPad.
- A supported image is restored from its conversation-owned path and shown inline with its original name, type, and size; a missing, unsupported, or temporarily unreadable preview remains a file card instead of removing the attachment from history.
- Activating an image attachment opens a modal view that fits the available screen while allowing the original image to be inspected without leaving the conversation.
- Activating a supported text attachment opens a bounded text preview; activating any other file shows its name, type, size, conversation-local path, and the actions that remain available without pretending its content is readable inline.
- An attachment preview closes through its close action, Escape, or the surrounding backdrop and never resumes, stops, or changes the state of the Agent session.
- Failure to load one attachment preview is local to that attachment and does not hide the user message, other attachments, or the rest of the conversation.
- Attachment bytes are loaded only when needed for presentation; persisted conversation history stores bounded attachment metadata rather than embedding the full file payload.
- An attachment-only turn is represented by its attachment presentation and does not require synthetic prompt text.
- Different agent sessions are never merged into one conversational timeline.
- Long timelines remain responsive at ten thousand visible items.

### Composer

**Widget**: [multiline input, attachment action, attachment tray, slash-command menu, send button, stop button]

**Flow**:

    - Type a prompt, select files, or paste images -> Validate each attachment and add it to the active session's local buffer without transferring it -> Show the buffered attachment tray and allow removal -> Optionally recall earlier user prompts or choose a command announced by the active agent -> Press Enter to send or Shift+Enter for a newline -> Package all not-yet-delivered attachments into one batch -> Transfer that batch once and unpack it into the active conversation's private attachment directory -> Bind every landed file to the prompt through its exact conversation-local reference and deliver supported media through the agent's native media input -> Submit the prompt only after every attachment is ready -> Clear the composer only after the send request is accepted -> Preserve the draft and attachment state when packaging, transfer, unpacking, or sending fails.

**behaviour**:

- Input supports IME composition without sending mid-composition.
- Prompt-history navigation activates only at the appropriate text boundary and restores the unfinished draft when leaving history.
- Each session keeps its own draft and pending attachments.
- A session accepts up to ten pending attachments, with a maximum of 20 MB per attachment.
- Selecting a file or pasting an image performs no remote request; pending attachments accumulate locally until the user sends the turn.
- Image attachments show an immediate local preview; non-image attachments show name, type, size, and buffered state.
- Pasted screenshots, pasted image files, and files chosen through the attachment action follow the same validation, buffering, batching, and retry flow.
- One send operation transfers at most one attachment package, regardless of how many pending attachments it contains.
- A drive-style local path is translated only for the unpacking environment and is never interpreted as a remote-host locator; the Agent still receives the exact conversation-local path used by its own machine.
- A batch is accepted atomically: the prompt is not sent and no attachment is exposed to the agent until the full package is unpacked and verified.
- Packaging, transfer, and unpacking failures identify the failed stage and retain the underlying bounded error detail while preserving the buffered attachments for retry.
- Every delivered attachment belongs to exactly one machine, project, and Agent session and cannot be referenced by another session through an attachment identity.
- The message sent to the agent names every delivered non-media file by its exact conversation-local path; supported images use the agent's native media input and are not represented as path-only media.
- Mirroring the visible draft, adding attachment references, and submitting the turn form one logical prompt; text already present in the native input is never appended a second time.
- If attachment delivery succeeds but prompt submission fails, retry reuses the delivered attachment identities and does not upload the same files again.
- A prompt-submission failure is a failed turn, not a failed session: remove the optimistic user turn, keep the draft and attachment buffer retryable, show the delivery error, and keep the session ready when its runtime is still alive.
- Removing a buffered attachment revokes its local preview and removes it from the next package without making a remote request.
- While a turn is running, normal send is disabled and Stop remains available.
- Stopping returns the composer only after the agent confirms interruption or the session state reconciles.

### Slash commands and native interaction

**Widget**: [command suggestions, descriptions, active selection, optional picker, native choice overlay, keyboard/touch navigation]

**Flow**:

    - Read the command list announced by the active agent -> Typing a slash filters matching commands -> Navigate suggestions and either insert, submit, or open the command's dedicated picker -> For native interactive agents, project menus and choices into accessible controls while forwarding the chosen action to the native session.

**behaviour**:

- Commands are capability-driven and may differ by agent and version.
- A command is never guessed solely from a hard-coded list when the active agent has not announced it.
- Escape closes a suggestion or native overlay before it interrupts the active turn.
- Direction keys, Enter, Escape, and pointer selection have equivalent visible outcomes.
- Native interaction remains controlled by the agent's own session; CozyPad does not pretend a scraped screen is a structured event history.

### Approval

**Widget**: [risk summary, exact action, working directory, machine, affected target, allow-once button, deny button, resolved state]

**Flow**:

    - Pause the dependent agent action -> Present the complete approval context -> Let the user allow once or deny -> Submit exactly one resolution and display its recorded outcome.

**behaviour**:

- Pending approval places the session in needs-input state and marks the agent tab.
- Duplicate clicks or replayed approval events do not resolve the request twice.
- Approval for one action does not grant permission to another action.
- Denial is a valid outcome and must not be displayed as a transport error.

### Session deletion

**Widget**: [session identity summary, deletion-scope choices, consequence text, cancel button, confirm button]

**Flow**:

    - Select a session and open Delete -> Choose whether to remove only the local index, stop the remote runtime, remove CozyPad remote event data, or request deletion of the agent-native conversation when supported -> Show the exact effects and irreversibility of every selected scope -> Confirm once and report each result separately.

**behaviour**:

- Project files are never part of session deletion.
- Local-index deletion is the safest default.
- A failure in one deletion scope does not falsely report success for the others.
- The deleted row disappears only when its local removal is confirmed.

## Research Lab

1. Study and experiment browser
2. Pipeline
3. Experiment design
4. Preflight and materialization
5. Run lifecycle and queue
6. Reproducibility and provenance
7. Metrics and artifacts
8. Runs table
9. Ablation analysis
10. Charts and dashboards
11. Agent collaboration

**Widget**: [study browser, experiment versions, Pipeline view, Design view, Runs view, Charts, Artifacts, Notes, inspector]

**Flow**:

    - Create or select a study under the active project -> Define one versioned experiment pipeline -> Declare baseline values, factors, controls, seeds, outcomes, and resource requirements -> Preview and validate all materialized runs -> Confirm launch and execute the runs on the selected machine -> Reconcile status, ingest metrics, index artifacts, and compare results -> Export the evidence needed to reproduce and explain the experiment.

**behaviour**:

- Research Lab is a first-level workspace, not a special Agent conversation.
- A study, experiment, run, process, runtime session, and agent session keep separate identities.
- Research state does not depend on the Research page remaining open.
- Agents may propose and explain changes but cannot silently launch runs or mutate locked plans.

### Study and experiment browser

**Widget**: [project/study list, create-study action, study status, experiment version list, archive action]

**Flow**:

    - Create a study with a title, research question, primary outcome, and minimize/maximize direction -> Create an experiment version from a blank plan or an earlier version -> Edit a draft version -> Lock the version when its first run enters the queue -> Create a new version for later changes.

**behaviour**:

- A study defines shared data and metric meaning across its experiments.
- An experiment is a versioned execution plan with one immutable baseline snapshot after lock.
- Archived experiments remain readable and exportable.
- Editing a locked baseline or control always creates a new plan version.

### Pipeline

**Widget**: [directed pipeline canvas, stage nodes, dependency edges, role legend, stage inspector, graph comparison]

**Flow**:

    - Add stages for dataset snapshot, split, preprocess, normalize/augment, initialize model, train, evaluate, and export -> Connect each stage's outputs to compatible downstream inputs -> Configure inputs, outputs, success conditions, resources, timeout, retry, and cache policy -> Validate the full graph before materializing runs.

**behaviour**:

- The pipeline must remain acyclic.
- Missing required inputs, incompatible artifact types, and unreachable stages block launch.
- A stage cache is reusable only when code, input artifacts, resolved configuration, and environment identity all match.
- Node state distinguishes cached, queued, running, failed, completed, cancelled, and lost.
- Graph comparison highlights every node, edge, input, or output that differs from the baseline.

### Experiment design

**Widget**: [baseline summary, factor controls, locked-control list, seed selector, run-count formula, resource estimate]

**Flow**:

    - Classify every relevant field as factor, control, derived value, observed nuisance, or outcome -> Select a baseline value for each factor -> Select alternative factor values and repeated seeds -> Choose one-factor-at-a-time or full/grid factorial design -> Preview the total number of runs and available resource estimate.

**behaviour**:

- A factor is intentionally varied; a control is locked; a derived value is computed; a nuisance is observed; an outcome is compared.
- The baseline is always included in the plan.
- Repeated seeds use the same seed set across comparable factor values.
- Factorial designs show the exact combination count before launch.
- Resource cost, queue impact, and duration estimates are labelled as estimates rather than guarantees.

### Preflight and materialization

**Widget**: [run preview table, validation summary, configuration diff, control-drift warning, launch confirmation]

**Flow**:

    - Resolve one immutable configuration for every planned run -> Compare each resolved configuration with the locked baseline -> Verify declared factors, controls, dataset revision, split, metric definition, seeds, paths, and resources -> Show run count, host, expected resources, and material differences -> Block invalid plans or explicitly launch the validated set.

**behaviour**:

- A one-factor-at-a-time run may differ only in one declared factor and its seed.
- A factorial run may differ only within its declared factor set and seed.
- Control, dataset, split, or metric-definition drift blocks launch.
- An amendment is a new plan version and is not silently merged with earlier runs in analysis.
- Previewed temporary run labels are not reused as formal run identity after launch.

### Run lifecycle and queue

**Widget**: [queue, run status, progress, heartbeat age, pause/resume/cancel/retry actions, lifecycle error]

**Flow**:

    - Move a confirmed run from draft to queued -> Perform preflight immediately before execution -> Start the remote process and establish its execution locator -> Stream status, heartbeat, logs, metrics, and artifacts -> Complete, fail, cancel, pause, resume, or mark the run lost according to observed evidence -> Reconcile unknown or lost state after reconnect -> Retry by creating a new run linked to the earlier run.

**behaviour**:

- Valid run states are draft, queued, preflight, launch-unknown, running, paused, completed, failed, cancelled, and lost.
- Only defined state transitions are allowed; repeating the current state is harmless.
- A launch timeout with unknown remote outcome becomes launch-unknown, not failed.
- Missing heartbeat and process evidence becomes lost until reconciliation proves another state.
- Cancel stops execution but preserves logs, partial metrics, and existing artifacts.
- Resume is enabled only when the stage declares recovery support and a valid checkpoint exists.
- Retrying never overwrites the earlier run or its evidence.

### Reproducibility and provenance

**Widget**: [provenance summary, completeness status, configuration snapshot, environment summary, data identity, export action]

**Flow**:

    - Before running, capture code revision and dirty-state identity -> Capture dataset identity, split assignment, preprocessing, complete resolved configuration, commands, working directory, and allowed environment information -> Capture runtime, framework, driver, hardware, resource limit, seed, initialization, dependency, and container/environment identity when present -> Hash immutable inputs and save the provenance with the run -> Mark whether the evidence is complete enough to claim reproducibility.

**behaviour**:

- Secrets, tokens, and unrestricted environment dumps never enter provenance.
- Missing required provenance may remain a draft or ordinary completed run, but cannot be labelled reproducible.
- Initialization records distinguish random, pretrained, and checkpoint sources and include immutable revision, seed, selected layers, load mismatches, and freeze policy.
- Total and trainable parameter counts are recorded as derived values; they are visible in comparisons when initialization or freezing differs.

### Metrics and artifacts

**Widget**: [live metrics, metric-definition details, artifact index, log links, checkpoint metadata, download action]

**Flow**:

    - Receive metric events associated with one exact run -> Validate name, value, step or epoch, split, time, unit, aggregation, direction, and metric-definition version -> Deduplicate repeated events and accept valid late-arriving events -> Register artifacts with name, type, size, hash, producing stage, and retention policy -> Keep large artifacts remote until the user requests synchronization or download.

**behaviour**:

- Metrics with the same name but different units or definitions are not combined.
- Missing, not-a-number, infinite, late, failed, and cancelled data are visible; none are replaced with zero.
- Artifact identity is content-aware and remains traceable to its producing run and stage.
- Checkpoints keep enough metadata to judge compatibility before resume or reuse.

### Runs table

**Widget**: [filter, sort, group, pivot, pinned columns, saved view, selectable run rows, expandable detail]

**Flow**:

    - Filter the experiment's runs -> Select one or more runs as the active analysis set -> Inspect factors, controls, seed, outcomes, duration, hardware, resource use, code, and data identity -> Expand a row for configuration diff, logs, metrics, artifacts, provenance, and linked Agent sessions.

**behaviour**:

- Table selection is the single source for Charts, effect summaries, and exports.
- Failed, cancelled, lost, and missing-metric runs remain visible in counts and filters.
- Saved views preserve visible columns, ordering, grouping, filters, and metric-definition versions.
- A selected run is never silently removed from analysis due to missing data.

### Ablation analysis

**Widget**: [baseline selector, effect summary, sample count, seed distribution, confidence interval, interaction warning]

**Flow**:

    - Select a locked baseline and comparable runs -> Validate that controls and metric definitions match -> Calculate absolute and relative change from baseline -> Summarize run count, seeds, mean, variation, interval, failures, and missing values -> Show interaction analysis when more than one factor varies.

**behaviour**:

- Control drift prevents a causal-effect presentation.
- Insufficient design or sample size is labelled descriptive rather than causal.
- Main effects are not shown without an interaction warning when multiple factors may interact.
- The user can trace every number back to exact run identities and metric definitions.

### Charts and dashboards

**Widget**: [chart type selector, shared filters, faceting controls, dashboard canvas, table/chart/metric/note panels, export]

**Flow**:

    - Use the active run selection from the Runs table -> Choose learning curve, scatter, distribution, heatmap, parallel coordinates, effect, interaction, or Pareto view -> Configure axes, grouping, faceting, and metric definition -> Save useful views as dashboard panels -> Arrange panels and export visual or tabular evidence.

**behaviour**:

- Learning curves preserve their actual lengths and are never padded with zero.
- Every chart exposes its run set, filters, grouping, and metric version.
- Dashboard header always shows dataset revision, baseline, run count, failed count, and last update.
- A dashboard saves panel queries and layout without copying or mutating the underlying run data.
- Mobile provides overview, run status, core charts, approvals, and notes; complex pipeline and dashboard editing may remain desktop-only.

### Agent collaboration

**Widget**: [linked Agent sessions, propose-plan action, reviewable patch, launch review, cited-run links]

**Flow**:

    - Give an Agent only the study, runs, logs, metrics, and artifacts explicitly authorized by the user -> Let the Agent propose pipeline, factors, controls, metrics, seeds, diagnosis, or narrative -> Convert a proposed plan change into a reviewable patch -> Show affected runs, configuration differences, resources, host, time, and cost when available -> Apply or reject the patch; launch remains a separate confirmed action.

**behaviour**:

- An Agent cannot directly execute arbitrary shell text as a research run.
- An Agent cannot silently launch or cancel runs, increase resources, edit locked controls, change data identity, or alter analysis filters.
- Agent-authored conclusions cite exact run identities, metric definitions, and filters.
- A study or run may link to multiple Agent sessions, and one Agent session may discuss multiple runs.
- Chat cards link back to the precise study, experiment, run, artifact, or dashboard view being discussed.

## Terminal

1. Terminal emulation
2. Quick commands
3. Special-key row

**Widget**: [terminal tab bar, new/close tab actions, terminal pane, quick-command panel, special-key row, status notification]

**Flow**:

    - Connect to a machine -> Open one or more terminal tabs in the current project working directory -> Interact directly with the shell or paste/execute a reviewed quick command -> Switch tabs without closing their live channels -> Close a tab explicitly or when its remote terminal exits.

**behaviour**:

- Each tab is an independent live terminal session.
- Opening or closing a Terminal tab does not affect Agent sessions or Research runs unless the user explicitly acts on their remote runtime.
- A remote terminal exit closes its local tab and reports the exit instead of leaving an inert pane.
- Disconnect closes live Terminal tabs; persistent work under the remote supervisor may be reattached in a new tab after reconnect.

### Terminal emulation

**Widget**: [full terminal viewport, scrollback, search, selection, copy/paste]

**Flow**:

    - Open an interactive shell channel sized to the visible terminal -> Forward input and resize events -> Render output, alternate screens, colors, cursor state, and mouse mode -> Preserve local scrollback while the channel remains open.

**behaviour**:

- Interactive programs, editors, pagers, monitors, and remote multiplexers work without a special compatibility mode.
- True color, alternate screen, mouse mode, bracketed paste, CJK width, emoji, and combining characters are supported.
- Selecting text and invoking the context action copies it; invoking the context action without a selection pastes clipboard text.
- Touch dragging scrolls local history without sending navigation keys to the remote program.
- Terminal search and copy operate on visible terminal history, not on Agent chat history.

### Quick commands

**Widget**: [toggle, categorized command list, paste action, execute action]

**Flow**:

    - Open the quick-command panel -> Choose Paste to insert a command for review -> Choose Execute to send that exact command immediately.

**behaviour**:

- Paste is the safer default action.
- Execute is visually distinct from Paste.
- Commands cover common navigation, version control, machine status, runtime listing, and development-environment checks.
- A command with an unfinished target is pasted for completion rather than executed.

### Special-key row

**Widget**: [Escape, Tab, Control, Alt, arrows, Home/End, Page Up/Down, common symbols]

**Flow**:

    - Enable the key row automatically on touch-oriented screens or manually on desktop -> Toggle modifier keys or send a special key -> Repeat supported navigation keys while held -> Return focus to the terminal after each action.

**behaviour**:

- Modifier state is visible and applies to the next relevant key sequence.
- Page Up and Page Down scroll terminal history when intended as local navigation.
- Using the key row does not dismiss the mobile software keyboard unnecessarily.

## Files

1. Navigation and symbolic links
2. File and directory operations
3. Text and Markdown editor
4. Binary preview and download

**Widget**: [Home/Root/current-working-directory shortcuts, exact-path navigation, directory list, breadcrumbs, action toolbar, remote clipboard, preview/editor pane, context menu]

**Flow**:

    - Connect and open the machine's home directory -> Navigate by folder, parent, breadcrumb, root shortcut, current working directory, symbolic link, or exact path -> Select a file or directory -> Preview, edit, download, copy, move, rename, duplicate, delete, or set a working directory according to item type -> Refresh only the affected directories after a successful operation.

**behaviour**:

- Directory listing reads only the requested level and does not recursively scan the tree.
- Very large directories use a bounded listing and clearly disclose truncation.
- Right-click and touch long-press open the same action menu.
- Each operation shows pending, success, or failure feedback.
- Disconnect clears live listings and drafts after protecting unsaved work.

### Navigation and symbolic links

**Widget**: [folder rows, parent row, breadcrumbs, path dialog, Home, Root, current-working-directory shortcut, link target card]

**Flow**:

    - Resolve the requested directory path -> Display its immediate children and canonical path -> For a symbolic link, show the target and whether it is a file, directory, or missing -> Follow a valid link only after an explicit open action.

**behaviour**:

- Home shorthand and absolute paths are accepted.
- Breadcrumbs always represent the resolved current path.
- Relative link targets resolve from the link's parent directory.
- Broken links remain visible and explain why they cannot be followed.
- Navigation away from an edited file first protects unsaved changes.

### File and directory operations

**Widget**: [new file, new folder, rename, duplicate, staged copy, staged move, paste-here, copy path/name, download, delete]

**Flow**:

    - Select an item and an operation -> Validate the exact source, target directory, and new name where relevant -> Confirm destructive actions -> Perform the operation -> Refresh source and destination views and report the result.

**behaviour**:

- Copy and Move support a two-step remote clipboard: stage an item, navigate, then paste it into the current directory.
- A staged copy remains available for repeated paste; a successful staged move clears itself.
- Duplicate creates a sibling copy without changing the original.
- Copy name, absolute path, and relative path are separate actions.
- Set current working directory changes the default for new Terminal tabs and Agent sessions without moving files.
- Recursive directory deletion clearly states that all contents are included and requires confirmation.
- Name and path validation prevents control characters, path confusion, and unintended traversal.

### Text and Markdown editor

**Widget**: [syntax-aware editor, dirty indicator, save action, Markdown edit/preview switch, find and navigation controls]

**Flow**:

    - Open a supported text file within the safe editor-size limit -> Edit its contents and mark the draft dirty -> Save the complete new contents to the same remote path -> Refresh metadata and mark the draft clean after confirmed success.

**behaviour**:

- Text, code, configuration, logs, tabular text, hidden text files, and reasonable extensionless files are editable.
- The normal inline editor limit is 256 KB; larger text files remain downloadable but are not silently truncated into an editable draft.
- Markdown can switch between source editing and rendered preview without losing the draft.
- Leaving the file, changing machine, reloading, or closing with unsaved changes requires confirmation.
- A failed save preserves the dirty draft and exposes the error.

### Binary preview and download

**Widget**: [supported preview, file metadata, download action, unsupported-format explanation]

**Flow**:

    - Detect a supported preview type -> Load only the selected file -> Render a PDF preview or explain that the binary format is download-only -> Download using the original filename and best known media type.

**behaviour**:

- A binary file is never decoded as text merely because its extension is unknown.
- Downloads preserve byte-exact content and the original filename.
- On mobile, downloads go through the operating system's public download or document-save flow rather than an unreliable web-only download path.
- Unknown formats use a generic binary media type and are never renamed to another extension.
- Download filename validation rejects path separators and control characters.

## Machine monitor

- CPU status: `htop`
    - number of running CPU / Total number of CPU
    - highest usage of CPU
- GPU status: `nvidia-smi` 
- RAM status
- Storage: report `df -h` but temp ones
- Active GPU processes

**Widget**: [machine identity, last-sync time, CPU card, memory card, GPU card, storage list, GPU device list, active-process table, process-command dialog]

**Flow**:

    - Start telemetry after a machine becomes connected -> Collect a fresh snapshot at a regular interval, normally every five seconds -> Align each snapshot to the active machine and timestamp -> Replace the visible snapshot atomically -> Stop presenting it as live when disconnected.

**behaviour**:

- Missing metrics are shown as unavailable, not zero.
- The last successful synchronization time is always visible.
- A slow or failed metric source does not prevent other metric groups from updating.
- Monitor is observational by default; it does not kill a process merely by selecting it.

### CPU status

**Widget**: [overall usage, active/logical CPU count, busiest CPU, per-CPU detail]

**Flow**:

    - Compare consecutive CPU samples -> Calculate overall and per-CPU utilization for the observed interval -> Identify the busiest CPU and update the summary.

**behaviour**:

- Show overall utilization for the sampling interval.
- Show the number of observed CPUs and the busiest CPU's utilization.
- Per-CPU details remain available without overwhelming the summary.
- A first sample that lacks a comparison interval is labelled collecting rather than reported as an exact zero.

### GPU status

**Widget**: [GPU count, average utilization, total/used video memory, per-device name, index, utilization, memory, temperature]

**Flow**:

    - Discover supported GPU devices -> Collect utilization, video-memory, temperature, and process data for each device -> Build a machine summary while retaining per-device detail.

**behaviour**:

- Systems without supported GPU telemetry show GPU unavailable and keep CPU and memory monitoring functional.
- Multi-GPU summary aggregates utilization and memory while preserving per-device detail.
- Temperature and memory pressure use clear warning states without implying hardware failure from one sample.

### RAM status

**Widget**: [used memory, total memory, percentage]

**Flow**:

    - Read used and total physical memory from the same snapshot -> Calculate the percentage and present the absolute values together.

**behaviour**:

- Used and total memory are shown in human-readable units.
- The percentage uses the same snapshot as the displayed absolute values.
- Unavailable memory information is not estimated from unrelated metrics.

### Storage status

**Widget**: [mount point, filesystem label when available, used, available, total, percentage, warning state]

**Flow**:

    - Discover mounted filesystems -> Remove temporary, virtual, duplicate, and pseudo filesystems from the default view -> Calculate use for each remaining mount and highlight capacity risk.

**behaviour**:

- Show persistent, user-relevant filesystems.
- Temporary, virtual, duplicate, or pseudo filesystems are excluded from the default summary.
- Nearly full storage is visually prominent because it can interrupt Agents and Research runs.
- Storage collection failure does not erase the last known value without marking it stale.

### Active GPU processes

**Widget**: [GPU index, process identity, user, runtime, command summary, video-memory use, full-command dialog, copy action]

**Flow**:

    - Select a process row -> Show the complete observed command in a dialog -> Copy it or close the dialog.

**behaviour**:

- Long commands are truncated only in the table, never in the detail dialog.
- A process is associated with the exact GPU and snapshot in which it was observed.
- Disappearing processes leave the next snapshot naturally; they are not reported as killed by CozyPad.

## Settings

1. Remote settings
2. Background execution
3. Local appearance
4. Remote cleanup
5. About and diagnostics

**Widget**: [remote settings, background execution, local appearance, connection summary, cleanup, about]

**Flow**:

    - Open Settings at any time -> Read local settings immediately -> Read remote settings only when connected -> Apply each changed setting at its owning scope -> Report whether it took effect immediately or requires reconnect/restart.

**behaviour**:

- Every setting is labelled Local, Remote, Mobile, or Machine-specific.
- Changing a setting never silently changes the active machine, project, session, or research plan.
- Settings that are unavailable on the current platform are hidden or clearly disabled.

### Remote settings

**Widget**: [mouse-mode toggle, managed runtime socket, apply status]

**Flow**:

    - Load settings from the active remote machine -> Change a supported option -> Update only CozyPad's managed configuration block -> Apply it to active compatible sessions when safe.

**behaviour**:

- Remote settings follow the machine and are visible from another CozyPad device connected to the same account and host.
- Mouse mode controls remote history scrolling, selection, and pane interaction.
- The managed runtime socket is visible so session location can be diagnosed.
- User-authored configuration outside CozyPad's managed block is preserved byte-for-byte.

### Background execution

**Widget**: [keep-connection-in-background toggle, operating-system status explanation]

**Flow**:

    - Detect whether the current device supports background connection retention -> Enable or disable it through the operating system's visible background mode -> Report the effective state and explain what happens when the app is backgrounded.

**behaviour**:

- On supported mobile platforms, enabling the option keeps the live connection through a visible operating-system background service.
- Disabling it allows the operating system to freeze the connection when backgrounded.
- Remote persistent sessions and runs continue in either case and reconcile when the app returns.

### Local appearance

**Widget**: [theme, text scale, terminal font, terminal font size]

**Flow**:

    - Change one appearance preference -> Preview it immediately where safe -> Save it for the current device or restore the previous value on failure.

**behaviour**:

- Appearance changes affect only the current device.
- Terminal font choices prioritize monospaced CJK coverage.
- Text scaling preserves controls, dialogs, tables, and code without clipping essential actions.

### Remote cleanup

**Widget**: [cleanup explanation, remove CozyPad traces action, optional remove user-level runtime action, progress, result]

**Flow**:

    - Connect to the target remote machine -> Choose basic cleanup or cleanup plus the user-level runtime installed by CozyPad -> Show the exact categories that will be removed and what will be preserved -> Confirm and execute -> Report every removed item or state that no CozyPad trace was found.

**behaviour**:

- Basic cleanup removes CozyPad metadata, build temporary files, logs, and managed shell/terminal configuration blocks.
- Optional runtime removal deletes only the user-level copy installed by CozyPad; it never removes a system runtime.
- Project files, agent-native data, user shell configuration, and unrelated terminal configuration are preserved.
- Partial failure reports remaining items and is safe to retry.

### About and diagnostics

**Widget**: [application version, platform mode, protocol compatibility, Agent capability summary, copy-diagnostics action]

**Flow**:

    - Collect non-secret application, platform, compatibility, connection, and capability information -> Redact sensitive and unnecessary personal data -> Show or copy the resulting diagnostic summary.

**behaviour**:

- Diagnostics identify the application and compatibility versions without exposing credentials or unrestricted environment data.
- Demonstration/mock data is clearly marked and cannot be mistaken for a real connected machine.
- Copyable diagnostics redact secrets, private paths when unnecessary, and raw prompt content by default.

## Cross-module behaviour

1. Machine switching
2. Working-directory handoff
3. Agent and Research linking
4. Resource correlation

**Widget**: [active machine summary, active project summary, protected-change prompt, handoff target, linked-object summary, related-resource context]

**Flow**:

    - receive a machine, project, directory, link, or resource-context change from one module -> protect unfinished work in every affected module -> transfer only the shared identity or reference needed by the target modules -> reconcile each affected module against its own authoritative state -> show the new shared context only after the handoff is complete

**behaviour**:

- Cross-module handoff shares identities, paths, selections, and observed context; it does not merge the modules' underlying objects.
- A source module cannot silently execute a destructive or launch action in a target module.
- Each module retains ownership of its drafts, live channels, pending decisions, and failure state.
- A partial handoff identifies which modules accepted the new context and which still require recovery or user action.

### Machine switching

**Widget**: [unsaved-change prompt, machine selector, connection progress, workspace refresh status]

**Flow**:

    - protect unsaved file edits and unresolved destructive dialogs -> stop or close live channels that cannot belong to two machines -> disconnect the current machine -> connect and verify the target machine -> restore that machine's project, sessions, research state, and preferences -> refresh Files and Monitor before showing them as current

**behaviour**:

- Agent and Research runtimes on the previous remote machine continue unless explicitly stopped.
- A Terminal tab never migrates its byte stream from one machine to another.
- Clipboard staging, selected paths, process details, and telemetry are machine-scoped and are cleared or restored only within the same machine.

### Working-directory handoff

**Widget**: [selected directory, current-working-directory action, target-module summary]

**Flow**:

    - choose a directory in Files or a project context -> mark it as the current working directory -> use it as the default for the next Terminal tab, Agent session, or Research plan

**behaviour**:

- Changing the default does not change the working directory of an already running process.
- The exact machine and path are shown before creating new work.

### Agent and Research linking

**Widget**: [link action, linked-object summary, open-linked-object action, unlink action]

**Flow**:

    - link an Agent session to a study, experiment, run, artifact, or dashboard view -> preserve both original identities -> navigate in either direction without copying the underlying content

**behaviour**:

- Link removal does not delete either object.
- Agent conclusions retain citations to the exact Research selection used.

### Resource correlation

**Widget**: [time-aligned resource summary, related run/session links, observation disclaimer]

**Flow**:

    - timestamp Monitor snapshots -> associate snapshots with running Research runs and Agent runtimes on the same machine when their time ranges overlap -> display the correlation as observed context

**behaviour**:

- Time overlap is contextual evidence, not proof of exclusive resource ownership.
- A correlation never changes a run, session, or process identity.

## Product-level acceptance conditions

- Local mode starts without asking the user to connect to their own machine.
- Switching machines never leaves a hidden second active connection.
- First-time and changed host fingerprints both require explicit, informed decisions.
- Stored credentials cannot be read back through ordinary application views, errors, logs, or diagnostics.
- Agent work continues after closing the application, network loss, and device switching when the remote runtime remains healthy.
- Agent session identity does not change when its title or runtime display name changes.
- Reconnection after a thirty-minute interruption loses no persisted Agent event and creates no duplicate event.
- A fresh application launch shows no Agent conversation by default; selecting one reveals history only, and entering or reviving it always requires an explicit Resume.
- Claude, Codex, and agy pages keep independent selection, drafts, filters, attachments, and scroll positions.
- A selected attachment or pasted screenshot remains buffered until Send, is delivered once to the selected conversation, remains visible beside the submitted user message, and opens an appropriate preview from that message.
- Structured Chat does not depend on terminal screen scraping during normal operation.
- A ten-thousand-item conversation remains usable.
- Files protects unsaved edits and never makes a truncated file editable as if complete.
- File downloads preserve exact bytes and original safe filename.
- Monitor distinguishes unavailable, stale, and zero values.
- Research preflight rejects control, data, split, or metric-definition drift.
- Every completed reproducible run can export its resolved plan, provenance, metrics, and artifact index.
- Runs table, charts, effect summaries, dashboards, and exports use the same explicit run selection.
- Failed, cancelled, lost, and missing-metric runs remain visible in research analysis.
- Uninstall removes local CozyPad data; remote cleanup removes only explicitly selected CozyPad-owned remote traces; user project files and exported downloads remain intact.

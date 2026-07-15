# Hermes Harness MVP (Route A)

This package implements the first Dart-native Hermes harness inside the Flutter dashboard.

It is intentionally **not** a Python sidecar, Docker wrapper, WSL launcher, or prompt-only impersonation layer. Google AI Studio is only the model provider. The dashboard app owns the agent harness.

## What changed

- Added `hermes/harness/hermes_harness.dart`.
- Added `HermesHarness`, `HermesRuntimeContext`, `HermesToolRegistry`, `HermesToolDefinition`, `HermesProtocolCodec`, and `HermesHarnessConfig`.
- `HermesAgentEngine.runTurn()` now delegates into `HermesHarness` instead of owning a prompt-only loop.
- The harness now owns:
  - runtime-frame assembly
  - session load/sync/persist
  - frozen memory prompt snapshot
  - explicit memory preflight
  - dashboard/GPU/task preflight
  - registered tool schema
  - approval-policy checks
  - tool dispatch through `HermesToolGateway`
  - observation folding
  - model continuation after tool observations
  - repeated-tool and tool-budget guards

## Still MVP / not yet done

- Approval UI for blocked mutating tools is not implemented yet; unsafe tools are blocked.
- Official Hermes Python skills/scheduler/gateways are not bundled.
- Session store is JSON-based, not SQLite.
- The tool registry is in Dart, not dynamically loaded from Hermes Python modules.

## Why this is Route A

Route A means a Dart-native harness subset embedded in the dashboard app. This keeps the product install simple: users download the dashboard app, set SSH/API keys, and use Hermes without installing Hermes, Docker, WSL, or a Python runtime.

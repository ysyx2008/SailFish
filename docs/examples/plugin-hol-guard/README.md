# HOL Guard plugin example

This example connects SailFish's `before_tool_call` hook to the installed HOL Guard CLI for the built-in `execute_command` tool.

## Install

1. Install HOL Guard so `hol-guard` is available on `PATH`.
2. Copy this directory into the SailFish plugin directory, or package it with `openclaw.plugin.json` and install it through SailFish's plugin installer.
3. Restart SailFish.

## Behavior

Before SailFish runs `execute_command`, the plugin sends the exact `toolArgs.command` value to:

```bash
hol-guard command test --json -- "<command>"
```

The adapter allows the call only when Guard returns `minimum_action: "allow"` and marks the command explicitly benign. A successfully returned Guard `review` result requires human approval through SailFish's native approval flow, including in permissive mode. Block decisions, nonzero CLI exits, malformed output, missing command input, a missing Guard executable, timeouts, and other adapter failures block execution.

Other SailFish tools are not changed by this example. SailFish's own command risk and approval rules remain in force after Guard allows a command.

## Scope and availability

This example covers only `execute_command` and its `toolArgs.command` string. It does not inspect `exec` scripts, `await_exec`, or `send_input`. All three remain outside this adapter's coverage; `await_exec` and `send_input` do not provide the same command field.

The manifest enables the plugin by default. If enabled without `hol-guard` on `PATH`, or if Guard times out or returns invalid output, every covered `execute_command` call is blocked. Install and verify the CLI before enabling the plugin. The check runs asynchronously with a 10-second timeout so it does not block Electron's main thread while waiting for Guard.

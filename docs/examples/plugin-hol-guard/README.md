# HOL Guard plugin example

This example connects SailFish's `before_tool_call` hook to the installed HOL Guard CLI for the built-in `execute_command` tool.

## Install

1. Install HOL Guard so `hol-guard` is available on `PATH`.
2. Copy this directory into the SailFish plugin directory, or package it with `openclaw.plugin.json` and install it through SailFish's plugin installer.
3. Restart SailFish.

## Behavior

Before SailFish runs `execute_command`, the plugin sends the exact `toolArgs.command` value to:

```bash
hol-guard command test "<command>" --json
```

The adapter allows the call only when Guard returns `minimum_action: "allow"` and marks the command explicitly benign. A Guard `review` result maps to SailFish's native approval flow. Block decisions, malformed output, missing command input, a missing Guard executable, timeouts, and other adapter failures block execution.

Other SailFish tools are not changed by this example. SailFish's own command risk and approval rules remain in force after Guard allows a command.

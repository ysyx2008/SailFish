/* eslint-env node */
const { execFileSync } = require('node:child_process')

const GUARDED_TOOL = 'execute_command'
const GUARD_TIMEOUT_MS = 10_000

function readMinimumAction(payload) {
  return typeof payload?.minimum_action === 'string'
    ? payload.minimum_action
    : typeof payload?.policy_action === 'string'
      ? payload.policy_action
      : null
}

function isExplicitlyBenign(payload) {
  if (payload?.classification && typeof payload.classification.explicitly_benign === 'boolean') {
    return payload.classification.explicitly_benign
  }
  return payload?.explicitly_benign === true
}

function decisionFromGuardPayload(payload) {
  const action = readMinimumAction(payload)

  if (action === 'allow' && isExplicitlyBenign(payload)) {
    return {}
  }

  if (action === 'review') {
    return { requireApproval: true }
  }

  return { block: true }
}

function runGuard(command) {
  const stdout = execFileSync(
    'hol-guard',
    ['command', 'test', command, '--json'],
    {
      encoding: 'utf8',
      timeout: GUARD_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )

  return JSON.parse(stdout)
}

function createBeforeToolCallHook(inspectCommand = runGuard) {
  return async (context) => {
    if (context.toolName !== GUARDED_TOOL) return {}

    const command = context.toolArgs?.command
    if (typeof command !== 'string' || command.trim().length === 0) {
      return { block: true }
    }

    try {
      return decisionFromGuardPayload(await inspectCommand(command))
    } catch {
      return { block: true }
    }
  }
}

module.exports = {
  GUARDED_TOOL,
  createBeforeToolCallHook,
  decisionFromGuardPayload,
  default: {
    id: 'hol-guard',
    register(api) {
      api.registerHook('before_tool_call', createBeforeToolCallHook())
    }
  }
}

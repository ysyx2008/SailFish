/* eslint-env node */
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

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

async function runGuard(command, executeFile = execFileAsync) {
  const { stdout } = await executeFile(
    'hol-guard',
    ['command', 'test', '--json', '--', command],
    {
      encoding: 'utf8',
      timeout: GUARD_TIMEOUT_MS,
      windowsHide: true
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
  runGuard,
  createBeforeToolCallHook,
  decisionFromGuardPayload,
  default: {
    id: 'hol-guard',
    register(api) {
      api.registerHook('before_tool_call', createBeforeToolCallHook())
    }
  }
}

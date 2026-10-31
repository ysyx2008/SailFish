/* eslint-env node */
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

const GUARDED_TOOL = 'execute_command'
const GUARD_TIMEOUT_MS = 10_000

function readMinimumAction(payload) {
  // `command test --json` must provide the authoritative minimum action.
  // Do not promote a partial hook/policy status into an execution allow.
  return typeof payload?.minimum_action === 'string' ? payload.minimum_action : null
}

function isExplicitlyBenign(payload) {
  // A top-level benign hint cannot replace the command classification contract.
  return payload?.classification?.explicitly_benign === true
}

function decisionFromGuardPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { block: true }
  }
  const action = readMinimumAction(payload)
  // An explicit stop cannot be overridden by a benign classification.
  if (Object.prototype.hasOwnProperty.call(payload, 'continue') &&
      payload.continue !== true) {
    return { block: true }
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'decision')) {
    const decision = typeof payload.decision === 'string'
      ? payload.decision.trim().toLowerCase()
      : ''
    // Review can remain in SailFish's native human-approval path, never allow.
    if (decision !== 'allow' && !(decision === 'review' && action === 'review')) {
      return { block: true }
    }
  }

  // Inspection-only output may have no native hook envelope. If an
  // enforcement field is present, however, it must not contradict the
  // classified action or SailFish's human-approval path.
  if (Object.prototype.hasOwnProperty.call(payload, 'policy_action')) {
    const policyAction = payload.policy_action
    if (policyAction !== 'allow' && policyAction !== 'not_run' &&
        !(policyAction === 'review' && action === 'review')) {
      return { block: true }
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'hookSpecificOutput')) {
    const hook = payload.hookSpecificOutput
    if (!hook || typeof hook !== 'object' || Array.isArray(hook) ||
        hook.hookEventName !== 'PreToolUse' ||
        (hook.permissionDecision !== 'allow' &&
          !(hook.permissionDecision === 'ask' && action === 'review'))) {
      return { block: true }
    }
  }

  if (action === 'allow' && isExplicitlyBenign(payload)) {
    return {}
  }

  if (action === 'review') {
    return { requireApproval: true }
  }

  return { block: true }
}

// JSON.parse silently retains the last duplicate object member. Reject duplicate
// keys at every level so a forged allow cannot overwrite a Guard stop signal.
// JSON.parse validates the full syntax first; this second pass checks key identity.
function parseGuardJson(output) {
  const parsed = JSON.parse(output)
  let offset = 0

  function skipWhitespace() {
    while (offset < output.length && /\s/.test(output[offset])) offset++
  }

  function readString() {
    const start = offset++
    while (offset < output.length) {
      const ch = output[offset++]
      if (ch === '\\') offset++
      else if (ch === '"') return JSON.parse(output.slice(start, offset))
    }
    throw new SyntaxError('unterminated JSON string')
  }

  function readValue() {
    skipWhitespace()
    if (output[offset] === '{') return readObject()
    if (output[offset] === '[') return readArray()
    if (output[offset] === '"') return readString()
    while (offset < output.length && !/[\s,\]}]/.test(output[offset])) offset++
  }

  function readObject() {
    offset++
    skipWhitespace()
    const keys = new Set()
    if (output[offset] === '}') { offset++; return }
    while (offset < output.length) {
      const key = readString()
      if (keys.has(key)) throw new SyntaxError('duplicate JSON member')
      keys.add(key)
      skipWhitespace()
      if (output[offset++] !== ':') throw new SyntaxError('invalid JSON object')
      readValue()
      skipWhitespace()
      const next = output[offset++]
      if (next === '}') return
      if (next !== ',') throw new SyntaxError('invalid JSON object')
      skipWhitespace()
    }
  }

  function readArray() {
    offset++
    skipWhitespace()
    if (output[offset] === ']') { offset++; return }
    while (offset < output.length) {
      readValue()
      skipWhitespace()
      const next = output[offset++]
      if (next === ']') return
      if (next !== ',') throw new SyntaxError('invalid JSON array')
    }
  }

  readValue()
  skipWhitespace()
  if (offset !== output.length) throw new SyntaxError('invalid JSON suffix')
  return parsed
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

  return parseGuardJson(stdout)
}

function createBeforeToolCallHook(inspectCommand = runGuard) {
  return async (context) => {
    // An absent or malformed tool identity is not proof that this is an
    // unrelated tool. A lost execute_command name must not bypass the gate.
    if (!context || typeof context.toolName !== 'string' || !context.toolName.trim()) {
      return { block: true }
    }
    if (context.toolName !== GUARDED_TOOL) return {}

    const command = context.toolArgs?.command
    if (typeof command !== 'string' || command.trim().length === 0) {
      return { block: true }
    }

    try {
      const verdict = await inspectCommand(command)
      // A concurrent caller must not swap the tool or command after inspection.
      if (context.toolName !== GUARDED_TOOL ||
          context.toolArgs?.command !== command) {
        return { block: true }
      }
      return decisionFromGuardPayload(verdict)
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

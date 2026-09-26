export type {
  AuditContext,
  AuditedCall,
  AuditedRedirect,
  CallRiskAssessment,
  CommandRiskAssessment,
  WorkspaceZone,
  SystemPathPattern,
} from './types'

export {
  PROTECTED_WORKSPACE_DIRS,
  PROTECTED_WORKSPACE_FILES,
  SYSTEM_PATH_PATTERNS,
} from './types'

export { defaultAuditContext } from './assess-shell'

export { assessAuditedCall, assessRedirectPaths, aggregateHasUnknown } from './assess-call'

export { checkIndirectionGuard, dangerousByGuard } from './indirection-guard'

export { isHardBlocked, riskNeedsConfirm, commandNeedsConfirm, isSubAgentBlocked, displayRiskLevel, formatHardBlockedMessage } from './confirm-policy'

export { assessShellRisk, shellNeedsConfirm } from './assess-shell'

export { ensureShellAstReady, parseShellCommand } from './parser'

export { extractAuditedCalls } from './extract-calls'

export { extractPwshAuditedCalls, ensurePwshAstReady } from './extract-pwsh-calls'

export { isWindowsNativeShellCommand } from './platform-detect'

export {
  adjustRiskByPathZones,
  getBuiltinTempRoots,
  getWorkspaceZone,
  isLexicallyAbsolutePath,
  isSystemPath,
  resolveCommandPath,
  resetBuiltinTempRootsCacheForTest,
} from './workspace-guard'

export {
  ALLOWED_USERDATA_ENTRIES,
  READONLY_USERDATA_ENTRIES,
  initUserDataGuard,
  isUserDataForbidden,
} from './userdata-guard'
export type { UserDataAccess } from './userdata-guard'

export {
  ARGV_COMMAND_RULES,
  assessCommandFlags,
  basenameCommand,
  getBuiltinArgvCommandRule,
  normalizeFlags,
  splitArgv,
} from './whitelist'

export { getArgvCommandRule } from './resolve-argv-rule'

export { resolveTrustCommandOffer } from './trust-command-offer'
export type { TrustCommandOffer } from './trust-command-offer'

export type { CommandRule, ParsedArgv } from './whitelist'

export {
  getUserCommandRules,
  lookupUserCommandRule,
  USER_COMMAND_RULES_FILENAME,
  USER_RULE_ALLOWED_LEVELS,
} from './user-command-rules'

export type { UserCommandRuleRecord, UserCommandRulePathMode } from './user-command-rules'

export { maxRisk, maxRiskAll } from './risk-level'

export { resolveFailClosedLevel, resolveOutsideWritesUpgrade, resolveExtraFreeDirs, resolveSubAgentBlockDangerous, resolveRelaxedConfirmModerate } from './fail-closed-policy'
export type { FailClosedKind } from './fail-closed-policy'

import i18n from '../../i18n'

const SKIP_REASON_KEYS: Record<string, string> = {
  circuit_open: 'watch.skipReasonCircuitOpen',
  invalid_ai_profile: 'watch.skipReasonInvalidProfile',
  already_running: 'watch.skipReasonAlreadyRunning',
  stopped: 'watch.skipReasonStopped',
}

/** 关切跳过原因在界面上的说法。不认识的原因原样显示。 */
export function watchSkipReasonText(reason: string): string {
  const key = SKIP_REASON_KEYS[reason]
  return key ? i18n.global.t(key) : reason
}

export function resolveCliDataMode(flags: {
  explicitDir?: string
  sandboxFlag?: boolean
  shareDesktopFlag?: boolean
  defaultSandbox?: boolean
}): { mode: 'sandbox' | 'shared'; explicitDir?: string }

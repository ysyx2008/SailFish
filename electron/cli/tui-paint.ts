/**
 * 在真实终端里画一帧就退出。给测试看这一屏能不能画出来。
 */
import { ENTER_SCREEN, LEAVE_SCREEN, renderFrame } from './tui-screen'

process.stdout.write(process.stdout.isTTY ? 'TTY\n' : 'NOTTY\n')
process.stdout.write(ENTER_SCREEN)
process.stdout.write(renderFrame({
  columns: process.stdout.columns || 80,
  rows: process.stdout.rows || 24,
  title: 'SailFish  /work',
  body: '有，项目名是 SailFish。',
  status: '',
  prompt: '› ',
  input: '你好',
  cursor: 2,
  scroll: 0,
}))
process.stdout.write(LEAVE_SCREEN)
process.stdout.write('\n__PAINTED__\n')

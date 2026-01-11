/**
 * progress-detector.ts 单元测试
 * 测试进度检测器的各种进度格式识别能力
 */
import { describe, it, expect } from 'vitest'
import {
  detectCommandType,
  detectProgress,
  hasProgressChanged,
  formatProgressText,
  type CommandProgress
} from '../progress-detector'

// ==================== detectCommandType ====================

describe('detectCommandType', () => {
  describe('build commands', () => {
    it.each([
      ['npm run build', 'build'],
      ['yarn build', 'build'],
      ['pnpm build', 'build'],
      ['vite build', 'build'],
      ['next build', 'build'],
      ['webpack', 'build'],
    ])('should detect "%s" as build', (cmd, expected) => {
      expect(detectCommandType(cmd)).toBe(expected)
    })
  })

  describe('download commands', () => {
    it.each([
      ['wget http://example.com/file.zip -o output', 'download'],
      ['curl http://example.com/file -O file.zip', 'download'],
    ])('should detect "%s" as download', (cmd, expected) => {
      expect(detectCommandType(cmd)).toBe(expected)
    })
  })

  describe('install commands', () => {
    it.each([
      ['npm install express', 'install'],
      ['yarn install', 'install'],
      ['pnpm install lodash', 'install'],
      ['pip install flask', 'install'],
      ['pip3 install django', 'install'],
      ['apt install nginx', 'install'],
      ['apt-get install curl', 'install'],
      ['yum install httpd', 'install'],
      ['dnf install package', 'install'],
      ['brew install node', 'install'],
      ['cargo install ripgrep', 'install'],
    ])('should detect "%s" as install', (cmd, expected) => {
      expect(detectCommandType(cmd)).toBe(expected)
    })
  })

  describe('test commands', () => {
    it.each([
      ['npm test', 'test'],
      ['npm run test', 'test'],
      ['yarn test', 'test'],
      ['pnpm test', 'test'],
      ['jest', 'test'],
      ['mocha', 'test'],
      ['pytest', 'test'],
      ['go test', 'test'],
      ['cargo test', 'test'],
    ])('should detect "%s" as test', (cmd, expected) => {
      expect(detectCommandType(cmd)).toBe(expected)
    })
  })

  describe('compile commands', () => {
    it.each([
      ['gcc main.c', 'compile'],
      ['clang main.c', 'compile'],
      ['make', 'compile'],
      ['cmake ..', 'compile'],
      ['cargo build', 'compile'],
      ['go build', 'compile'],
      ['javac Main.java', 'compile'],
      ['tsc', 'compile'],
      ['swc src', 'compile'],
    ])('should detect "%s" as compile', (cmd, expected) => {
      expect(detectCommandType(cmd)).toBe(expected)
    })
  })

  describe('deploy commands', () => {
    it.each([
      ['deploy', 'deploy'],
      ['kubectl apply -f config.yaml', 'deploy'],
      ['docker push image', 'deploy'],
      ['helm install release', 'deploy'],
      ['ansible-playbook deploy.yml', 'deploy'],
    ])('should detect "%s" as deploy', (cmd, expected) => {
      expect(detectCommandType(cmd)).toBe(expected)
    })
  })

  describe('generic commands', () => {
    it.each([
      ['ls -la', 'generic'],
      ['cat file.txt', 'generic'],
      ['grep pattern file', 'generic'],
      ['echo hello', 'generic'],
    ])('should detect "%s" as generic', (cmd, expected) => {
      expect(detectCommandType(cmd)).toBe(expected)
    })
  })
})

// ==================== detectProgress ====================

describe('detectProgress', () => {
  describe('percentage progress', () => {
    it('should detect simple percentage', () => {
      const result = detectProgress('Downloading... 50%')
      expect(result.progress).not.toBeNull()
      expect(result.progress!.type).toBe('percentage')
      expect(result.progress!.value).toBe(50)
    })

    it('should detect percentage with brackets', () => {
      const result = detectProgress('[75%] Complete')
      expect(result.progress!.value).toBe(75)
    })

    it('should detect percentage with parentheses', () => {
      const result = detectProgress('Progress (80%)')
      expect(result.progress!.value).toBe(80)
    })

    it('should detect decimal percentage', () => {
      const result = detectProgress('Progress: 50.5%')
      expect(result.progress!.value).toBe(50.5)
    })

    it('should detect percentage with space before %', () => {
      const result = detectProgress('Progress: 75 %')
      expect(result.progress!.value).toBe(75)
    })

    it('should ignore invalid percentages', () => {
      const result = detectProgress('Progress: 150%')
      expect(result.progress).toBeNull()
    })
  })

  describe('fraction progress', () => {
    it('should detect simple fraction', () => {
      const result = detectProgress('Processing 5/10 files')
      expect(result.progress).not.toBeNull()
      expect(result.progress!.type).toBe('fraction')
      expect(result.progress!.current).toBe(5)
      expect(result.progress!.total).toBe(10)
      expect(result.progress!.value).toBe(50)
    })

    it('should detect "X of Y" format', () => {
      const result = detectProgress('Step 3 of 5')
      expect(result.progress!.current).toBe(3)
      expect(result.progress!.total).toBe(5)
    })

    it('should detect bracketed fraction', () => {
      const result = detectProgress('[5/10] Building modules')
      expect(result.progress!.value).toBe(50)
    })
  })

  describe('compile progress', () => {
    it('should detect compile progress', () => {
      const result = detectProgress('Compiling 5/10 modules')
      expect(result.progress!.current).toBe(5)
      expect(result.progress!.total).toBe(10)
    })

    it('should detect building progress', () => {
      const result = detectProgress('Building module 8/20')
      expect(result.progress!.current).toBe(8)
      expect(result.progress!.total).toBe(20)
    })
  })

  describe('specific tool progress', () => {
    it('should detect Docker build progress', () => {
      const result = detectProgress('Step 5/10 : RUN npm install')
      expect(result.progress!.current).toBe(5)
      expect(result.progress!.total).toBe(10)
    })

    it('should detect Cargo progress', () => {
      const result = detectProgress('Compiling serde v1.0.0 (5/10)')
      expect(result.progress!.current).toBe(5)
    })

    it('should detect Maven progress', () => {
      const result = detectProgress('[INFO] Building my-project [3/5]')
      expect(result.progress!.current).toBe(3)
      expect(result.progress!.total).toBe(5)
    })

    it('should detect Gradle progress', () => {
      const result = detectProgress('> Task :compile (5 of 10)')
      expect(result.progress!.current).toBe(5)
    })
  })

  describe('npm progress bar', () => {
    it('should detect npm progress bar', () => {
      const result = detectProgress('[#######-------] 50%')
      expect(result.progress!.value).toBe(50)
    })

    it('should detect npm progress with equals', () => {
      const result = detectProgress('[======----] 60%')
      expect(result.progress!.value).toBe(60)
    })
  })

  describe('download progress', () => {
    it('should detect download progress', () => {
      const result = detectProgress('Downloading package... 75%')
      expect(result.progress!.value).toBe(75)
    })

    it('should detect Chinese download progress', () => {
      const result = detectProgress('正在下载 80%')
      expect(result.progress!.value).toBe(80)
    })

    it('should detect fetching progress', () => {
      const result = detectProgress('Fetching resources 60%')
      expect(result.progress!.value).toBe(60)
    })
  })

  describe('test progress', () => {
    it('should detect test progress', () => {
      const result = detectProgress('Tests: 8 passed, 2 failed, 10 total')
      expect(result.progress!.current).toBe(8)
      expect(result.progress!.total).toBe(10)
      expect(result.progress!.value).toBe(80)
    })

    it('should detect test progress with checkmark', () => {
      const result = detectProgress('Tests: 5 ✓, 0 failed, 5 total')
      expect(result.progress!.current).toBe(5)
    })
  })

  describe('ETA and speed extraction', () => {
    it('should extract ETA', () => {
      const output = 'Downloading... 50%\nETA: 5m'
      const result = detectProgress(output)
      expect(result.progress!.eta).toBe('5m')
    })

    it('should extract speed', () => {
      const output = 'Downloading... 50%\nSpeed: 5.2 MB/s'
      const result = detectProgress(output)
      expect(result.progress!.speed).toBe('5.2 MB/s')
    })

    it('should extract remaining time', () => {
      const output = 'Progress: 50%\nremaining 30s'
      const result = detectProgress(output)
      expect(result.progress!.eta).toBe('30s')
    })
  })

  describe('indeterminate progress (spinners)', () => {
    it('should detect spinner characters', () => {
      const result = detectProgress('⠋ Installing packages...')
      expect(result.isIndeterminate).toBe(true)
    })

    it('should extract status from spinner line', () => {
      const output = '⠹ Compiling TypeScript\n⠸ Still working...'
      const result = detectProgress(output)
      expect(result.isIndeterminate).toBe(true)
      expect(result.statusText).toBeDefined()
    })
  })

  describe('command type detection', () => {
    it('should detect command type', () => {
      const result = detectProgress('Installing...', 'npm install')
      expect(result.commandType).toBe('install')
    })

    it('should default to generic', () => {
      const result = detectProgress('Some output')
      expect(result.commandType).toBe('generic')
    })
  })

  describe('no progress', () => {
    it('should return null progress for plain output', () => {
      const result = detectProgress('Just some regular output\nwith multiple lines')
      expect(result.progress).toBeNull()
      expect(result.isIndeterminate).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('should only analyze last 30 lines', () => {
      const lines = Array(50).fill('no progress here').join('\n') + '\nProgress: 50%'
      const result = detectProgress(lines)
      expect(result.progress!.value).toBe(50)
    })

    it('should prefer most recent progress', () => {
      const output = 'Progress: 20%\nProgress: 50%\nProgress: 80%'
      const result = detectProgress(output)
      expect(result.progress!.value).toBe(80)
    })
  })
})

// ==================== hasProgressChanged ====================

describe('hasProgressChanged', () => {
  it('should return true for null old progress', () => {
    const newProgress: CommandProgress = {
      commandType: 'generic',
      progress: { type: 'percentage', value: 50 },
      isIndeterminate: false,
      lastUpdate: Date.now()
    }
    expect(hasProgressChanged(null, newProgress)).toBe(true)
  })

  it('should return true when progress appears', () => {
    const oldProgress: CommandProgress = {
      commandType: 'generic',
      progress: null,
      isIndeterminate: false,
      lastUpdate: Date.now()
    }
    const newProgress: CommandProgress = {
      commandType: 'generic',
      progress: { type: 'percentage', value: 50 },
      isIndeterminate: false,
      lastUpdate: Date.now()
    }
    expect(hasProgressChanged(oldProgress, newProgress)).toBe(true)
  })

  it('should return true when progress disappears', () => {
    const oldProgress: CommandProgress = {
      commandType: 'generic',
      progress: { type: 'percentage', value: 50 },
      isIndeterminate: false,
      lastUpdate: Date.now()
    }
    const newProgress: CommandProgress = {
      commandType: 'generic',
      progress: null,
      isIndeterminate: false,
      lastUpdate: Date.now()
    }
    expect(hasProgressChanged(oldProgress, newProgress)).toBe(true)
  })

  it('should return true when indeterminate changes', () => {
    const oldProgress: CommandProgress = {
      commandType: 'generic',
      progress: null,
      isIndeterminate: false,
      lastUpdate: Date.now()
    }
    const newProgress: CommandProgress = {
      commandType: 'generic',
      progress: null,
      isIndeterminate: true,
      lastUpdate: Date.now()
    }
    expect(hasProgressChanged(oldProgress, newProgress)).toBe(true)
  })

  it('should return true when progress value changes >= 1%', () => {
    const oldProgress: CommandProgress = {
      commandType: 'generic',
      progress: { type: 'percentage', value: 50 },
      isIndeterminate: false,
      lastUpdate: Date.now()
    }
    const newProgress: CommandProgress = {
      commandType: 'generic',
      progress: { type: 'percentage', value: 52 },
      isIndeterminate: false,
      lastUpdate: Date.now()
    }
    expect(hasProgressChanged(oldProgress, newProgress)).toBe(true)
  })

  it('should return false when progress value changes < 1%', () => {
    const oldProgress: CommandProgress = {
      commandType: 'generic',
      progress: { type: 'percentage', value: 50 },
      isIndeterminate: false,
      lastUpdate: Date.now()
    }
    const newProgress: CommandProgress = {
      commandType: 'generic',
      progress: { type: 'percentage', value: 50.5 },
      isIndeterminate: false,
      lastUpdate: Date.now()
    }
    expect(hasProgressChanged(oldProgress, newProgress)).toBe(false)
  })

  it('should return true when ETA changes', () => {
    const oldProgress: CommandProgress = {
      commandType: 'generic',
      progress: { type: 'percentage', value: 50, eta: '5m' },
      isIndeterminate: false,
      lastUpdate: Date.now()
    }
    const newProgress: CommandProgress = {
      commandType: 'generic',
      progress: { type: 'percentage', value: 50, eta: '4m' },
      isIndeterminate: false,
      lastUpdate: Date.now()
    }
    expect(hasProgressChanged(oldProgress, newProgress)).toBe(true)
  })
})

// ==================== formatProgressText ====================

describe('formatProgressText', () => {
  it('should format indeterminate progress', () => {
    const progress: CommandProgress = {
      commandType: 'generic',
      progress: null,
      isIndeterminate: true,
      lastUpdate: Date.now(),
      statusText: '正在处理'
    }
    const text = formatProgressText(progress)
    expect(text).toBe('正在处理')
  })

  it('should format indeterminate without status', () => {
    const progress: CommandProgress = {
      commandType: 'generic',
      progress: null,
      isIndeterminate: true,
      lastUpdate: Date.now()
    }
    const text = formatProgressText(progress)
    expect(text).toBe('执行中...')
  })

  it('should return empty for no progress', () => {
    const progress: CommandProgress = {
      commandType: 'generic',
      progress: null,
      isIndeterminate: false,
      lastUpdate: Date.now()
    }
    const text = formatProgressText(progress)
    expect(text).toBe('')
  })

  it('should format percentage progress', () => {
    const progress: CommandProgress = {
      commandType: 'generic',
      progress: { type: 'percentage', value: 75 },
      isIndeterminate: false,
      lastUpdate: Date.now()
    }
    const text = formatProgressText(progress)
    expect(text).toBe('75%')
  })

  it('should format fraction progress', () => {
    const progress: CommandProgress = {
      commandType: 'generic',
      progress: { type: 'fraction', value: 50, current: 5, total: 10 },
      isIndeterminate: false,
      lastUpdate: Date.now()
    }
    const text = formatProgressText(progress)
    expect(text).toContain('5/10')
    expect(text).toContain('50%')
  })

  it('should include ETA', () => {
    const progress: CommandProgress = {
      commandType: 'generic',
      progress: { type: 'percentage', value: 50, eta: '5m' },
      isIndeterminate: false,
      lastUpdate: Date.now()
    }
    const text = formatProgressText(progress)
    expect(text).toContain('ETA: 5m')
  })

  it('should include speed', () => {
    const progress: CommandProgress = {
      commandType: 'generic',
      progress: { type: 'percentage', value: 50, speed: '10 MB/s' },
      isIndeterminate: false,
      lastUpdate: Date.now()
    }
    const text = formatProgressText(progress)
    expect(text).toContain('10 MB/s')
  })

  it('should include status text', () => {
    const progress: CommandProgress = {
      commandType: 'generic',
      progress: { type: 'percentage', value: 50 },
      isIndeterminate: false,
      lastUpdate: Date.now(),
      statusText: 'Installing dependencies'
    }
    const text = formatProgressText(progress)
    expect(text).toContain('Installing dependencies')
  })

  it('should format complete progress info', () => {
    const progress: CommandProgress = {
      commandType: 'download',
      progress: {
        type: 'fraction',
        value: 75,
        current: 75,
        total: 100,
        eta: '2m',
        speed: '5 MB/s'
      },
      isIndeterminate: false,
      lastUpdate: Date.now(),
      statusText: 'Downloading'
    }
    const text = formatProgressText(progress)
    expect(text).toContain('75/100')
    expect(text).toContain('75%')
    expect(text).toContain('ETA: 2m')
    expect(text).toContain('5 MB/s')
    expect(text).toContain('Downloading')
  })
})

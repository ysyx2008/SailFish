import { generateKeyPairSync } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Client, Server } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseHostKeyChanged } from '@shared/utils/ssh-host-key-message'
import { getSshErrorMessage } from '../ssh-error'
import {
  SSH_HOST_KEY_DENIED,
  SshHostKeyStore,
  fingerprintHostKey,
  hostKeyFailureError,
  makeHostVerifier,
} from '../ssh-host-key'

vi.mock('electron', () => ({
  app: {
    getPath: () => os.tmpdir(),
    getName: () => 'SailFish',
    getVersion: () => '0',
  },
}))

function rsaPem(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
}

function listen(hostKey: string, port = 0): Promise<{ server: Server; port: number }> {
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => {})
    client.on('authentication', (ctx) => ctx.accept())
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('shell', (acceptShell) => {
          acceptShell().end()
        })
      })
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('no port'))
        return
      }
      resolve({ server, port: address.port })
    })
  })
}

function connectOnce(port: number, store: SshHostKeyStore): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.on('ready', () => {
      client.end()
      resolve()
    })
    client.on('error', (err) => {
      client.end()
      reject(err)
    })
    client.connect({
      host: '127.0.0.1',
      port,
      username: 'u',
      password: 'x',
      readyTimeout: 4000,
      hostVerifier: makeHostVerifier('127.0.0.1', port, store),
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

describe('SshHostKeyStore', () => {
  let dir: string
  let file: string
  let store: SshHostKeyStore

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function setup(): void {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-host-key-'))
    file = path.join(dir, 'ssh-host-keys.json')
    store = new SshHostKeyStore(file)
  }

  it('第一次记下，同一把再来通过，换一把拒绝且不改已记下的', () => {
    setup()
    const first = Buffer.from('host-key-a')
    const second = Buffer.from('host-key-b')
    expect(store.check('Example.COM', 22, first)).toBe(true)
    expect(fs.existsSync(file)).toBe(true)
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    }
    const saved = fs.readFileSync(file, 'utf8')
    expect(saved).toContain(fingerprintHostKey(first))

    expect(store.check('example.com', 22, first)).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(saved)

    expect(store.check('example.com', 22, second)).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe(saved)
    expect(store.denial('example.com', 22)?.kind).toBe('changed')

    expect(store.acceptChanged('example.com', 22)).toBe(true)
    expect(store.check('example.com', 22, second)).toBe(true)
    expect(store.acceptChanged('example.com', 22)).toBe(false)
    expect(store.check('example.com', 22, first)).toBe(false)
  })

  it('另一端口互不影响；记不下来的文件保持原样', () => {
    setup()
    expect(store.check('host.example', 22, Buffer.from('a'))).toBe(true)
    expect(store.check('[::1]', 22, Buffer.from('v6'))).toBe(true)
    expect(store.check('::1', 22, Buffer.from('v6'))).toBe(true)
    expect(store.check('host.example', 2222, Buffer.from('b'))).toBe(true)
    const saved = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, 'not-json', { mode: 0o600 })
    expect(store.check('host.example', 22, Buffer.from('a'))).toBe(false)
    expect(store.denial('host.example', 22)?.kind).toBe('unrecorded')
    expect(fs.readFileSync(file, 'utf8')).toBe('not-json')
    expect(saved).toContain('"port":22')
    expect(saved).toContain('"port":2222')
  })

  it('拒绝时的说明能被界面认出来，传文件库加的前缀也认', () => {
    setup()
    store.check('db.example', 22, Buffer.from('old'))
    store.check('db.example', 22, Buffer.from('new'))
    const failure = hostKeyFailureError(
      new Error(`getConnection: ${SSH_HOST_KEY_DENIED}`),
      'DB.Example',
      22,
      store,
    )
    expect(failure).not.toBeNull()
    const parsed = parseHostKeyChanged(failure!.message)
    expect(parsed).toMatchObject({ host: 'db.example', port: 22 })
    expect(parsed?.detail).toContain(fingerprintHostKey(Buffer.from('old')))
    expect(parsed?.detail).toContain(fingerprintHostKey(Buffer.from('new')))
    expect(getSshErrorMessage(failure!)).toBe(failure!.message)

    store.check('broken.example', 22, Buffer.from('x'))
    fs.writeFileSync(file, '{', { mode: 0o600 })
    store.check('broken.example', 22, Buffer.from('y'))
    const unrecorded = hostKeyFailureError(new Error(SSH_HOST_KEY_DENIED), 'broken.example', 22, store)
    expect(unrecorded?.message.startsWith('SSH_HOST_KEY_CHANGED')).toBe(false)
    expect(unrecorded?.message).toContain('broken.example:22')
  })
})

describe('ssh2 握手', () => {
  const servers: Server[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(closeServer))
  })

  it('第一次连上记下，同一身份再连通过，换一把钥匙被拒绝，确认后记住新的', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-host-key-live-'))
    const store = new SshHostKeyStore(path.join(dir, 'ssh-host-keys.json'))
    const firstKey = rsaPem()
    const secondKey = rsaPem()
    try {
      const started = await listen(firstKey)
      servers.push(started.server)
      await connectOnce(started.port, store)
      const remembered = fs.readFileSync(path.join(dir, 'ssh-host-keys.json'), 'utf8')
      await connectOnce(started.port, store)
      expect(fs.readFileSync(path.join(dir, 'ssh-host-keys.json'), 'utf8')).toBe(remembered)

      await closeServer(started.server)
      servers.pop()
      const replaced = await listen(secondKey, started.port)
      servers.push(replaced.server)
      await expect(connectOnce(replaced.port, store)).rejects.toThrow(SSH_HOST_KEY_DENIED)
      expect(fs.readFileSync(path.join(dir, 'ssh-host-keys.json'), 'utf8')).toBe(remembered)

      expect(store.acceptChanged('127.0.0.1', replaced.port)).toBe(true)
      await connectOnce(replaced.port, store)
      expect(fs.readFileSync(path.join(dir, 'ssh-host-keys.json'), 'utf8')).not.toBe(remembered)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 20000)
})

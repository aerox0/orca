import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost, type TerminalHostOptions } from './terminal-host'
import { TerminalSpawnGate } from './terminal-spawn-gate'

type SpawnSubprocess = TerminalHostOptions['spawnSubprocess']

function stream() {
  return { onData: vi.fn(), onExit: vi.fn() }
}

describe('TerminalSpawnGate (observe-only)', () => {
  let host: TerminalHost
  let gate: TerminalSpawnGate
  let log: Mock<(event: string, details: Record<string, unknown>) => void>
  let exits: Map<number, (code: number) => void>
  let spawnSubprocess: Mock<SpawnSubprocess>
  let nextPid: number
  let now: number

  beforeEach(() => {
    exits = new Map()
    nextPid = 1000
    now = 0
    log = vi.fn()
    gate = new TerminalSpawnGate({ log, now: () => now })
    spawnSubprocess = vi.fn<SpawnSubprocess>(() => {
      const pid = nextPid++
      const handle: SubprocessHandle = {
        pid,
        getForegroundProcess: vi.fn(() => null),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(() => exits.get(pid)?.(0)),
        terminateOwnedTree: () => 'unavailable' as const,
        forceKill: vi.fn(() => exits.get(pid)?.(137)),
        signal: vi.fn(),
        onData: vi.fn(),
        onExit: (callback) => {
          exits.set(pid, callback)
        },
        dispose: vi.fn()
      }
      return handle
    })
    host = new TerminalHost({ spawnSubprocess, spawnGate: gate })
  })

  afterEach(async () => {
    await host.dispose()
  })

  function restore(sessionId: string) {
    return host.createOrAttach({
      sessionId,
      cols: 80,
      rows: 24,
      historySeedChunks: ['seed'],
      agentSessionEnsure: {
        claim: {
          digestVersion: 1 as const,
          keyId: 'key',
          identityDigest: sessionId.padEnd(43, 'a'),
          worktreeScopeDigest: 'b'.repeat(43),
          agent: 'codex' as const
        },
        surface: {
          worktreeId: 'worktree',
          tabId: `tab-${sessionId}`,
          leafId: '11111111-1111-4111-8111-111111111111',
          terminalHandle: `term_${sessionId}`
        }
      },
      spawnAdmission: { clientId: 'client-a', declaredIntent: null, deadlineAt: Infinity },
      streamClient: stream()
    })
  }

  it('admits every automatic restore while counting the ones the policy would pace', async () => {
    for (let i = 0; i < 5; i++) {
      await restore(`restore-${i}`)
    }

    expect(spawnSubprocess).toHaveBeenCalledTimes(5)
    expect(gate.snapshot()).toMatchObject({ liveAutomatic: 5, wouldWait: 2, wouldDefer: 0 })
    expect(log).toHaveBeenCalledWith(
      'spawn-admission-observed',
      expect.objectContaining({ decision: 'wait', charge: 'automatic' })
    )
  })

  it('never charges an attach and frees the live slot when the session exits', async () => {
    await restore('restore-a')
    await host.createOrAttach({
      sessionId: 'restore-a',
      cols: 80,
      rows: 24,
      attachOnly: true,
      streamClient: stream()
    })
    expect(spawnSubprocess).toHaveBeenCalledOnce()
    expect(gate.snapshot().liveAutomatic).toBe(1)

    exits.get(1000)?.(0)
    expect(gate.snapshot().liveAutomatic).toBe(0)
  })

  it('does not count a plain shell, and releases the in-flight slot when the fork throws', async () => {
    await host.createOrAttach({ sessionId: 'shell', cols: 80, rows: 24, streamClient: stream() })
    expect(gate.snapshot()).toMatchObject({ liveAutomatic: 0, inFlight: { interactive: 0 } })
    expect(log).not.toHaveBeenCalled()

    spawnSubprocess.mockImplementationOnce(() => {
      throw new Error('spawn failed')
    })
    await expect(restore('restore-fails')).rejects.toThrow('spawn failed')
    expect(gate.snapshot()).toMatchObject({ liveAutomatic: 0, inFlight: { automatic: 0 } })
  })
})

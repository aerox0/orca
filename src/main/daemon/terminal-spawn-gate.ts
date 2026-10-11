import {
  applySpawnAdmission,
  createSpawnAdmissionState,
  decideSpawnAdmission,
  DEFAULT_SPAWN_ADMISSION_LIMITS,
  pruneUserResumeBuckets,
  releaseLiveAutomatic,
  resolveSpawnCharge,
  settleSpawnAdmission,
  type AutomaticWorkMode,
  type HostPressureLevel,
  type SpawnAdmissionDecision,
  type SpawnAdmissionLimits,
  type SpawnAdmissionState,
  type SpawnCharge,
  type SpawnRequestFacts
} from '../../shared/host-spawn-admission'

export type TerminalSpawnLease = {
  readonly charge: SpawnCharge
  /** The fork published a session; only a live automatic one holds a live-cap slot. */
  commit(sessionId: string, isAlive: boolean): void
  /** The fork never published a session. */
  abandon(): void
}

export type TerminalSpawnGateSnapshot = {
  mode: 'observe'
  inFlight: Record<SpawnCharge, number>
  liveAutomatic: number
  wouldWait: number
  wouldDefer: number
  wouldRefuse: number
}

type TerminalSpawnGateOptions = {
  log: (event: string, details: Record<string, unknown>) => void
  limits?: SpawnAdmissionLimits
  now?: () => number
  pressure?: () => HostPressureLevel
  automaticWorkMode?: () => AutomaticWorkMode
}

/**
 * The daemon's single fork gate. Observe-only for now: every request is admitted
 * immediately and the decision the policy would have made is counted and logged,
 * so the budget defaults can be tuned from real numbers before anything waits.
 */
export class TerminalSpawnGate {
  private readonly limits: SpawnAdmissionLimits
  private readonly now: () => number
  private readonly pressure: () => HostPressureLevel
  private readonly automaticWorkMode: () => AutomaticWorkMode
  private readonly state: SpawnAdmissionState
  private readonly liveAutomaticSessions = new Set<string>()
  private wouldWait = 0
  private wouldDefer = 0
  private wouldRefuse = 0

  constructor(private readonly options: TerminalSpawnGateOptions) {
    this.limits = options.limits ?? DEFAULT_SPAWN_ADMISSION_LIMITS
    this.now = options.now ?? Date.now
    this.pressure = options.pressure ?? (() => 'unknown')
    this.automaticWorkMode = options.automaticWorkMode ?? (() => ({ kind: 'normal' }))
    this.state = createSpawnAdmissionState(this.limits, this.now())
  }

  admit(facts: SpawnRequestFacts): TerminalSpawnLease {
    const now = this.now()
    pruneUserResumeBuckets(this.state, this.limits, now)
    const charge = resolveSpawnCharge(this.state, facts, this.limits, now)
    const decision = decideSpawnAdmission({
      state: this.state,
      facts,
      charge,
      pressure: this.pressure(),
      mode: this.automaticWorkMode(),
      limits: this.limits,
      now
    })
    this.recordObservation(decision, charge, facts)
    applySpawnAdmission(this.state, facts, charge, this.limits, now)
    let settled = false
    return {
      charge,
      commit: (sessionId, isAlive) => {
        if (settled) {
          return
        }
        settled = true
        const becameLive = charge === 'automatic' && isAlive
        settleSpawnAdmission(this.state, charge, becameLive)
        if (becameLive) {
          this.liveAutomaticSessions.add(sessionId)
        }
      },
      abandon: () => {
        if (settled) {
          return
        }
        settled = true
        settleSpawnAdmission(this.state, charge, false)
      }
    }
  }

  onSessionExit(sessionId: string): void {
    if (this.liveAutomaticSessions.delete(sessionId)) {
      releaseLiveAutomatic(this.state)
    }
  }

  snapshot(): TerminalSpawnGateSnapshot {
    return {
      mode: 'observe',
      inFlight: { ...this.state.inFlight },
      liveAutomatic: this.state.liveAutomatic,
      wouldWait: this.wouldWait,
      wouldDefer: this.wouldDefer,
      wouldRefuse: this.wouldRefuse
    }
  }

  private recordObservation(
    decision: SpawnAdmissionDecision,
    charge: SpawnCharge,
    facts: SpawnRequestFacts
  ): void {
    if (decision.kind === 'admit' && charge === 'interactive') {
      return
    }
    if (decision.kind === 'wait') {
      this.wouldWait += 1
    } else if (decision.kind === 'defer') {
      this.wouldDefer += 1
    } else if (decision.kind === 'refuse_retryable') {
      this.wouldRefuse += 1
    }
    try {
      this.options.log('spawn-admission-observed', {
        decision: decision.kind,
        ...(decision.kind === 'defer' ? { reason: decision.reason } : {}),
        charge,
        declaredIntent: facts.declaredIntent,
        inFlightAutomatic: this.state.inFlight.automatic,
        liveAutomatic: this.state.liveAutomatic
      })
    } catch {
      // Diagnostics must never turn an admitted fork into a failed create.
    }
  }
}

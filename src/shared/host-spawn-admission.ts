// Pure, clock-injected admission policy for PTY forks on an execution host.
// The creation owner (the terminal daemon) calls it only on the branch that is
// about to fork, so attach and adoption are never charged.

export type SpawnIntent = 'interactive' | 'user-resume' | 'automatic-restore' | 'automation'

export type SpawnCharge = 'interactive' | 'user' | 'automatic'

export type HostPressureLevel = 'ok' | 'elevated' | 'critical' | 'unknown'

export type AutomaticWorkMode =
  | { kind: 'normal' }
  | {
      kind: 'paused'
      reason: 'unclean_host_death' | 'pressure' | 'operator'
      since: number
    }

export type SpawnRequestFacts = {
  clientId: string
  /** Null when the caller predates the field; presence opts the request into `defer`. */
  declaredIntent: SpawnIntent | null
  hasAgentSessionClaim: boolean
  hasHistorySeed: boolean
  /** Latest time a paced request may still be admitted, on the gate's clock. */
  deadlineAt: number
}

export type SpawnAdmissionDecision =
  | { kind: 'admit'; charge: SpawnCharge }
  /** `retryAt` null means "until a slot is released". */
  | { kind: 'wait'; charge: SpawnCharge; retryAt: number | null }
  | { kind: 'defer'; reason: 'paused' | 'live_cap' | 'pressure' | 'deadline' }
  | { kind: 'refuse_retryable' }

export type SpawnAdmissionLimits = {
  automaticConcurrency: number
  automaticTokensPerSecond: number
  automaticBurst: number
  maxLiveAutomatic: number
  userResumeConcurrency: number
  userResumeBucketCapacity: number
  userResumeBucketWindowMs: number
}

// Initial defaults; tune from the observe-only counts.
export const DEFAULT_SPAWN_ADMISSION_LIMITS: SpawnAdmissionLimits = {
  automaticConcurrency: 3,
  automaticTokensPerSecond: 1,
  automaticBurst: 3,
  maxLiveAutomatic: 8,
  userResumeConcurrency: 3,
  userResumeBucketCapacity: 4,
  userResumeBucketWindowMs: 10_000
}

type TokenBucket = { tokens: number; updatedAt: number }

export type SpawnAdmissionState = {
  inFlight: Record<SpawnCharge, number>
  liveAutomatic: number
  automaticBucket: TokenBucket
  userResumeBuckets: Map<string, TokenBucket>
}

export function createSpawnAdmissionState(
  limits: SpawnAdmissionLimits,
  now: number
): SpawnAdmissionState {
  return {
    inFlight: { interactive: 0, user: 0, automatic: 0 },
    liveAutomatic: 0,
    automaticBucket: { tokens: limits.automaticBurst, updatedAt: now },
    userResumeBuckets: new Map()
  }
}

function refill(
  bucket: TokenBucket,
  capacity: number,
  tokensPerMs: number,
  now: number
): TokenBucket {
  const elapsed = Math.max(0, now - bucket.updatedAt)
  return { tokens: Math.min(capacity, bucket.tokens + elapsed * tokensPerMs), updatedAt: now }
}

function automaticTokensPerMs(limits: SpawnAdmissionLimits): number {
  return limits.automaticTokensPerSecond / 1000
}

function userResumeTokensPerMs(limits: SpawnAdmissionLimits): number {
  return limits.userResumeBucketCapacity / limits.userResumeBucketWindowMs
}

/** Old callers get inference from facts the host holds; a declared `user-resume`
 *  above its per-client bucket is charged as automatic so it cannot bypass pacing. */
export function resolveSpawnCharge(
  state: SpawnAdmissionState,
  facts: SpawnRequestFacts,
  limits: SpawnAdmissionLimits,
  now: number
): SpawnCharge {
  const intent =
    facts.declaredIntent ??
    (facts.hasAgentSessionClaim && facts.hasHistorySeed ? 'automatic-restore' : 'interactive')
  if (intent === 'interactive') {
    return 'interactive'
  }
  if (intent === 'user-resume') {
    const bucket = refill(
      state.userResumeBuckets.get(facts.clientId) ?? {
        tokens: limits.userResumeBucketCapacity,
        updatedAt: now
      },
      limits.userResumeBucketCapacity,
      userResumeTokensPerMs(limits),
      now
    )
    return bucket.tokens >= 1 ? 'user' : 'automatic'
  }
  return 'automatic'
}

export function decideSpawnAdmission(args: {
  state: SpawnAdmissionState
  facts: SpawnRequestFacts
  charge: SpawnCharge
  pressure: HostPressureLevel
  mode: AutomaticWorkMode
  limits: SpawnAdmissionLimits
  now: number
}): SpawnAdmissionDecision {
  const { state, facts, charge, pressure, mode, limits, now } = args
  if (charge === 'interactive') {
    return { kind: 'admit', charge }
  }
  if (charge === 'user') {
    return state.inFlight.user < limits.userResumeConcurrency
      ? { kind: 'admit', charge }
      : { kind: 'wait', charge, retryAt: null }
  }
  const negotiated = facts.declaredIntent !== null
  if (pressure === 'critical') {
    // Why: an old caller clears its resume handle before spawning, so only critical
    // pressure may refuse it, with the error it already treats as "reconnect".
    return negotiated ? { kind: 'defer', reason: 'pressure' } : { kind: 'refuse_retryable' }
  }
  if (negotiated && mode.kind === 'paused') {
    return { kind: 'defer', reason: 'paused' }
  }
  if (negotiated && state.liveAutomatic + state.inFlight.automatic >= limits.maxLiveAutomatic) {
    return { kind: 'defer', reason: 'live_cap' }
  }
  const bucket = refill(
    state.automaticBucket,
    limits.automaticBurst,
    automaticTokensPerMs(limits),
    now
  )
  const concurrencyFull = state.inFlight.automatic >= limits.automaticConcurrency
  if (!concurrencyFull && bucket.tokens >= 1) {
    return { kind: 'admit', charge }
  }
  const retryAt = concurrencyFull
    ? null
    : now + Math.ceil((1 - bucket.tokens) / automaticTokensPerMs(limits))
  if (retryAt !== null ? retryAt > facts.deadlineAt : now >= facts.deadlineAt) {
    // Why: an old caller is admitted at its deadline rather than refused (degraded pacing).
    return negotiated ? { kind: 'defer', reason: 'deadline' } : { kind: 'admit', charge }
  }
  return { kind: 'wait', charge, retryAt }
}

/** Applies an admit's accounting. Buckets may not go below zero, so an observe-only
 *  gate that admits everything still reports realistic would-wait counts. */
export function applySpawnAdmission(
  state: SpawnAdmissionState,
  facts: SpawnRequestFacts,
  charge: SpawnCharge,
  limits: SpawnAdmissionLimits,
  now: number
): void {
  state.inFlight[charge] += 1
  if (charge === 'automatic') {
    const bucket = refill(
      state.automaticBucket,
      limits.automaticBurst,
      automaticTokensPerMs(limits),
      now
    )
    state.automaticBucket = { tokens: Math.max(0, bucket.tokens - 1), updatedAt: now }
  } else if (charge === 'user') {
    const bucket = refill(
      state.userResumeBuckets.get(facts.clientId) ?? {
        tokens: limits.userResumeBucketCapacity,
        updatedAt: now
      },
      limits.userResumeBucketCapacity,
      userResumeTokensPerMs(limits),
      now
    )
    state.userResumeBuckets.set(facts.clientId, {
      tokens: Math.max(0, bucket.tokens - 1),
      updatedAt: now
    })
  }
}

/** Ends an admitted fork's in-flight slot; `becameLive` counts it against the live cap. */
export function settleSpawnAdmission(
  state: SpawnAdmissionState,
  charge: SpawnCharge,
  becameLive: boolean
): void {
  state.inFlight[charge] = Math.max(0, state.inFlight[charge] - 1)
  if (charge === 'automatic' && becameLive) {
    state.liveAutomatic += 1
  }
}

export function releaseLiveAutomatic(state: SpawnAdmissionState): void {
  state.liveAutomatic = Math.max(0, state.liveAutomatic - 1)
}

/** Drops idle full buckets so a long-lived host does not keep one per past client. */
export function pruneUserResumeBuckets(
  state: SpawnAdmissionState,
  limits: SpawnAdmissionLimits,
  now: number
): void {
  for (const [clientId, bucket] of state.userResumeBuckets) {
    if (
      refill(bucket, limits.userResumeBucketCapacity, userResumeTokensPerMs(limits), now).tokens >=
      limits.userResumeBucketCapacity
    ) {
      state.userResumeBuckets.delete(clientId)
    }
  }
}

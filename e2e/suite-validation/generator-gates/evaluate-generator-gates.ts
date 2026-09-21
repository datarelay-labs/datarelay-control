/**
 * Generator/Coverage Gate evaluator used by suite-validation mutations G01-G10.
 * Operates on ephemeral in-memory catalogs — never mutates live XP run evidence.
 */

export type Combo = {
  combination_id: string
  axes: {
    execution_surface?: string
    route_runtime?: string
    destination_type?: string
    route_transform_override?: string
    fault_type?: string
  }
}

export type NARow = { combination_id: string; rule_id?: string; reason?: string; evidence?: string }
export type ResultRow = { combination_id: string; status: string; result_hash?: string }

export type GeneratorGateResult = {
  ok: boolean
  errors: string[]
  missing: number
  duplicates: number
  unjustified_na: number
  route_mode_gap: number
  browser_missing: number
  cross_axis_gap: number
  fault_missing: number
  missing_results: number
  conflict_duplicates: number
}

export function evaluateGeneratorGates(opts: {
  valid: Combo[]
  not_applicable: NARow[]
  results: ResultRow[]
  require_route_on?: boolean
  require_browser?: boolean
  require_fault?: boolean
  require_dest_b_override?: boolean
}): GeneratorGateResult {
  const errors: string[] = []
  const expected = new Set(opts.valid.map((v) => v.combination_id))
  const executed = new Map<string, ResultRow[]>()
  for (const r of opts.results) {
    const list = executed.get(r.combination_id) || []
    list.push(r)
    executed.set(r.combination_id, list)
  }

  const missing_ids = [...expected].filter((id) => !executed.has(id))
  const duplicate_ids = [...executed.entries()].filter(([, list]) => list.length > 1).map(([id]) => id)
  let unjustified = 0
  for (const row of opts.not_applicable) {
    if (!row.rule_id || !row.reason || !row.evidence) unjustified += 1
  }

  let route_mode_gap = 0
  if (opts.require_route_on !== false) {
    const hasOn = opts.valid.some((v) => v.axes.route_runtime === 'ROUTE_ON')
    if (!hasOn) {
      route_mode_gap = 1
      errors.push('route_mode_coverage')
    }
  }

  let browser_missing = 0
  if (opts.require_browser !== false) {
    const browserExpected = opts.valid.filter((v) => v.axes.execution_surface === 'BROWSER')
    for (const row of browserExpected) {
      if (!executed.has(row.combination_id)) browser_missing += 1
    }
    if (browser_missing) errors.push('browser_coverage')
  }

  let cross_axis_gap = 0
  if (opts.require_dest_b_override !== false) {
    const has = opts.valid.some(
      (v) => v.axes.destination_type === 'SYSLOG_UDP' && v.axes.route_transform_override === 'ON',
    )
    if (!has) {
      cross_axis_gap = 1
      errors.push('cross_axis_coverage')
    }
  }

  let fault_missing = 0
  if (opts.require_fault !== false) {
    const faults = opts.valid.filter((v) => v.axes.fault_type && v.axes.fault_type !== 'NONE')
    if (!faults.length) {
      fault_missing = 1
      errors.push('fault_coverage')
    }
  }

  if (missing_ids.length) errors.push('missing_combination')
  if (duplicate_ids.length) errors.push('duplicate_combination')
  if (unjustified) errors.push('na_reason')

  // Applicability audit: N/A that are also in valid
  const validSet = new Set(opts.valid.map((v) => v.combination_id))
  const naAlsoValid = opts.not_applicable.filter((n) => validSet.has(n.combination_id)).length
  if (naAlsoValid) errors.push('applicability_audit')

  let conflict_duplicates = 0
  for (const [id, list] of executed) {
    if (list.length > 1) {
      const hashes = new Set(list.map((x) => x.result_hash || x.status))
      if (hashes.size > 1) {
        conflict_duplicates += 1
        errors.push('duplicate_conflict')
      }
    }
  }

  const missing_results = missing_ids.length
  if (missing_results) errors.push('missing_result')

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    missing: missing_ids.length,
    duplicates: duplicate_ids.length,
    unjustified_na: unjustified,
    route_mode_gap,
    browser_missing,
    cross_axis_gap,
    fault_missing,
    missing_results,
    conflict_duplicates,
  }
}

export function baselineGeneratorFixture(): {
  valid: Combo[]
  not_applicable: NARow[]
  results: ResultRow[]
} {
  const valid: Combo[] = [
    {
      combination_id: 'xp_a',
      axes: {
        execution_surface: 'BROWSER',
        route_runtime: 'ROUTE_ON',
        destination_type: 'WEBHOOK_POST',
        route_transform_override: 'OFF',
        fault_type: 'NONE',
      },
    },
    {
      combination_id: 'xp_b',
      axes: {
        execution_surface: 'API_SEEDED',
        route_runtime: 'ROUTE_ON',
        destination_type: 'SYSLOG_UDP',
        route_transform_override: 'ON',
        fault_type: 'HTTP_500',
      },
    },
    {
      combination_id: 'xp_c',
      axes: {
        execution_surface: 'API_SEEDED',
        route_runtime: 'ROUTE_ON',
        destination_type: 'WEBHOOK_POST',
        route_transform_override: 'OFF',
        fault_type: 'NONE',
      },
    },
  ]
  const not_applicable: NARow[] = [
    { combination_id: 'xp_na', rule_id: 'R1', reason: 'incompatible', evidence: 'axes' },
  ]
  const results: ResultRow[] = valid.map((v) => ({
    combination_id: v.combination_id,
    status: 'PASS',
    result_hash: `h-${v.combination_id}`,
  }))
  return { valid, not_applicable, results }
}

export function applyGeneratorMutation(
  id: string,
  base: ReturnType<typeof baselineGeneratorFixture>,
): { fixture: ReturnType<typeof baselineGeneratorFixture>; expected_error: string } {
  const fixture = structuredClone(base)
  switch (id) {
    case 'G01':
      fixture.results = fixture.results.filter((r) => r.combination_id !== 'xp_a')
      return { fixture, expected_error: 'missing_combination' }
    case 'G02':
      fixture.results.push({ ...fixture.results[0], result_hash: fixture.results[0].result_hash })
      return { fixture, expected_error: 'duplicate_combination' }
    case 'G03':
      fixture.not_applicable.push({
        combination_id: 'xp_b',
        rule_id: 'BAD',
        reason: 'forced',
        evidence: 'mut',
      })
      return { fixture, expected_error: 'applicability_audit' }
    case 'G04':
      fixture.not_applicable.push({ combination_id: 'xp_na2' })
      return { fixture, expected_error: 'na_reason' }
    case 'G05':
      fixture.valid = fixture.valid.map((v) => ({
        ...v,
        axes: { ...v.axes, route_runtime: 'ROUTE_OFF' },
      }))
      return { fixture, expected_error: 'route_mode_coverage' }
    case 'G06':
      fixture.results = fixture.results.filter((r) => r.combination_id !== 'xp_a')
      return { fixture, expected_error: 'browser_coverage' }
    case 'G07':
      fixture.valid = fixture.valid.map((v) =>
        v.combination_id === 'xp_b'
          ? { ...v, axes: { ...v.axes, route_transform_override: 'OFF' } }
          : v,
      )
      return { fixture, expected_error: 'cross_axis_coverage' }
    case 'G08':
      fixture.valid = fixture.valid.map((v) => ({ ...v, axes: { ...v.axes, fault_type: 'NONE' } }))
      return { fixture, expected_error: 'fault_coverage' }
    case 'G09':
      fixture.results = fixture.results.filter((r) => r.combination_id !== 'xp_c')
      return { fixture, expected_error: 'missing_result' }
    case 'G10':
      fixture.results.push({ combination_id: 'xp_a', status: 'FAIL', result_hash: 'conflict' })
      return { fixture, expected_error: 'duplicate_conflict' }
    default:
      return { fixture, expected_error: 'unknown' }
  }
}

export function runGeneratorMutationSuite(): {
  status: 'PASS' | 'FAIL'
  results: { mutation_id: string; detected: boolean; errors: string[]; expected_error: string }[]
} {
  const base = baselineGeneratorFixture()
  const ids = ['G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G08', 'G09', 'G10']
  const results = ids.map((id) => {
    const { fixture, expected_error } = applyGeneratorMutation(id, base)
    const gate = evaluateGeneratorGates(fixture)
    const detected = !gate.ok && gate.errors.includes(expected_error)
    return { mutation_id: id, detected, errors: gate.errors, expected_error }
  })
  return { status: results.every((r) => r.detected) ? 'PASS' : 'FAIL', results }
}

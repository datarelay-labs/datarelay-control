import { describe, expect, it } from 'vitest'
import {
  applyIncrementalRequestTemplate,
  availableIncrementalPatterns,
  buildIncrementalRequestPlan,
  buildIncrementalRequestTestSignature,
  calculateIncrementalRequestTestCheckpoint,
  collectCheckpointValuesForIncrementalTest,
  collectCheckpointValuesFromEventSource,
  coerceCheckpointScalarValue,
  facetNameFromCheckpointPath,
  incrementalPatternDisplayLabel,
  incrementalPreviewKind,
  incrementalPreviewKindLabel,
  inferIncrementalRequestPattern,
  incrementalRequestTestWarning,
  preferPrimitiveCheckpointPath,
  readCheckpointFromEventSourceRecord,
  readCheckpointSampleValue,
  resolveCheckpointPathForExtractedEvent,
  resolveCheckpointPathForRecord,
  resolveCheckpointValuesForTest,
} from './wizard-incremental-request'

describe('readCheckpointSampleValue', () => {
  const nestedRecord = {
    data: {
      result: [
        {
          elementDataMap: {
            'AP-ID833786762': {
              '0': {
                simpleValues: {
                  creationTime: '2024-06-21T02:00:00.000Z',
                },
              },
            },
          },
        },
      ],
    },
  }

  it('resolves flat checkpoint paths', () => {
    expect(readCheckpointSampleValue({ creationTime: 42 }, '$.creationTime')).toBe(42)
  })

  it('resolves nested paths with array indices', () => {
    expect(
      readCheckpointSampleValue(
        nestedRecord,
        '$.data.result[0].elementDataMap.AP-ID833786762.0.simpleValues.creationTime',
      ),
    ).toBe('2024-06-21T02:00:00.000Z')
  })
})

describe('calculateIncrementalRequestTestCheckpoint', () => {
  const records = [
    { creationTime: 1000 },
    { creationTime: 2000 },
    { creationTime: 3000 },
  ]

  it('uses second-latest checkpoint from Event Source records', () => {
    const values = collectCheckpointValuesFromEventSource(records, '$.creationTime')
    const result = calculateIncrementalRequestTestCheckpoint(values, 'TIMESTAMP')
    expect(result).toMatchObject({
      kind: 'ok',
      value: 2000,
      usedFallback: false,
      latestExcluded: '3000',
    })
  })

  it('falls back to timestamp minus one hour when only one value exists', () => {
    const result = calculateIncrementalRequestTestCheckpoint([1_700_000_000_000], 'TIMESTAMP')
    expect(result).toMatchObject({
      kind: 'ok',
      usedFallback: true,
      value: 1_700_000_000_000 - 3_600_000,
    })
  })

  it('falls back to numeric minus one when only one numeric value exists', () => {
    const result = calculateIncrementalRequestTestCheckpoint([42], 'EVENT_ID')
    expect(result).toMatchObject({
      kind: 'ok',
      usedFallback: true,
      value: 41,
      valueKind: 'numeric',
    })
  })

  it('picks second-latest lexicographic string when multiple opaque string values exist', () => {
    const result = calculateIncrementalRequestTestCheckpoint(['alpha', 'beta'], 'CURSOR')
    expect(result).toMatchObject({
      kind: 'ok',
      usedFallback: false,
      value: 'alpha',
      latestExcluded: 'beta',
      valueKind: 'string',
    })
  })

  it('uses single string checkpoint value with fallback when only one exists', () => {
    const result = calculateIncrementalRequestTestCheckpoint(['cursor-abc'], 'CURSOR')
    expect(result).toMatchObject({
      kind: 'ok',
      usedFallback: true,
      value: 'cursor-abc',
      valueKind: 'string',
    })
  })

  it('coerces wrapped Cybereason-style creationTime objects for incremental test', () => {
    const wrapped = { dateValue: '2024-07-28T20:13:20.000Z', value: '1722202400000' }
    expect(coerceCheckpointScalarValue(wrapped)).toBe('1722202400000')
    const result = calculateIncrementalRequestTestCheckpoint([wrapped], 'TIMESTAMP')
    expect(result).toMatchObject({
      kind: 'ok',
      usedFallback: true,
      valueKind: 'timestamp',
    })
  })

  it('coerces CrowdStrike dataValues.values[] wrapped timestamps', () => {
    const wrapped = { dataValues: { values: ['7777700740001'] } }
    expect(coerceCheckpointScalarValue(wrapped)).toBe('7777700740001')
    const values = resolveCheckpointValuesForTest({
      records: [{}],
      checkpointSourcePath: '$.creationTime',
      eventArrayPath: '$',
      resolvedSampleValue: wrapped,
    })
    expect(values).toEqual(['7777700740001'])
    expect(calculateIncrementalRequestTestCheckpoint(values, 'TIMESTAMP')).toMatchObject({
      kind: 'ok',
      usedFallback: true,
      valueKind: 'timestamp',
    })
  })

  it('enables test when Example shows wrapped object via resolvedSampleValue', () => {
    const wrapped = { dateValue: '2024-07-28T20:13:20.000Z', value: '1722202400000' }
    const values = collectCheckpointValuesForIncrementalTest({
      records: [{}],
      checkpointSourcePath: '$.status.creationTime',
      eventArrayPath: '$.data.audit.root',
      previewRecord: {},
      resolvedSampleValue: wrapped,
    })
    expect(values).toEqual(['1722202400000'])
    expect(calculateIncrementalRequestTestCheckpoint(values, 'TIMESTAMP')).toMatchObject({
      kind: 'ok',
      usedFallback: true,
    })
  })

  it('disables test when no checkpoint values exist', () => {
    const result = calculateIncrementalRequestTestCheckpoint([], 'TIMESTAMP')
    expect(result.kind).toBe('disabled')
  })

  it('resolveCheckpointValuesForTest does not fall back to records when Example is a non-scalar object', () => {
    const values = resolveCheckpointValuesForTest({
      records: [{ creationTime: '2024-06-21T02:00:00.000Z' }],
      checkpointSourcePath: '$.executionStep',
      eventArrayPath: '$',
      resolvedSampleValue: { id: '6655847b-aaaa-bbbb-cccc' },
    })
    expect(values).toEqual([])
    expect(calculateIncrementalRequestTestCheckpoint(values, 'STRING')).toMatchObject({
      kind: 'disabled',
      reason: 'Select a checkpoint field with values first.',
    })
  })

  it('collects nested checkpoint values for incremental request tests', () => {
    const nestedRecords = [
      {
        data: {
          result: [{ simpleValues: { creationTime: '2024-06-20T02:00:00.000Z' } }],
        },
      },
      {
        data: {
          result: [{ simpleValues: { creationTime: '2024-06-21T02:00:00.000Z' } }],
        },
      },
      {
        data: {
          result: [{ simpleValues: { creationTime: '2024-06-22T02:00:00.000Z' } }],
        },
      },
    ]
    const values = collectCheckpointValuesFromEventSource(
      nestedRecords,
      '$.data.result[0].simpleValues.creationTime',
    )
    const result = calculateIncrementalRequestTestCheckpoint(values, 'TIMESTAMP')
    expect(values).toHaveLength(3)
    expect(result).toMatchObject({
      kind: 'ok',
      usedFallback: false,
    })
  })

  it('collects checkpoint values when event root narrows records and path keeps stale array prefix', () => {
    const records = [
      {
        elementDataMap: {
          bf48b53f68e14b14: {
            simpleValues: {
              creationTime: '2024-06-21T02:00:00.000Z',
            },
          },
        },
      },
    ]
    const values = collectCheckpointValuesFromEventSource(
      records,
      '$.data.results[0].elementDataMap.bf48b53f68e14b14.simpleValues.creationTime',
      '$.elementDataMap.bf48b53f68e14b14',
    )
    const result = calculateIncrementalRequestTestCheckpoint(values, 'TIMESTAMP')
    expect(values).toEqual(['2024-06-21T02:00:00.000Z'])
    expect(result).toMatchObject({
      kind: 'ok',
      usedFallback: true,
    })
  })

  it('falls back to event-root tail segments for a single extracted malop record', () => {
    const record = {
      elementDataMap: {
        bf48b53f68e14b14: {
          simpleValues: {
            creationTime: '2024-06-21T02:00:00.000Z',
          },
        },
      },
    }
    expect(
      readCheckpointFromEventSourceRecord(
        record,
        '$.data.results[0].elementDataMap.bf48b53f68e14b14.simpleValues.creationTime',
        '$.elementDataMap.bf48b53f68e14b14',
      ),
    ).toBe('2024-06-21T02:00:00.000Z')
  })
})

describe('collectCheckpointValuesForIncrementalTest', () => {
  it('reads checkpoint from extracted records when path keeps stale array prefix', () => {
    const records = [
      {
        dataMap: {
          'if-b81b84a7b4c': {
            simpleValue: {
              creationTime: '2024-06-21T02:00:00.000Z',
            },
          },
        },
      },
    ]
    const values = collectCheckpointValuesForIncrementalTest({
      records,
      checkpointSourcePath: '$.data.results[0].dataMap.if-b81b84a7b4c.simpleValue.creationTime',
      eventArrayPath: '$.data.results',
      previewRecord: records[0],
    })
    expect(values).toEqual(['2024-06-21T02:00:00.000Z'])
    expect(calculateIncrementalRequestTestCheckpoint(values, 'TIMESTAMP')).toMatchObject({
      kind: 'ok',
      usedFallback: true,
    })
  })

  it('resolveCheckpointPathForRecord strips event array sample prefix', () => {
    expect(
      resolveCheckpointPathForRecord(
        '$.data.results[0].dataMap.if-b81b84a7b4c.simpleValue.creationTime',
        '$.data.results',
      ),
    ).toBe('$.dataMap.if-b81b84a7b4c.simpleValue.creationTime')
  })

  it('resolveCheckpointPathForRecord strips dynamic key after object-map wildcard array path', () => {
    expect(
      resolveCheckpointPathForRecord(
        '$.data.resultIdToElementDataMap.kFrA4R53fMqT0zlG.simpleValues.creationTime.values[0]',
        '$.data.resultIdToElementDataMap.*',
      ),
    ).toBe('$.simpleValues.creationTime.values[0]')
  })

  it('falls back to preview record for a single sample', () => {
    const preview = { creationTime: '2024-06-21T02:00:00.000Z' }
    const values = collectCheckpointValuesForIncrementalTest({
      records: [],
      checkpointSourcePath: '$.creationTime',
      eventArrayPath: '$',
      previewRecord: preview,
    })
    expect(values).toEqual(['2024-06-21T02:00:00.000Z'])
  })

  it('uses resolvedSampleValue when record path reads fail but Example cell has a value', () => {
    const values = collectCheckpointValuesForIncrementalTest({
      records: [{}],
      checkpointSourcePath: '$.metadata.event_timestamp',
      eventArrayPath: '$.data.results',
      previewRecord: {},
      resolvedSampleValue: '2024-06-22T12:00:00.000Z',
    })
    expect(values).toEqual(['2024-06-22T12:00:00.000Z'])
    expect(calculateIncrementalRequestTestCheckpoint(values, 'STRING')).toMatchObject({
      kind: 'ok',
      usedFallback: true,
      valueKind: 'timestamp',
    })
  })

  it('resolveCheckpointValuesForTest prefers Example over unusable record reads', () => {
    const wrapped = { totalValue: 1, value: '1727780748001' }
    const values = resolveCheckpointValuesForTest({
      records: [{ noise: {} }],
      checkpointSourcePath: "$.data.raw['@vendor/slprocessinfoValue:readLogFile']",
      eventArrayPath: '$',
      resolvedSampleValue: wrapped,
    })
    expect(values).toEqual(['1727780748001'])
    expect(calculateIncrementalRequestTestCheckpoint(values, 'TIMESTAMP')).toMatchObject({
      kind: 'ok',
      usedFallback: true,
      valueKind: 'timestamp',
    })
  })

  it('resolveCheckpointValuesForTest prefers multiple extracted values over single Example value', () => {
    const values = resolveCheckpointValuesForTest({
      records: [
        { simpleValues: { creationTime: { values: ['1722202400000'] } } },
        { simpleValues: { creationTime: { values: ['1722202500000'] } } },
        { simpleValues: { creationTime: { values: ['1722202600000'] } } },
      ],
      checkpointSourcePath: '$.simpleValues.creationTime.values[0]',
      eventArrayPath: '$.data.resultIdToElementDataMap.*',
      resolvedSampleValue: '1722202600000',
    })
    expect(values).toEqual(['1722202400000', '1722202500000', '1722202600000'])
    expect(calculateIncrementalRequestTestCheckpoint(values, 'TIMESTAMP')).toMatchObject({
      kind: 'ok',
      value: 1722202500000,
      usedFallback: false,
      latestExcluded: '1722202600000',
      valueKind: 'timestamp',
    })
  })

  it('reads checkpoint values through bracket-quoted JSONPath keys', () => {
    const record = {
      data: {
        raw: {
          '@vendor/slprocessinfoValue:readLogFile': { totalValue: 1, value: '1727780748001' },
        },
      },
    }
    expect(
      readCheckpointSampleValue(record, "$.data.raw['@vendor/slprocessinfoValue:readLogFile']"),
    ).toEqual({ totalValue: 1, value: '1727780748001' })
  })

  it('reads createdAtTime from extracted malop when event root and stale checkpoint prefix are set', () => {
    const extracted = {
      createdAtTime: '2024-06-21T02:00:00.000Z',
      simpleValues: { elementId: 'abc' },
    }
    const values = collectCheckpointValuesForIncrementalTest({
      records: [extracted],
      checkpointSourcePath:
        '$.data.results[0].elementDataMap.bf9cd3196f7b1c518af6f45e6.createdAtTime',
      eventArrayPath: '$',
      eventRootPath: '$.data.results[0].elementDataMap.bf9cd3196f7b1c518af6f45e6',
      previewRecord: extracted,
    })
    expect(values).toEqual(['2024-06-21T02:00:00.000Z'])
    expect(calculateIncrementalRequestTestCheckpoint(values, 'TIMESTAMP')).toMatchObject({
      kind: 'ok',
      usedFallback: true,
    })
  })

  it('reads checkpoint values when array path is object-map wildcard and checkpoint includes concrete dynamic key', () => {
    const extracted = {
      simpleValues: {
        creationTime: {
          values: ['1727780748001'],
        },
      },
    }
    const values = collectCheckpointValuesForIncrementalTest({
      records: [extracted],
      checkpointSourcePath:
        '$.data.resultIdToElementDataMap.kFrA4R53fMqT0zlG.simpleValues.creationTime.values[0]',
      eventArrayPath: '$.data.resultIdToElementDataMap.*',
      previewRecord: extracted,
    })
    expect(values).toEqual(['1727780748001'])
    expect(calculateIncrementalRequestTestCheckpoint(values, 'TIMESTAMP')).toMatchObject({
      kind: 'ok',
      usedFallback: true,
      valueKind: 'timestamp',
    })
  })

  it('reads scalar checkpoint when operator path uses values[0] suffix', () => {
    const extracted = {
      simpleValues: {
        creationTime: '1727780748001',
      },
    }
    const values = collectCheckpointValuesForIncrementalTest({
      records: [extracted],
      checkpointSourcePath: '$.simpleValues.creationTime.values[0]',
      eventArrayPath: '$.data.resultIdToElementDataMap.*',
      previewRecord: extracted,
    })
    expect(values).toEqual(['1727780748001'])
    expect(calculateIncrementalRequestTestCheckpoint(values, 'TIMESTAMP')).toMatchObject({
      kind: 'ok',
      usedFallback: true,
      valueKind: 'timestamp',
    })
  })

  it('resolveCheckpointPathForExtractedEvent maps checkpoint to $.createdAtTime on malop object', () => {
    expect(
      resolveCheckpointPathForExtractedEvent(
        '$.data.results[0].elementDataMap.bf9cd3196f7b1c518af6f45e6.createdAtTime',
        '$',
        '$.data.results[0].elementDataMap.bf9cd3196f7b1c518af6f45e6',
      ),
    ).toBe('$.createdAtTime')
  })
})

describe('incremental pattern display helpers', () => {
  it('maps visualsearch_query to Custom Body label', () => {
    expect(incrementalPatternDisplayLabel('visualsearch_query')).toBe('Custom Body')
  })

  it('does not expose vendor names in display labels', () => {
    for (const pattern of ['none', 'query_params', 'json_body', 'custom', 'elasticsearch', 'visualsearch_query'] as const) {
      const label = incrementalPatternDisplayLabel(pattern)
      expect(label.toLowerCase()).not.toContain('cybereason')
      expect(label.toLowerCase()).not.toContain('visual search')
    }
  })

  it('offers query params for GET and body patterns for POST', () => {
    expect(availableIncrementalPatterns('GET')).toEqual(['none', 'query_params', 'custom'])
    expect(availableIncrementalPatterns('POST')).toEqual(['none', 'json_body', 'custom', 'elasticsearch'])
  })

  it('uses JSON Body preview for POST streams including visualsearch_query', () => {
    expect(incrementalPreviewKind('visualsearch_query', '{}', 'POST')).toBe('json_body')
    expect(incrementalPreviewKindLabel('json_body', '{}', 'POST')).toBe('JSON Body')
    expect(incrementalPreviewKind('query_params', 'a=1', 'GET')).toBe('query_params')
  })

  it('uses JSON Body preview for POST custom even when draft looks like query params', () => {
    expect(incrementalPreviewKind('custom', 'limit=100\nsort=asc', 'POST')).toBe('json_body')
  })
})

describe('Cybereason visualsearch incremental', () => {
  it('infers visualsearch_query from endpoint path', () => {
    expect(
      inferIncrementalRequestPattern({
        endpoint: '/rest/visualsearch/query/simple',
        requestBody: '',
        httpMethod: 'POST',
      }),
    ).toBe('visualsearch_query')
  })

  it('infers query_params for GET streams', () => {
    expect(
      inferIncrementalRequestPattern({
        endpoint: '/v1/events',
        requestBody: '',
        httpMethod: 'GET',
      }),
    ).toBe('query_params')
  })

  it('builds queryPath POST body with hasSuspicions and creationTime filter', () => {
    const plan = buildIncrementalRequestPlan(
      'visualsearch_query',
      '$.simpleValues.creationTime.values[0]',
    )
    expect(plan?.pattern).toBe('visualsearch_query')
    const parsed = JSON.parse(plan?.preview ?? '{}') as {
      queryPath: Array<{ filters?: Array<Record<string, unknown>> }>
    }
    const processStep = parsed.queryPath.find((step) => step.filters?.some((f) => f.facetName === 'hasSuspicions'))
    expect(processStep?.filters).toEqual(
      expect.arrayContaining([
        { facetName: 'hasSuspicions', values: [true] },
        {
          facetName: 'creationTime',
          filterType: 'GreaterThan',
          values: ['{{checkpoint.last_timestamp}}'],
        },
      ]),
    )
  })

  it('maps values[0] checkpoint path to creationTime facet name', () => {
    expect(facetNameFromCheckpointPath('$.elementDataMap.x.simpleValues.creationTime.values[0]')).toBe(
      'creationTime',
    )
  })

  it('prefers values[0] when a wrapped creationTime object is selected', () => {
    const wrapped = { values: ['1722202400000'] }
    expect(preferPrimitiveCheckpointPath('$.simpleValues.creationTime', wrapped)).toBe(
      '$.simpleValues.creationTime.values[0]',
    )
  })

  it('applyIncrementalRequestTemplate keeps query_params separate from visualsearch body', () => {
    const queryMerged = applyIncrementalRequestTemplate(
      { method: 'GET', params: { a: '1' } },
      'query_params',
      'limit=100\nsort=creationTime:asc',
    )
    expect(queryMerged.params.limit).toBe('100')

    const bodyMerged = applyIncrementalRequestTemplate(
      { method: 'POST', params: {}, body: '{"seed":true}' },
      'visualsearch_query',
      buildIncrementalRequestPlan('visualsearch_query', '$.creationTime')?.preview ?? '',
    )
    expect(bodyMerged.body).toContain('queryPath')
    expect(bodyMerged.body).toContain('hasSuspicions')
  })
})

describe('incrementalRequestTestWarning', () => {
  const base = {
    pattern: 'json_body' as const,
    draft: '{"from":"{{checkpoint.last_timestamp}}"}',
    checkpointSourcePath: '$.creationTime',
    eventArrayPath: '$.data',
  }

  it('warns when incremental body was not tested', () => {
    const warn = incrementalRequestTestWarning({
      ...base,
      lastSuccessSignature: null,
      lastSuccessAt: null,
    })
    expect(warn.level).toBe('warning')
  })

  it('invalidates warning after successful test signature matches', () => {
    const signature = buildIncrementalRequestTestSignature(base)
    const warn = incrementalRequestTestWarning({
      ...base,
      lastSuccessSignature: signature,
      lastSuccessAt: Date.now(),
    })
    expect(warn.level).toBe('none')
  })

  it('warns when request body changed after last successful test', () => {
    const signature = buildIncrementalRequestTestSignature(base)
    const warn = incrementalRequestTestWarning({
      ...base,
      draft: '{"from":"{{checkpoint.last_timestamp}}","limit":50}',
      lastSuccessSignature: signature,
      lastSuccessAt: Date.now(),
    })
    expect(warn.level).toBe('warning')
  })
})

describe('applyIncrementalRequestTemplate', () => {
  it('keeps template placeholders in saved stream body', () => {
    const draft = JSON.stringify({
      from: '{{checkpoint.last_timestamp}}',
      to: '{{now}}',
      limit: 100,
    })
    const merged = applyIncrementalRequestTemplate(
      { method: 'GET', params: {} },
      'json_body',
      draft,
    )
    expect(merged.body).toContain('{{checkpoint.last_timestamp}}')
    expect(merged.body).toContain('{{now}}')
    expect(merged.body).not.toContain('1700000000000')
  })
})

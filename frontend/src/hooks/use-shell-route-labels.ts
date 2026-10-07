import { useEffect, useState } from 'react'
import { fetchConnectorById } from '../api/gdcConnectors'
import { fetchDestinationById } from '../api/gdcDestinations'
import { fetchRouteById } from '../api/gdcRoutes'
import { fetchStreamMappingUiConfig } from '../api/gdcRuntime'
import { fetchStreamById } from '../api/gdcStreams'
import {
  formatConnectorLabel,
  formatDestinationLabel,
  formatRouteLabel,
  formatStreamLabel,
} from '../utils/entityLabels'

export type ShellStreamLabel = {
  id: string
  name: string
  status: string | null
}

export type ShellRouteLabels = {
  stream: ShellStreamLabel | null
  connector: { id: string; name: string; status: string | null } | null
  destination: { id: string; name: string } | null
  route: { id: string; name: string } | null
  mappingEdit: { id: string; name: string; streamName: string } | null
  loading: boolean
}

type ShellRouteLabelInput = {
  streamId?: string
  connectorId?: string
  destinationId?: string
  routeId?: string
  mappingEditId?: string
}

function parseNumericId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null
  return Number(raw)
}

export function useShellRouteLabels(input: ShellRouteLabelInput): ShellRouteLabels {
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<ShellRouteLabels>({
    stream: null,
    connector: null,
    destination: null,
    route: null,
    mappingEdit: null,
    loading: false,
  })

  useEffect(() => {
    const onRuntimeControlUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ streamId?: number }>).detail
      if (input.streamId && detail?.streamId === Number(input.streamId)) setRevision((value) => value + 1)
    }
    window.addEventListener('gdc-runtime-control-updated', onRuntimeControlUpdated)
    return () => window.removeEventListener('gdc-runtime-control-updated', onRuntimeControlUpdated)
  }, [input.streamId])

  useEffect(() => {
    const streamNum = parseNumericId(input.streamId)
    const connectorNum = parseNumericId(input.connectorId)
    const destinationNum = parseNumericId(input.destinationId)
    const routeNum = parseNumericId(input.routeId)
    const mappingNum = parseNumericId(input.mappingEditId)

    if (streamNum == null && connectorNum == null && destinationNum == null && routeNum == null && mappingNum == null) {
      setState({
        stream: input.streamId
          ? { id: input.streamId, name: formatStreamLabel(input.streamId), status: null }
          : null,
        connector: input.connectorId
          ? { id: input.connectorId, name: formatConnectorLabel(input.connectorId), status: null }
          : null,
        destination: input.destinationId
          ? { id: input.destinationId, name: formatDestinationLabel(input.destinationId) }
          : null,
        route: input.routeId ? { id: input.routeId, name: formatRouteLabel(input.routeId) } : null,
        mappingEdit: input.mappingEditId
          ? {
              id: input.mappingEditId,
              name: formatStreamLabel(input.mappingEditId),
              streamName: formatStreamLabel(input.mappingEditId),
            }
          : null,
        loading: false,
      })
      return
    }

    let cancelled = false
    setState((prev) => ({ ...prev, loading: true }))

    ;(async () => {
      const [streamRow, connectorRow, destinationRow, routeRow, mappingCfg] = await Promise.all([
        streamNum != null ? fetchStreamById(streamNum) : Promise.resolve(null),
        connectorNum != null ? fetchConnectorById(connectorNum) : Promise.resolve(null),
        destinationNum != null ? fetchDestinationById(destinationNum) : Promise.resolve(null),
        routeNum != null ? fetchRouteById(routeNum) : Promise.resolve(null),
        mappingNum != null ? fetchStreamMappingUiConfig(mappingNum) : Promise.resolve(null),
      ])

      if (cancelled) return

      let streamLabel: ShellStreamLabel | null = null
      if (input.streamId) {
        streamLabel = {
          id: input.streamId,
          name: formatStreamLabel(input.streamId, streamRow?.name),
          status: streamRow?.status ?? null,
        }
      }

      let routeLabel: { id: string; name: string } | null = null
      if (input.routeId) {
        routeLabel = {
          id: input.routeId,
          name: formatRouteLabel(input.routeId, routeRow?.name),
        }
      }

      if (routeRow?.stream_id != null && streamLabel == null) {
        const sid = String(routeRow.stream_id)
        const s = await fetchStreamById(routeRow.stream_id)
        if (!cancelled) {
          streamLabel = {
            id: sid,
            name: formatStreamLabel(sid, s?.name),
            status: s?.status ?? null,
          }
        }
      }

      setState({
        stream: streamLabel,
        connector: input.connectorId
          ? {
              id: input.connectorId,
              name: formatConnectorLabel(input.connectorId, connectorRow?.name),
              status: connectorRow?.status ?? null,
            }
          : null,
        destination: input.destinationId
          ? {
              id: input.destinationId,
              name: formatDestinationLabel(input.destinationId, destinationRow?.name),
            }
          : null,
        route: routeLabel,
        mappingEdit: input.mappingEditId
          ? {
              id: input.mappingEditId,
              name: mappingCfg?.stream_name
                ? `${mappingCfg.stream_name} mapping`
                : formatStreamLabel(input.mappingEditId, mappingCfg?.stream_name),
              streamName: formatStreamLabel(input.mappingEditId, mappingCfg?.stream_name),
            }
          : null,
        loading: false,
      })
    })().catch(() => {
      if (!cancelled) {
        setState({
          stream: input.streamId
            ? { id: input.streamId, name: formatStreamLabel(input.streamId), status: null }
            : null,
          connector: input.connectorId
            ? { id: input.connectorId, name: formatConnectorLabel(input.connectorId), status: null }
            : null,
          destination: input.destinationId
            ? { id: input.destinationId, name: formatDestinationLabel(input.destinationId) }
            : null,
          route: input.routeId ? { id: input.routeId, name: formatRouteLabel(input.routeId) } : null,
          mappingEdit: input.mappingEditId
            ? {
                id: input.mappingEditId,
                name: formatStreamLabel(input.mappingEditId),
                streamName: formatStreamLabel(input.mappingEditId),
              }
            : null,
          loading: false,
        })
      }
    })

    return () => {
      cancelled = true
    }
  }, [input.streamId, input.connectorId, input.destinationId, input.routeId, input.mappingEditId, revision])

  return state
}

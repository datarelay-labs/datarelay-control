import type { WizardProtectionAction, WizardRouteProtectionOverride } from '../components/streams/wizard/wizard-state'

export type RouteProtectionPreviewRoute = {
  routeDraftKey: string
  label: string
  /**
   * This Route's own action for the field before field overrides apply. Omit to use the
   * preview default; null means this Route's configuration does not protect the field.
   */
  effectiveAction?: WizardProtectionAction | null
}

export type EffectiveProtectionPreviewEntry = {
  routeDraftKey: string
  routeLabel: string
  /** Null when the Route's own configuration does not protect the field. */
  protectionAction: WizardProtectionAction | null
  source: 'default' | 'override' | 'route'
}

export type EffectiveProtectionPreviewField = {
  fieldPath: string
  defaultAction: WizardProtectionAction
  perRoute: EffectiveProtectionPreviewEntry[]
}

function normalizeFieldPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return ''
  return trimmed.startsWith('$') ? trimmed : `$.${trimmed}`
}

function overridesForField(
  fieldPath: string,
  overrides: readonly WizardRouteProtectionOverride[],
): WizardRouteProtectionOverride[] {
  const normalized = normalizeFieldPath(fieldPath)
  return overrides.filter(
    (o) => o.enabled && normalizeFieldPath(o.fieldPath) === normalized,
  )
}

/** Client-side effective protection preview (wizard pre-deploy; no API). */
export function computeRouteProtectionEffectivePreview(input: {
  fieldPath: string
  defaultAction: WizardProtectionAction
  routeOverrides: readonly WizardRouteProtectionOverride[]
  routes: readonly RouteProtectionPreviewRoute[]
}): EffectiveProtectionPreviewField {
  const fieldPath = normalizeFieldPath(input.fieldPath)
  const fieldOverrides = overridesForField(fieldPath, input.routeOverrides)
  const overrideByRouteKey = new Map(
    fieldOverrides.map((o) => [o.routeDraftKey, o]),
  )

  const perRoute = input.routes.map((route) => {
    const override = overrideByRouteKey.get(route.routeDraftKey)
    if (override) {
      return {
        routeDraftKey: route.routeDraftKey,
        routeLabel: route.label,
        protectionAction: override.protectionAction,
        source: 'override' as const,
      }
    }
    if (route.effectiveAction !== undefined) {
      return {
        routeDraftKey: route.routeDraftKey,
        routeLabel: route.label,
        protectionAction: route.effectiveAction,
        source: 'route' as const,
      }
    }
    return {
      routeDraftKey: route.routeDraftKey,
      routeLabel: route.label,
      protectionAction: input.defaultAction,
      source: 'default' as const,
    }
  })

  return {
    fieldPath,
    defaultAction: input.defaultAction,
    perRoute,
  }
}

export function computeAllRouteProtectionEffectivePreviews(input: {
  fields: ReadonlyArray<{ fieldPath: string; defaultAction: WizardProtectionAction }>
  routeOverrides: readonly WizardRouteProtectionOverride[]
  routes: readonly RouteProtectionPreviewRoute[]
}): EffectiveProtectionPreviewField[] {
  return input.fields.map((field) =>
    computeRouteProtectionEffectivePreview({
      fieldPath: field.fieldPath,
      defaultAction: field.defaultAction,
      routeOverrides: input.routeOverrides,
      routes: input.routes,
    }),
  )
}

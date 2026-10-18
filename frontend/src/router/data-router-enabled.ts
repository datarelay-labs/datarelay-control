import { createContext } from 'react'

/**
 * Only the application entrypoint (RouterProvider + createBrowserRouter) sets
 * this flag. Legacy declarative MemoryRouter component tests stay supported
 * while data-router-backed tests can explicitly exercise navigation blockers.
 */
export const DataRouterEnabledContext = createContext(false)

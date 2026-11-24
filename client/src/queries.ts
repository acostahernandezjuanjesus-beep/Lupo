import { QueryClient } from '@tanstack/react-query'
import { ApiError, requestJson } from './api'

// Defaults that differ from TanStack's, and why:
//  - a 4xx is not retried (the server already said no); a network error or 5xx is retried once.
//  - no refetch on window focus: it would reload the page someone is reading. Live data is
//    refreshed separately in App.tsx (`refreshLive`).
export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            retry: (attempts, error) =>
                !(error instanceof ApiError && error.status < 500) && attempts < 1,
            refetchOnWindowFocus: false,
            staleTime: 30_000,
        },
    },
})

/** Standard query function: GET with the token, aborted when Query abandons the query. */
export const fetchJson = <T,>(url: string) =>
    ({ signal }: { signal: AbortSignal }) => requestJson<T>(url, { signal })

/** The message screens show when a load fails. */
export const errorMessage = (e: unknown) =>
    e instanceof ApiError ? e.message : 'Could not connect to the API'

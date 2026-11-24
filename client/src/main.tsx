// IBM Plex Sans for the UI and Plex Mono for codes. Same family on purpose: code and name share a table row.
// In Plex Mono `0` and `O` are hard to tell apart (codes use slashed-zero), so avoid inventing codes that differ only in that.
import '@fontsource/ibm-plex-sans/300.css'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import { StrictMode } from 'react'
import { BrowserRouter } from 'react-router'
import { createRoot } from 'react-dom/client'
// tailwind.css before index.scss: it declares the layer order.
import './tailwind.css'
import './index.scss'
import App from './App.tsx'
import { ThemeProvider } from './components/ThemeProvider'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './queries'
import { applyMode, initialMode } from './colorMode'

applyMode(initialMode())


createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BrowserRouter><App /></BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
)

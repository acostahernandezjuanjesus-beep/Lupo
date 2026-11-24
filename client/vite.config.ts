import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import tailwindcss from '@tailwindcss/vite'

// LUPO_LAN=1: serve over the network with a self-signed cert so a phone can test the scanner.
// Browsers only open the camera on HTTPS or localhost. Off by default: it exposes the dev server to the whole wifi.
const lan = process.env.LUPO_LAN === '1'

export default defineConfig({
    plugins: [react(), tailwindcss(), ...(lan ? [basicSsl()] : [])],
    // Separate cache: both modes can run at once and would otherwise rebuild each other's deps.
    cacheDir: lan ? 'node_modules/.vite-lan' : undefined,
    server: {
        host: lan ? true : undefined,
        proxy: { '/api': process.env.LUPO_API_TARGET || 'http://localhost:3000' }
    }
})

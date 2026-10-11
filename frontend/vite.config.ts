import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '')

    // Env-only configuration (see .cline/rules/env-policy.md) — fail fast
    const requireEnv = (name: string): string => {
        const value = env[name]
        if (!value) {
            throw new Error(`Missing required environment variable: ${name}`)
        }
        return value
    }

    return {
        plugins: [react()],
        server: {
            port: parseInt(requireEnv('VITE_PORT'), 10),
            proxy: {
                '/api': {
                    target: requireEnv('VITE_BACKEND_URL'),
                    changeOrigin: true,
                },
            },
        },
    }
})

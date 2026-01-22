import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { fileURLToPath, URL } from 'node:url'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    devtools(),
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
    }),
    viteReact(),
    tailwindcss(),
    nodePolyfills({
      include: ['buffer', 'process', 'util', 'stream'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Exclude Noir/Barretenberg from dep optimization (they use WASM)
  optimizeDeps: {
    exclude: ['@aztec/bb.js', '@noir-lang/noir_js', '@noir-lang/noirc_abi', '@noir-lang/acvm_js'],
  },
  // Configure server to serve WASM with correct MIME type
  server: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
    proxy: {
      '/api/rpc': {
        target: 'https://devnet.helius-rpc.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/rpc/, ''),
      },
      '/api/photon': {
        target: 'https://devnet.photon.helius-rpc.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/photon/, ''),
      },
      '/api/prover': {
        target: 'https://prover.devnet.lightprotocol.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/prover/, ''),
      }
    },
  },
  // Allow WASM files in assets
  assetsInclude: ['**/*.wasm'],
})


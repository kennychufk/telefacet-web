// vite.config.js
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import glsl from 'vite-plugin-glsl'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    glsl() // This allows importing .glsl shader files
  ],
  
  // Ensure YAML files are treated as assets
  assetsInclude: ['**/*.yaml', '**/*.yml'],
  
  // Development server configuration
  server: {
    port: 5173,
    host: true, // Allow external connections
    
    // Configure headers for SharedArrayBuffer if needed
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin'
    }
  },
  
  // Build configuration
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsDir: 'assets',
    
    // Optimize chunks
    rollupOptions: {
      output: {
        manualChunks: {
          'vue-vendor': ['vue', 'pinia'],
          'yaml-vendor': ['js-yaml'],
          'webgl': ['./src/webgl/Debayer.js']
        }
      }
    }
  },
  
  // Resolve aliases
  resolve: {
    alias: {
      '@': '/src'
    }
  }
})

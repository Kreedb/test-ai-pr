import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

import { offlinePlugin } from './build/offline.js'

// Project site is served from https://kreedb.github.io/test-ai-web/,
// so asset URLs must be prefixed with the repository name.
const base = '/test-ai-web/'

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [
    vue(),
    offlinePlugin(base, [
      'convbin.svg',
      // Parser samples stay available offline; EDA samples are large and cached on use.
      'samples/akd-eeprom.bin',
      'samples/limx-tron2.bin',
      // Preset replay skeletons are small enough to precache.
      'robots/luna.urdf',
      'robots/oli.urdf',
      'robots/tron2a.urdf',
    ]),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})

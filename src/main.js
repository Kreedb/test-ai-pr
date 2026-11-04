import { createApp } from 'vue'

import App from './App.vue'
import './assets/main.css'

createApp(App).mount('#app')

// Offline cache: the build emits sw.js with every asset precached.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: 'none' })
    .catch(() => {})
}

# Vite + Vue 3 Starter

A minimal Vite + Vue 3 (Composition API, `<script setup>`) scaffold.

## Requirements

- Node.js 20.19+ or 22.12+
- npm 10+

## Getting started

```bash
npm install
npm run dev
```

The dev server starts on http://localhost:5173 with hot module replacement enabled.

## Scripts

| Command           | Description                                 |
| ----------------- | ------------------------------------------- |
| `npm run dev`     | Start the dev server with HMR               |
| `npm run build`   | Build for production into `dist/`           |
| `npm run preview` | Serve the production build locally          |

## Structure

```
index.html            # Vite entry, mounts #app
vite.config.js        # Vue plugin + `@` -> ./src alias
jsconfig.json         # IDE support for the `@` alias
public/               # Static assets served as-is
src/
  main.js             # App bootstrap
  App.vue             # Root component
  components/         # Reusable components
  assets/             # Styles and assets processed by the bundler
```

## Path alias

`@` maps to `src/`, configured in both `vite.config.js` and `jsconfig.json`:

```js
import HelloWorld from '@/components/HelloWorld.vue'
```

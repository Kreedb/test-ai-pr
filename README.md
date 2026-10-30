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

The dev server starts on http://localhost:5173/test-ai-pr/ with hot module replacement enabled. The `/test-ai-pr/` prefix comes from the `base` setting described in [Deployment](#deployment).

## Scripts

| Command           | Description                                 |
| ----------------- | ------------------------------------------- |
| `npm run dev`     | Start the dev server with HMR               |
| `npm run build`   | Build for production into `dist/`           |
| `npm run preview` | Serve the production build locally          |

## Deployment

The site is published to GitHub Pages at https://kreedb.github.io/test-ai-pr/.

Deployment is handled by `.github/workflows/deploy.yml`, which runs on every push to `main` and can also be triggered manually from the Actions tab (`workflow_dispatch`). It installs dependencies with `npm ci`, runs `npm run build`, and publishes `dist/` via the GitHub Pages actions.

Because this is a project site served from a subpath, `vite.config.js` sets `base: '/test-ai-pr/'` so that built asset URLs resolve under `https://kreedb.github.io/test-ai-pr/`. If the site ever moves to a custom domain or a user page repository, change `base` back to `/`.

To preview the production build locally, run `npm run build` followed by `npm run preview` and open http://localhost:4173/test-ai-pr/.

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

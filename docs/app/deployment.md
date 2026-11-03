# 部署

站点发布在 GitHub Pages：https://kreedb.github.io/test-ai-pr/。

部署由 `.github/workflows/deploy.yml` 处理：推送到 `main` 时自动运行，也可以在 Actions 页面手动触发（`workflow_dispatch`）。流程是 `npm ci`、`npm test`、`npm run build`，然后用 GitHub Pages 官方 actions 发布 `dist/`。

这是项目站点，路径带仓库名前缀，所以 `vite.config.js` 设置 `base: '/test-ai-pr/'`，构建产物里的资源 URL 才能落在 `https://kreedb.github.io/test-ai-pr/` 下。如果以后换成自定义域名或用户站点仓库，把 `base` 改回 `/`。

导航使用 hash 路由（`#/parser`），不需要服务端重写规则。本地预览生产构建：

```bash
npm run build
npm run preview
```

然后打开 http://localhost:4173/test-ai-pr/。

`.github/workflows/pullfrog.yml` 由 Pullfrog 管理，标注了不要手改；新增 CI 或部署任务时另建 workflow 文件。

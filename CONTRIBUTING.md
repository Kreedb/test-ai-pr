# 贡献指南

本项目是浏览器内运行的 EtherCAT 工具箱，使用 Vite + Vue 3，数据只在本地处理。以下约定用于减少多人并行开发时的合并冲突。

## 分支与提交

- 功能分支命名为 `feat/<简短描述>`、修复分支命名为 `fix/<简短描述>`，保持短生命周期。
- 合并前先 rebase 到最新的 `main`，不要用 merge commit 把主线历史带进功能分支。
- 提交信息使用 Conventional Commits，主题用中文，例如 `feat(convert): 增加 zip 压缩包解析`。
- 一个 PR 只处理一件事：一种新格式、一项界面调整或一次依赖升级。依赖与 lockfile 变更单独提交。
- 不要在功能 PR 里顺手做全文件格式化，否则会产生大量无意义冲突。

## 验证

```bash
npm ci
npm test
npm run build
```

改动页面或模板后，再启动 `npm run dev` 并在浏览器里打开 `http://localhost:5173/test-ai-pr/` 做一次冒烟检查。

## 扩展点

- 新增 EDA 来源：在 `src/lib/formats/` 下新建 `<id>.js`，导出元数据、`losses`、`detect`、`convert`，然后在 `src/lib/formats/index.js` 的显式导入列表里加一行。支持矩阵、有损表、样例按钮和格式标签都从注册表派生，不需要改页面。
- 新增页面：在 `src/routes.js` 里加一条记录，填写 `path`、`label`、`component`，需要首页卡片时再补 `tool`。导航、路由出口和首页工具列表都从这份配置生成。
- 新增测试：按来源放到 `test/formats/<id>.test.mjs`，公共的样例读取与转换辅助函数放在 `test/helpers/` 下，避免所有格式共用一个巨型测试文件。

## 样式与依赖

- 页面级样式优先写在组件的 `<style scoped>` 里；`src/assets/main.css` 只保留设计变量、基础排版和跨页面共用样式。
- 新增运行时依赖前先确认许可证与仓库的 GPL-3.0-only 兼容，并更新 `THIRD-PARTY-NOTICES.md`。
- 不要在 PR 中直接格式化 `package-lock.json`；需要升级时单独提交，并说明升级原因。

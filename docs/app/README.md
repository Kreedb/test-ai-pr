# 应用外壳

convbin 是一个在浏览器中运行的二进制工具箱，当前包含 EtherCAT SII/ESI 与 EDA 格式转换工具，基于 Vite + Vue 3（Composition API，`<script setup>`）。所有数据只在本地处理，不会上传。

线上地址：https://kreedb.github.io/test-ai-pr/

## 工具

导航页（`#/`）统一管理所有工具，后续新增的工具会继续挂在这里。

- [EEPROM 解析器](../parser/README.md)（`#/parser`）
- [EDA 转 KiCad](../convert/README.md)（`#/convert`）

## 运行要求

- Node.js 20.19+ 或 22.12+
- npm 10+

## 本地启动

```bash
npm install
npm run dev
```

开发服务器运行在 http://localhost:5173/test-ai-pr/，带热更新。`/test-ai-pr/` 前缀来自 [部署说明](deployment.md) 里的 `base` 配置。

## 脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动带 HMR 的开发服务器 |
| `npm run build` | 构建到 `dist/` |
| `npm run preview` | 本地预览生产构建 |
| `npm test` | 运行 `node --test` 回归测试 |

## 路径别名

`@` 映射到 `src/`，在 `vite.config.js` 与 `jsconfig.json` 中同时配置：

```js
import { buildPreviewModel } from '@/lib/preview'
```

`lib/` 下的包通过 npm workspace 安装，用包名导入，不要写成 `@/lib/...`：

```js
import { parseSii } from 'sii-parser'
```

## 依赖说明

`package.json` 里的 `overrides` 把 `altiumts` 固定到 npm registry 版本，`.npmrc` 打开 `legacy-peer-deps`，两者都是为了让 tscircuit 这些依赖未声明完整的包能直接 `npm ci` 安装。

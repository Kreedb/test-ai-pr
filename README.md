# EtherCAT 工具箱

一个在浏览器中运行的 EtherCAT 工具，基于 Vite + Vue 3（Composition API，`<script setup>`）。所有数据只在本地处理，不会上传。

线上地址：https://kreedb.github.io/test-ai-pr/

## 工具

导航页（`#/`）统一管理所有工具，后续新增的工具会继续挂在这里。

### EEPROM 解析器（`#/parser`）

- 输入仅支持 `.bin` 格式的 SII EEPROM 转储（最大 512 KiB），可拖拽、选择文件或载入内置示例。
- 解析 SII 固定头：PDI Control、ESC Configuration、配置站别名、厂商 ID、产品码、修订号、序列号、邮箱配置、EEPROM 大小与版本。
- 校验固定头 CRC-8（poly `0x07`，init `0xFF`，覆盖前 14 字节）。
- 遍历并解码类别（Categories）：Strings、General、FMMU、SyncManager、TxPDO / RxPDO 及条目、DC 操作模式；未知/厂商自定义类别保留原始数据。
- 所有解析出的字段都可以直接编辑，列表支持新增与删除：固定头与身份、邮箱、General、字符串、FMMU、SyncManager、PDO 与条目、DC 操作模式。
- 名称字段与 SII 字符串表双向同步；在名称字段中输入新名称会自动创建字符串。
- **导出 ESI XML**（`EtherCATInfo`），可复制或下载。
- 内置 EEPROM 生成器：每次编辑后把导出的 XML 重新编译成 SII 镜像，并与原始转储逐字节比对，列出差异字节；可下载重新编译的 `.bin`。
- 只存在于 SII 镜像、无法写入 ESI 的字段以 `*` 标注，并在提示中说明。
- 原始十六进制视图与原始 `.bin` 下载。

## 示例数据

- `public/samples/akd-eeprom.bin`：Kollmorgen AKD 驱动的 EEPROM 转储（来自 [ethercrab](https://github.com/ethercrab-rs/ethercrab) 的测试数据）。
- `public/samples/limx-tron2.bin` / `public/samples/limx-tron2.xml`：Limx Tron2 的 EEPROM 转储与对应的 TwinCAT ESI 描述文件。解析再导出后重新编译，结果与 `.bin` 逐字节一致。

## 代码结构

```
src/lib/sii.js          # 纯 JS SII 解析器（无 Vue 依赖）：CRC、固定头、类别、PDO、DC
src/lib/esi.js          # ESI XML -> SII 生成器，以及 SII -> ESI XML 导出与回归校验
src/lib/editor.js       # 解析结果的可编辑模型：字符串/名称同步、列表增删、导出参数
src/lib/format.js       # 显示格式化与字段解析辅助函数
src/lib/download.js     # 浏览器下载辅助函数
src/router.js           # 极简 hash 路由（GitHub Pages 子路径下无需重写规则）
src/pages/              # 导航页、解析器页
src/components/         # 可编辑表格、PDO、DC、十六进制视图
src/App.vue             # 页面外壳：品牌、导航、路由出口、页脚
public/samples/         # 示例 EEPROM 转储与 ESI XML
```

解析规则参考 ETG.1000.6（固定头、类别、General、FMMU）、ETG.2010（Strings、DC、PDO）与 ETG.2000（EtherCATInfo XML）。所有多字节字段按小端处理。

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

Navigation uses hash routes (`#/parser`), so no server-side rewrite rules are needed. To preview the production build locally, run `npm run build` followed by `npm run preview` and open http://localhost:4173/test-ai-pr/.

## Path alias

`@` maps to `src/`, configured in both `vite.config.js` and `jsconfig.json`:

```js
import { parseSii } from '@/lib/sii'
```

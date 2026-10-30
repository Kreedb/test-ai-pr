# EtherCAT EEPROM 解析器

一个在浏览器中解析 EtherCAT 从站 EEPROM（SII，Slave Information Interface）转储的 Web 工具。基于 Vite + Vue 3（Composition API，`<script setup>`）。

线上地址：https://kreedb.github.io/test-ai-pr/

## 功能

- 输入格式：二进制转储（`.bin`）、Intel HEX、纯十六进制文本，以及带 `偏移: 字节` 的十六进制转储。
- 解析 SII 固定头：PDI Control、ESC Configuration、配置站别名、厂商 ID、产品码、修订号、序列号、邮箱配置、EEPROM 大小与版本。
- 校验固定头 CRC-8（poly `0x07`，init `0xFF`，覆盖前 14 字节）。
- 遍历并解码类别（Categories）：
  - Strings（字符串表）
  - General（设备名称、CoE/FoE/EoE 能力、EBus 电流、端口类型）
  - FMMU、SyncManager
  - TxPDO / RxPDO 及其条目（索引、子索引、数据类型、位长）
  - DC（分布式时钟操作模式）
  - 未知/厂商自定义类别保留原始数据
- 原始十六进制视图，以及一键复制解析结果为 JSON。
- 所有数据仅在浏览器本地处理，不会上传。

## 输入格式示例

纯十六进制：

```
0A 00 22 00 04 06 45 4B 31 31 30 30 ...
```

Intel HEX：

```
:100000000A0022000406454B313130300853797321
:00000001FF
```

带偏移的转储：

```
0000: 0A 00 22 00 04 06 45 4B 31 31 30 30 08 53 79 73  |.."...EK1100.Sys|
```

页面上的“加载示例”使用 Kollmorgen AKD 驱动的 EEPROM 转储（来自 [ethercrab](https://github.com/ethercrab-rs/ethercrab) 的测试数据），可用来快速查看完整的 Strings / General / SyncManager / PDO / DC 解析结果。

## 解析器结构

```
src/lib/sii.js          # 纯 JS 解析器（无 Vue 依赖）：输入解码、CRC、固定头、类别、PDO、DC
src/lib/format.js       # 显示格式化辅助函数
src/components/         # 表格、PDO、DC、十六进制视图
src/App.vue             # 输入、状态和页面组合
public/samples/         # 示例 EEPROM 转储
```

解析规则参考 ETG.1000.6（固定头、类别、General、FMMU）与 ETG.2010（Strings、DC、PDO）。所有多字节字段按小端处理。

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
  lib/                # SII parser and formatting helpers
  assets/             # Styles and assets processed by the bundler
```

## Path alias

`@` maps to `src/`, configured in both `vite.config.js` and `jsconfig.json`:

```js
import { parseSii } from '@/lib/sii'
```

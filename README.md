# EtherCAT 工具箱

一组在浏览器中运行的 EtherCAT 工具，基于 Vite + Vue 3（Composition API，`<script setup>`）。所有数据只在本地处理，不会上传。

线上地址：https://kreedb.github.io/test-ai-pr/

## 工具

导航页（`#/`）统一管理所有工具，后续新增的工具会继续挂在这里。

### EEPROM 解析器（`#/parser`）

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
- 原始十六进制视图，支持复制 JSON、下载原始 `.bin`，以及**导出 ESI XML**。

### EEPROM 生成器（`#/generator`）

- 输入 TwinCAT / ESI 编辑器导出的 `EtherCATInfo` XML，生成可烧录的 SII 二进制镜像。
- 生成布局与 TwinCAT 的 EEPROM 导出一致：固定头、Strings、General、FMMU、SyncManager、TxPDO、RxPDO、DC、End，尾部以 `0xFF` 填充到 `<Eeprom><ByteSize>`。
- 自动计算固定头 CRC-8、字符串表（去重并按 TwinCAT 的顺序排列）、PDO 数据类型码与 DC 类别。
- 生成后展示设备信息、类别布局、提示信息，可下载 `.bin` 或复制十六进制。
- 示例：`public/samples/limx-tron2.xml` 与 `public/samples/limx-tron2.bin` 是一对真实数据，生成的 bin 与示例逐字节一致。

### ESI XML 生成器 / 编辑器（`#/xml`）

- 输入 SII EEPROM 转储（`.bin`、Intel HEX 或十六进制文本），生成对应的 `EtherCATInfo` XML。
- 也可以直接导入已有的 `EtherCATInfo` XML（拖拽、选择文件或粘贴），把整份设备描述载入编辑器后再修改；含多个 `<Device>` 的文件（例如 Beckhoff SSC 5.13 的 `esi/SlaveStackCode.xml` 带四个设备）可以在页面上切换要编辑的设备。
- 可编辑厂商 ID / 名称、产品码、修订号、订货号、设备名称、组、EEPROM 大小、`ConfigData` / `BootStrap`、四个端口的 Physics、邮箱协议与 CoE 服务（含 `SegmentedSdo`）、`Info` 里的状态机与邮箱超时、`ProfileNo`，以及两个邮箱 SyncManager 的 `MinSize` / `MaxSize`。
- 可选择是否输出 FMMU、SyncManager、TxPDO / RxPDO、DC 与 `IdentificationReg134`；也可以从“空白模板”开始，只生成身份信息与 Eeprom 段。
- 每次生成后会把 XML 重新编译成 SII 镜像，并与基准逐字节比对：来源是转储时对比原始转储，来源是 ESI 时对比原 ESI 的编译结果。差异字节会在页面上列出（修改字段后的差异属预期）。
- 支持复制 XML、下载 `.xml`，以及把当前编辑结果编译成 `.bin` 下载。
- 导入 ESI 时会提示哪些内容无法写入 SII（对象字典、`InitCmd`、`ImageData16x14`、`Slots` / `Modules`、`Exclude`、`SegmentedSdo`）。

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

## 示例数据

- `public/samples/akd-eeprom.bin`：Kollmorgen AKD 驱动的 EEPROM 转储（来自 [ethercrab](https://github.com/ethercrab-rs/ethercrab) 的测试数据）。
- `public/samples/limx-tron2.bin` / `public/samples/limx-tron2.xml`：Limx Tron2 的 EEPROM 转储与对应的 TwinCAT ESI 描述文件。

## 代码结构

```
src/lib/sii.js          # 纯 JS SII 解析器（无 Vue 依赖）：输入解码、CRC、固定头、类别、PDO、DC
src/lib/esi.js          # ESI XML -> SII 生成器，以及 SII -> ESI XML 导出与回归校验
src/lib/format.js       # 显示格式化辅助函数
src/lib/download.js     # 浏览器下载辅助函数
src/router.js           # 极简 hash 路由（GitHub Pages 子路径下无需重写规则）
src/pages/              # 导航页、解析器页、生成器页
src/components/         # 表格、PDO、DC、十六进制视图
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

Navigation uses hash routes (`#/parser`, `#/generator`, `#/xml`), so no server-side rewrite rules are needed. To preview the production build locally, run `npm run build` followed by `npm run preview` and open http://localhost:4173/test-ai-pr/.

## Path alias

`@` maps to `src/`, configured in both `vite.config.js` and `jsconfig.json`:

```js
import { parseSii } from '@/lib/sii'
```

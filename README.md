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

### EDA 转 KiCad（`#/convert`）

- 输入 Altium `.PcbDoc` / `.SchDoc`、Specctra `.dsn` / `.ses`（Allegro、OrCAD PCB Designer、PADS Layout、Xpedition 都能导出），或 EAGLE XML `.brd` / `.sch`，可一次选中整个工程。
- 输出 `.kicad_pcb`、`.kicad_sch`（层次化工程会输出根图 + 每张子图）与 `.kicad_pro`，多文件时可打包成 zip 下载。
- PCB 与原理图同时上传时按同一工程对齐元件与网络。
- 页面固定列出每个来源可能无法无损转换的内容（层数上限、3D 模型、设计规则、敷铜、符号图形、走线需 SES 等）。
- 转换在浏览器本地完成，不会上传任何设计文件。
- 尚未接入 PADS ASCII `.asc`、Allegro/OrCAD 二进制 `.brd`；页面会提示改用 Specctra DSN 导出。

#### 中间格式的选择

所有来源都先解析成 [Circuit JSON](https://github.com/tscircuit/circuit-json)，再由同一个写出器生成 KiCad，
因此新增一种来源只需要补一个解析器，不需要为每种输入输出组合单独写转换器。

- **为什么内部用 Circuit JSON**：它是带类型定义的 JSON，元件、焊盘、网络、走线、原理图符号都有独立元素和 ID，
  比 S-expression 更容易做格式识别、无损检查与增量映射；tscircuit 生态里的各种来源解析器和输出器也都围绕它。
- **为什么对外用 KiCad**：`.kicad_pcb` / `.kicad_sch` 是开放、纯文本、可人工检查的格式，KiCad 本身还能继续导出
  Gerber、IPC-2581、ODB++、STEP 等制造格式。相比之下 IPC-2581、ODB++、GenCAD 只覆盖板级/制造数据，不带原理图语义；
  EDIF 只覆盖原理图；Specctra、Altium、PADS 的工程文件都是私有格式，不适合作为通用中转格式。
- 如果以后需要更多输出（Gerber、BOM、坐标文件），只需再接一个 Circuit JSON 写出器，现有输入解析器不用改。

转换器来自 tscircuit 的开源项目（`altium-to-circuit-json`、`dsn-to-circuit-json`、`circuit-json-to-kicad`），
EAGLE XML 由仓库内的 `src/lib/eagle.js` 解析；许可与示例数据来源见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 示例数据

- `public/samples/akd-eeprom.bin`：Kollmorgen AKD 驱动的 EEPROM 转储（来自 [ethercrab](https://github.com/ethercrab-rs/ethercrab) 的测试数据）。
- `public/samples/limx-tron2.bin` / `public/samples/limx-tron2.xml`：Limx Tron2 的 EEPROM 转储与对应的 TwinCAT ESI 描述文件。解析再导出后重新编译，结果与 `.bin` 逐字节一致。
- `public/samples/altium/`：来自 [luxonis/oak-hardware](https://github.com/luxonis/oak-hardware)（MIT）的 PA6940 工程，含一块 PCB 与两张原理图，用于演示工程级转换。
- `public/samples/specctra/motor-driver.dsn`：Specctra DSN 样例，用于演示只有布局与网表、没有走线的转换结果。
- `public/samples/eagle/SOT23-3.brd` / `SOT23-3.sch`：来自 [tedyapo/ugly-smd-adapters](https://github.com/tedyapo/ugly-smd-adapters)（MIT）的 EAGLE 7.3 转接板，用于演示 EAGLE 板图与原理图一起转换。

## 代码结构

```
src/lib/sii.js          # 纯 JS SII 解析器（无 Vue 依赖）：CRC、固定头、类别、PDO、DC
src/lib/esi.js          # ESI XML -> SII 生成器，以及 SII -> ESI XML 导出与回归校验
src/lib/editor.js       # 解析结果的可编辑模型：字符串/名称同步、列表增删、导出参数
src/lib/format.js       # 显示格式化与字段解析辅助函数
src/lib/download.js     # 浏览器下载辅助函数
src/lib/eda.js          # EDA -> KiCad 转换引擎：格式识别、按需加载转换器、结果汇总
src/lib/eagle.js        # EAGLE XML 板图/原理图 -> Circuit JSON 的映射
src/router.js           # 极简 hash 路由（GitHub Pages 子路径下无需重写规则）
src/pages/              # 导航页、解析器页、EDA 转换页
src/components/         # 可编辑表格、PDO、DC、十六进制视图
src/App.vue             # 页面外壳：品牌、导航、路由出口、页脚
public/samples/         # 示例 EEPROM 转储、ESI XML、Altium / Specctra / EAGLE 工程文件
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
| `npm test`        | Run the `node --test` regression tests      |

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

## License

本项目以 [GNU General Public License v3.0](LICENSE) 发布。集成的第三方转换库与示例数据的许可见
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

`package.json` 里的 `overrides` 把 `altiumts` 固定到 npm registry 版本，`.npmrc` 打开 `legacy-peer-deps`，
两者都是为了让 tscircuit 这些依赖未声明完整的包能直接 `npm ci` 安装。

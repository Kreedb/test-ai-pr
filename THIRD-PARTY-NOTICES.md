# 第三方组件与数据说明

本仓库以 GPL-3.0 发布（见 `LICENSE`）。`#/convert`（EDA 转 KiCad）页面集成了下列开源项目，
它们全部是 GPL-3.0 兼容的宽松许可（MIT / ISC / Apache-2.0 / BSD / Unlicense）。
EAGLE XML 与 PADS Layout ASCII 的字段映射是本仓库自己的代码（`src/lib/eagle.js`、`src/lib/pads.js`），
只依赖 `fast-xml-parser` 做 XML 解析。PADS ASCII 的字段顺序除对照 tscircuit 的 `padsts` 之外，
还与 KiCad（GPL-3.0-or-later，与本仓库许可相同）的 `pcbnew/pcb_io/pads` 导入器交叉核对，未复制其代码。

## 运行时依赖

| 包 | 版本 | 许可 | 用途 |
| --- | --- | --- | --- |
| `altium-to-circuit-json` | 0.0.109 | MIT | Altium PcbDoc / SchDoc → Circuit JSON |
| `altiumts` | 0.0.94 | MIT | Altium OLE 复合文档与记录级解析 |
| `circuit-json-to-kicad` | 0.0.262 | MIT | Circuit JSON → `.kicad_pcb` / `.kicad_sch` / `.kicad_pro` |
| `dsn-to-circuit-json` | 0.0.8 | MIT | Specctra DSN / SES → Circuit JSON |
| `dsnts` | 0.1.12 | MIT | Specctra DSN / SES 语法解析 |
| `kicadts` | 0.0.63 | MIT | KiCad S-expression 读写 |
| `circuit-json` | 0.0.486 | ISC | 中间数据模型 |
| `@tscircuit/circuit-json-util` | 0.0.129 | MIT | Circuit JSON 查询工具 |
| `@tscircuit/solver-utils` | 0.0.25 | MIT | 分阶段转换器框架 |
| `@flatten-js/core` | 1.6.15 | MIT | 平面几何运算 |
| `circuit-json-to-connectivity-map` | 0.0.36 | MIT | 网络连通性 |
| `earcut` | 3.2.4 | ISC | 多边形三角化 |
| `fast-xml-parser` | 5.11.x | MIT | EAGLE XML 解析 |
| `fflate` | 0.8.3 | MIT | 多文件打包下载 |
| `graphics-debug` | 0.0.101 | MIT | DSN 转换器的调试图形 |
| `zod` | 3.25.76 | MIT | Circuit JSON 校验 |
| `vue` | 3.5.x | MIT | 前端框架 |

以上依赖的传递依赖（如 `cfb`、`crc-32`、`adler-32` 为 Apache-2.0，`polygon-clipping`、`transformation-matrix`、
`schematic-symbols`、`svgson`、`fast-png` 为 MIT，`robust-predicates` 为 Unlicense）也都属于宽松许可，
其许可证文本随 `npm install` 安装在 `node_modules` 对应目录下。

`altium-to-circuit-json` 的 `altiumts` 依赖在本仓库通过 `package.json` 的 `overrides` 固定为 npm registry 上的
`altiumts@0.0.94`，避免安装时需要 `bun` 的 git 依赖。

## 示例数据

| 文件 | 来源 | 许可 |
| --- | --- | --- |
| `public/samples/altium/PA6940.PcbDoc`、`M8_Y-adapter.SchDoc`、`Project_Information.SchDoc` | [luxonis/oak-hardware](https://github.com/luxonis/oak-hardware) 的 PA6940 YM8-Adapter 工程 | MIT，Copyright (c) 2020 luxonis |
| `public/samples/specctra/motor-driver.dsn` | [tscircuit/dsn-to-circuit-json](https://github.com/tscircuit/dsn-to-circuit-json) 的测试资产 | MIT，Copyright (c) 2025 tscircuit Inc. |
| `public/samples/eagle/SOT23-3.brd`、`SOT23-3.sch` | [tedyapo/ugly-smd-adapters](https://github.com/tedyapo/ugly-smd-adapters) 的 SOT23-3 转接板 | MIT，Copyright (c) 2016 Theodore C. Yapo |
| `public/samples/pads/res0805.asc` | 按 [tscircuit/padsts](https://github.com/tscircuit/padsts) 测试资产的格式改写的 PADS Layout ASCII 样例 | MIT，Copyright (c) 2025 tscircuit Inc. |
| `test/fixtures/pads/*.asc` | [tscircuit/padsts](https://github.com/tscircuit/padsts) 的 `tests/fixtures` PADS ASCII 回归资产 | MIT，Copyright (c) 2025 tscircuit Inc. |
| `public/samples/akd-eeprom.bin` | [ethercrab-rs/ethercrab](https://github.com/ethercrab-rs/ethercrab) 测试数据 | 见上游仓库 |
| `public/samples/limx-tron2.bin`、`limx-tron2.xml` | Limx Dynamics Tron2 EEPROM 转储与 TwinCAT ESI | 见上游 |

## 商标

Altium Designer、Cadence Allegro、OrCAD、PADS、KiCad 等名称归各自所有者所有，本项目与这些厂商无隶属关系。
转换器按社区逆向整理的公开文档实现，不包含厂商代码；PADS ASCII 是 PADS Layout 官方提供的导出格式，
解析的是导出文件而不是 PADS 的二进制数据库。

# convbin

一个在浏览器中运行的二进制工具箱，当前包含 EtherCAT SII/ESI 与 EDA 格式转换工具，基于 Vite + Vue 3。所有数据只在本地处理，不会上传。

线上地址：https://kreedb.github.io/test-ai-pr/

## 工具

- **EEPROM 解析器**（`#/parser`）：解析 SII EEPROM 转储，编辑字段并导出 ESI XML，内置逐字节往返校验。
- **EDA 转 KiCad**（`#/convert`）：把 Altium、Specctra、EAGLE XML、PADS ASCII 工程转换成 `.kicad_pcb` / `.kicad_sch` / `.kicad_pro`，带只读设计预览。

## 快速开始

需要 Node.js 20.19+ 或 22.12+、npm 10+。

```bash
npm install
npm run dev
```

开发服务器运行在 http://localhost:5173/test-ai-pr/。常用命令：

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动带 HMR 的开发服务器 |
| `npm run build` | 构建到 `dist/` |
| `npm run preview` | 本地预览生产构建 |
| `npm test` | 运行 `node --test` 回归测试 |

## 文档

文档按页面与项目拆分在 [`docs/`](docs/README.md)：

- [应用外壳与部署](docs/app/README.md)
- [EEPROM 解析器](docs/parser/README.md) · [SII 格式与 ESI 映射](docs/parser/sii-format.md)
- [EDA 转 KiCad](docs/convert/README.md) · [格式支持](docs/convert/formats.md) · [有损转换](docs/convert/losses.md) · [设计预览](docs/convert/preview.md)
- [协作约定](docs/development/contributing.md) · [代码结构](docs/development/architecture.md) · [测试](docs/development/testing.md)
- [第三方组件与数据说明](docs/THIRD-PARTY-NOTICES.md)

## 独立库

`lib/` 下的解析器可以单独安装、单独调用，不依赖主项目：

| 包 | 说明 |
| --- | --- |
| [`sii-parser`](lib/sii-parser/README.md) | EtherCAT SII EEPROM 解析器 |
| [`eagle-to-circuit-json`](lib/eagle-to-circuit-json/README.md) | EAGLE XML 板图/原理图 → Circuit JSON |
| [`pads-to-circuit-json`](lib/pads-to-circuit-json/README.md) | PADS Layout ASCII → Circuit JSON |

## License

本项目以 [GNU General Public License v3.0](LICENSE) 发布。集成的第三方转换库与示例数据的许可见
[docs/THIRD-PARTY-NOTICES.md](docs/THIRD-PARTY-NOTICES.md)。

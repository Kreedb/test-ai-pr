# convbin

一个在浏览器中运行的二进制工具箱，当前包含 EtherCAT SII/ESI、EDA 格式转换与机器人 bag 回放工具，基于 Vite + Vue 3。所有数据只在本地处理，不会上传。

线上地址：https://kreedb.github.io/test-ai-web/

## 工具

- **EEPROM 解析器**（`#/parser`）：解析 SII EEPROM 转储，编辑字段并导出 ESI XML，内置逐字节往返校验。
- **机器人回放**（`#/replay`）：读取 ROS1 bag 与 ROS2 MCAP / SQLite bag 的关节与 IMU 话题，按时间轴还原机器人姿态，并提供同步日志、URDF、3D 模型与波形图。
- **EDA 转 KiCad**（`#/convert`）：把 Altium、Specctra、EAGLE XML、PADS ASCII 工程转换成 `.kicad_pcb` / `.kicad_sch` / `.kicad_pro`，带只读设计预览。

## 快速开始

需要 Node.js 20.19+ 或 22.12+、npm 10+。

```bash
npm install
npm run dev
```

开发服务器运行在 http://localhost:5173/test-ai-web/。常用命令：

| 命令              | 说明                               |
| ----------------- | ---------------------------------- |
| `npm run dev`     | 启动带 HMR 的开发服务器            |
| `npm run build`   | 构建到 `dist/`（构建前自动格式化） |
| `npm run preview` | 本地预览生产构建                   |
| `npm test`        | 运行 `node --test` 回归测试        |

## 文档

文档索引见 [`docs/`](docs/README.md)，开发、构建与部署约定见 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)：

- [EEPROM 解析器](docs/parser/README.md) · [SII 格式与 ESI 映射](docs/parser/sii-format.md)
- [机器人包回放](docs/replay/README.md)
- [EDA 转 KiCad](docs/convert/README.md) · [格式支持](docs/convert/formats.md) · [有损转换](docs/convert/losses.md) · [设计预览](docs/convert/preview.md)
- [第三方组件与数据说明](docs/THIRD-PARTY-NOTICES.md)

## 独立库

`lib/` 下的解析器可以单独安装、单独调用，不依赖主项目：

| 包                                                             | 说明                                 |
| -------------------------------------------------------------- | ------------------------------------ |
| [`sii-parser`](lib/sii-parser/README.md)                       | EtherCAT SII EEPROM 解析器           |
| [`eagle-to-circuit-json`](lib/eagle-to-circuit-json/README.md) | EAGLE XML 板图/原理图 → Circuit JSON |
| [`pads-to-circuit-json`](lib/pads-to-circuit-json/README.md)   | PADS Layout ASCII → Circuit JSON     |

## License

本项目以 [GNU General Public License v3.0](LICENSE) 发布。集成的第三方转换库与示例数据的许可见
[docs/THIRD-PARTY-NOTICES.md](docs/THIRD-PARTY-NOTICES.md)。

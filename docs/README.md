# convbin 文档

按页面与项目拆分的文档索引。每个目录只讲一个主题，新增内容时优先新建文件，而不是把说明继续堆进 `README.md`。

| 目录 | 内容 |
| --- | --- |
| [app](app/README.md) | 应用外壳、依赖、脚本与路径别名 |
| [app/deployment.md](app/deployment.md) | GitHub Pages 部署与子路径配置 |
| [parser](parser/README.md) | EEPROM 解析器页面 |
| [parser/sii-format.md](parser/sii-format.md) | SII 镜像布局与 ESI 映射规则 |
| [convert](convert/README.md) | EDA 转 KiCad 页面与转换流水线 |
| [convert/formats.md](convert/formats.md) | 支持的来源、识别方式与示例数据 |
| [convert/losses.md](convert/losses.md) | 有损转换的类别与原因 |
| [convert/preview.md](convert/preview.md) | 只读设计预览 |
| [development/contributing.md](development/contributing.md) | 分支、提交、验证与扩展约定 |
| [development/architecture.md](development/architecture.md) | 代码结构与扩展点 |
| [development/testing.md](development/testing.md) | 测试布局与提速约定 |
| [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) | 第三方组件、示例数据许可与商标 |

各 `lib/` 包自己的说明放在包目录内：

- [`lib/sii-parser/README.md`](../lib/sii-parser/README.md)
- [`lib/eagle-to-circuit-json/README.md`](../lib/eagle-to-circuit-json/README.md)
- [`lib/pads-to-circuit-json/README.md`](../lib/pads-to-circuit-json/README.md)

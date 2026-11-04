# convbin 文档

按页面拆分的文档索引。`docs/` 下的每个目录对应 `src/pages/` 下的一个页面（首页除外），新增内容时优先新建文件，而不是把说明继续堆进 `README.md`。开发、构建与部署约定统一放在 [DEVELOPMENT.md](DEVELOPMENT.md)。

| 目录 | 内容 |
| --- | --- |
| [parser](parser/README.md) | EEPROM 解析器页面 |
| [parser/sii-format.md](parser/sii-format.md) | SII 镜像布局与 ESI 映射规则 |
| [replay](replay/README.md) | 机器人 bag 回放页面、机型骨架与限制 |
| [convert](convert/README.md) | EDA 转 KiCad 页面与转换流水线 |
| [convert/formats.md](convert/formats.md) | 支持的来源、识别方式与示例数据 |
| [convert/losses.md](convert/losses.md) | 有损转换的类别与原因 |
| [convert/preview.md](convert/preview.md) | 只读设计预览 |
| [DEVELOPMENT.md](DEVELOPMENT.md) | 应用外壳、开发约定、代码结构、测试与部署 |
| [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) | 第三方组件、示例数据许可与商标 |

各 `lib/` 包自己的说明放在包目录内：

- [`lib/sii-parser/README.md`](../lib/sii-parser/README.md)
- [`lib/eagle-to-circuit-json/README.md`](../lib/eagle-to-circuit-json/README.md)
- [`lib/pads-to-circuit-json/README.md`](../lib/pads-to-circuit-json/README.md)

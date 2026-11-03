# EDA 转 KiCad（`#/convert`）

把 EDA 工程文件转换成 `.kicad_pcb`、`.kicad_sch` 与 `.kicad_pro`。转换在浏览器本地完成，不会上传任何设计文件。

## 输入

- Altium `.PcbDoc` / `.SchDoc`
- Specctra `.dsn` / `.ses`（Allegro、OrCAD PCB Designer、PADS Layout、Xpedition 都能导出）
- EAGLE XML `.brd` / `.sch`
- PADS Layout ASCII `.asc`

可以一次选中整个工程，也可以直接上传 `.zip`：压缩包在浏览器里解开，按扩展名与内容识别其中的工程文件；工程侧文件（`.PrjPcb`、`.PcbLib`、说明文档等）与 `__MACOSX` 之类的系统文件会被忽略。成员文件仍然受单文件与合计大小上限约束，超出上限或嵌套的压缩包会逐个列出并跳过。

## 输出

- `.kicad_pcb`、`.kicad_sch`（层次化工程会输出根图 + 每张子图）与 `.kicad_pro`。
- 多文件时可打包成 zip 下载。
- PCB 与原理图同时上传时按同一工程对齐元件与网络。

## 预览

转换结果自带只读预览：直接渲染中间模型里的 PCB 与原理图几何，滚轮缩放、拖拽平移，点击焊盘/符号/引脚即可定位。细节见 [设计预览](preview.md)。

## 中间格式

所有来源都先解析成 [Circuit JSON](https://github.com/tscircuit/circuit-json)，再由同一个写出器生成 KiCad，因此新增一种来源只需要补一个解析器，不需要为每种输入输出组合单独写转换器。

- **为什么内部用 Circuit JSON**：它是带类型定义的 JSON，元件、焊盘、网络、走线、原理图符号都有独立元素和 ID，比 S-expression 更容易做格式识别、无损检查与增量映射；tscircuit 生态里的各种来源解析器和输出器也都围绕它。
- **为什么对外用 KiCad**：`.kicad_pcb` / `.kicad_sch` 是开放、纯文本、可人工检查的格式，KiCad 本身还能继续导出 Gerber、IPC-2581、ODB++、STEP 等制造格式。相比之下 IPC-2581、ODB++、GenCAD 只覆盖板级/制造数据，不带原理图语义；EDIF 只覆盖原理图；Specctra、Altium、PADS 的工程文件都是私有格式，不适合作为通用中转格式。
- 如果以后需要更多输出（Gerber、BOM、坐标文件），只需再接一个 Circuit JSON 写出器，现有输入解析器不用改。

转换器来自 tscircuit 的开源项目（`altium-to-circuit-json`、`dsn-to-circuit-json`、`circuit-json-to-kicad`）；EAGLE XML 与 PADS ASCII 由仓库内的 [`lib/eagle-to-circuit-json`](../../lib/eagle-to-circuit-json/README.md)、[`lib/pads-to-circuit-json`](../../lib/pads-to-circuit-json/README.md) 解析。许可与示例数据来源见 [第三方说明](../THIRD-PARTY-NOTICES.md)。

## 支持范围

逐格式的识别方式、示例与未支持项见 [格式支持](formats.md)；会被简化或丢失的内容见 [有损转换](losses.md)。

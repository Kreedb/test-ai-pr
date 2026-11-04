# 格式支持

格式注册表在 `src/lib/formats/index.js`，每个来源一个模块，页面上的支持矩阵、有损表与样例按钮都从注册表派生。支持矩阵不再在这里复制一份，以注册表和转换页 `#/convert` 为准；新增或修改来源后运行 `test/registry.test.mjs`。

## 识别方式

扩展名不够：OrCAD Capture 与 Specctra 都用 `.dsn`，`.brd` 在 EAGLE 里是 XML、在 Allegro 里是二进制，`.asc` 也被无关的网表格式使用。`detectSource` 会结合扩展名与文件头内容判断。

## 未支持的格式

- Allegro / OrCAD PCB 二进制 `.brd`：记录布局未公开且随版本变化，需要逆向客户端二进制。可改用 File → Export → Specctra 导出 DSN，或提供 Gerber。
- PADS 二进制 `.pcb` 与 PADS Logic 原理图：同样未公开。请导出 ASCII `.asc`。
- OrCAD Capture `.dsn`：二进制，可在 Capture 里导出 EDIF/网表。
- EAGLE 5 及更早的二进制 `.brd`：不支持。

## 示例数据

样例文件都在 `public/samples/`，每个格式模块的 `samples` 字段决定页面上的按钮：

- `samples/altium/stm32-f411-4layer/`：STM32F411 四层开发板（CC0-1.0），演示内层与四层叠层。
- `samples/altium/stm32f405-core/`：STM32F405RGT6 核心板（GPL-3.0），演示多图层次化工程。
- `samples/altium/stm32-f411-4layer.zip`：同一工程的 zip，演示压缩包解析。
- `samples/specctra/motor-driver.dsn`：只有布局与网表、没有走线的 Specctra 样例。
- `samples/eagle/SOT23-3.brd` / `SOT23-3.sch`：EAGLE 7.3 转接板（MIT），演示板图与原理图一起转换。
- `samples/pads/res0805.asc`：PADS ASCII 样例，含 SMD、通孔、走线、过孔、敷铜与丝印。

来源与许可见 [第三方说明](../THIRD-PARTY-NOTICES.md)。

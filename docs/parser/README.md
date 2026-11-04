# EEPROM 解析器（`#/parser`）

解析 EtherCAT SII EEPROM 转储，编辑解析结果并导出 ESI XML。

## 输入

- 仅支持 `.bin` 格式的 SII EEPROM 转储（最大 512 KiB）。
- 可拖拽、选择文件或载入内置示例（Kollmorgen AKD、Limx Tron2）。

## 解析内容

- 固定头：PDI Control、ESC Configuration、配置站别名、厂商 ID、产品码、修订号、序列号、邮箱配置、EEPROM 大小与版本。
- 固定头 CRC-8（poly `0x07`，init `0xFF`，覆盖前 14 字节）。
- 类别：Strings、General、FMMU、SyncManager、TxPDO / RxPDO 及条目、DC 操作模式；未知/厂商自定义类别保留原始数据。
- 数据类别与列表条目支持新增、修改和删除：General、字符串、FMMU、SyncManager、PDO 与条目、DC 操作模式；固定头与身份、邮箱字段可直接编辑。
- 名称字段与 SII 字符串表双向同步；在名称字段中输入新名称会自动创建字符串。

## 输出

- **导出 ESI XML**（`EtherCATInfo`），可复制或下载。
- 内置 EEPROM 生成器：每次编辑后把导出的 XML 重新编译成 SII 镜像，并与原始转储逐字节比对，列出差异字节；可下载重新编译的 `.bin`。
- 原始十六进制视图与原始 `.bin` 下载。
- 只存在于 SII 镜像、无法写入 ESI 的字段以 `*` 标注，并在提示中说明。

字段布局与 ESI 映射细节见 [SII 格式与 ESI 映射](sii-format.md)。

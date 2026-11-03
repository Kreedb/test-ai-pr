# SII 格式与 ESI 映射

解析器实现位于 [`lib/sii-parser`](../../lib/sii-parser/README.md)，ESI 导出与生成器位于 `src/lib/esi.js`。

## SII 镜像布局

EEPROM 按字寻址、小端存储：

- `0x00`–`0x7F`：固定头。
- 从 `0x40` 字开始，是一串类别块：`type`、`size in words`、数据。
- 类别顺序与 TwinCAT 一致：Strings、General、FMMU、SyncManager、TxPDO、RxPDO、DC，最后是 `FF FF FF FF` End，其余填充 `0xFF`。

参考 ETG.1000.6（固定头、类别、General、FMMU）、ETG.2010（Strings、DC、PDO）与 ETG.2000（EtherCATInfo XML）。所有多字节字段按小端处理。

## ESI XML 导出

- 设备子元素顺序：`Type`、`Name`、`Info`、`GroupType`、`Profile`、`Fmmu`、`Sm`、`RxPdo`、`TxPdo`、`Mailbox`、`Dc`、`Eeprom`。
- PDO 条目顺序：`Index`、`SubIndex`、`BitLen`、`Name`、`DataType`。
- DC `OpMode` 顺序：`Name`、`Desc`、`AssignActivate`、`CycleTimeSync0`、`ShiftTimeSync0`、`CycleTimeSync1`、`ShiftTimeSync1`。
- 邮箱协议顺序：`AoE`、`EoE`、`CoE`、`FoE`、`SoE`、`VoE`，六项都可选。
- `Device` 必须带 `Physics` 属性；没有端口时输出 `Physics=""`。
- `PdoType` 至少需要一个 `<Name>`，未命名 PDO 输出占位名。
- `Sm Enable` 是布尔值（`1`/`0`）；SII 里大于 1 的使能字节无法表示，会给出警告。

## 往返校验

- `public/samples/limx-tron2.bin` 与 `limx-tron2.xml` 是一对匹配的 TwinCAT 文件：XML 编译结果与 `.bin` 逐字节一致。
- 解析器页面的导出卡片会用 `verifyEsiXml` 重新编译并比对原始字节。
- AKD 样例是有损往返：序列号、条目 flags（编译器固定写 `0x1000`）、physicalMemoryAddress、镜像数据、General flags 与 DS402 通道无法写进 ESI，差异是预期行为。

## 已知约束

- ESI 里没有对应字段的 SII 数据（`Info/StateMachine/Timeout`、`Info/Mailbox/Timeout`、`Profile/ProfileNo`、`Sm MinSize`/`MaxSize`、CoE `SegmentedSdo`）不会导出。
- `General` 偏移 12 的 `EbusCurrent` 会读取并提示，但不会写回。
- 没有 `<Eeprom><BootStrap>` 的设备会从 SM0/SM1 推导，保证导入不丢信息。

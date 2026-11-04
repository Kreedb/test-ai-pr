# 设计预览

转换结果页自带只读预览，模型代码在 `src/lib/preview.js`，渲染组件在 `src/components/{EdaPreview,PreviewViewport,PcbPreview,SchematicPreview}.vue`。

## 功能

- 直接渲染中间模型里的 PCB 与原理图几何，不依赖第三方渲染库。
- 滚轮缩放、拖拽平移；PCB 与原理图共用一套视口交互。
- PCB 视图按空格键可绕板框中心水平镜像，模拟翻看板子背面。
- 搜索网络名、位号和 `REF.PIN`。
- PCB 图层可逐个开关或只显示一层。
- 选中网络后在 PCB 与原理图之间互相跳转，两侧同时高亮。
- 预览不回写任何数据，转换结果保持只读。

## 坐标与单位

- PCB 坐标是毫米、Y 向上；SVG 渲染时整体翻转一次，并用 `vector-effect="non-scaling-stroke"` 保持描边在任何缩放下都清晰。
- 原理图 Circuit JSON 的单位是 1/15 毫米（KiCad 写出器会乘以 15），所以缩放上限按屏幕像素每毫米表达，不能与 PCB 共用一个模型单位上限。
- 初始视野按板框外轮廓取景，而不是所有元素的并集：丝印文字和位号标签常落在板框外，按并集取景会把板子缩得很小。

## 图层

- 铜层列表只来自实际有几何的图层，不从过孔范围推导：EAGLE 会把通孔过孔写成 `1-16`，两层板不该出现十六个空复选框。
- 图层名先归一化再映射：KiCad 写作 `B.Cu`、`In1.Cu`，Circuit JSON/EAGLE 写作 `bottom`、`inner1`。

## 网络与交叉定位

- 交叉定位通过 `source_port_id` 连接 PCB 与原理图：`source_trace.connected_source_port_ids` → `pcb_port` / `schematic_port`。
- 网络按名称索引，不按 `source_net_id`：EAGLE 会合并同名网络，KiCad 通过全局标签连接。
- 高亮比较用元素上的普通网络名，不用模型内部的 `netKey`。

## 文字尺寸

- 原理图文字尺寸必须与 KiCad 写出器一致：组件自带的文字、走线文字与网络标签各有不同的尺寸路径。
- 没有尺寸信息的符号按写出器的 `size.height || 1` 回退值定位 Value。

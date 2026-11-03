# 代码结构

```
lib/sii-parser/            # 独立包：EtherCAT SII EEPROM 解析器（无依赖）
lib/eagle-to-circuit-json/ # 独立包：EAGLE XML -> Circuit JSON（fast-xml-parser）
lib/pads-to-circuit-json/  # 独立包：PADS Layout ASCII -> Circuit JSON（无依赖）
src/lib/esi.js             # ESI XML -> SII 生成器，以及 SII -> ESI XML 导出与回归校验
src/lib/editor.js          # 解析结果的可编辑模型：字符串/名称同步、列表增删、导出参数
src/lib/format.js          # 显示格式化与字段解析辅助函数
src/lib/download.js        # 浏览器下载辅助函数
src/lib/eda.js             # EDA -> KiCad 转换入口：上传限制、格式校验、结果封装
src/lib/eda-shared.js      # 转换器共享的错误、识别辅助、结果汇总与 KiCad 写出
src/lib/formats/           # 每种来源一个模块：元数据、有损说明、样例、识别与转换入口
src/lib/formats/index.js   # 显式格式注册表：支持矩阵、有损表与样例按钮的唯一来源
src/lib/archive.js         # zip 压缩包展开与成员筛选（大小/数量/嵌套限制）
src/lib/preview.js         # 只读预览模型：PCB/原理图几何、图层、网络索引与搜索（无 Vue 依赖）
src/lib/route-path.js      # hash 路径归一化与路由匹配（无 Vue 依赖，供路由与链接共用）
src/routes.js              # 按 src/pages/*Page.vue 自动收集路由、导航与首页工具卡片
src/router.js              # 极简 hash 路由（GitHub Pages 子路径下无需重写规则）
src/pages/                 # 导航页、解析器页、EDA 转换页
src/components/            # 可编辑表格、PDO、DC、十六进制视图、设计预览、格式支持与有损表
src/App.vue                # 页面外壳：品牌、导航、路由出口、页脚
public/samples/            # 示例 EEPROM 转储、ESI XML、Altium / Specctra / EAGLE / PADS 工程文件
```

## 依赖方向

`lib/` 下的包可以单独安装、单独调用，不依赖 Vue、`src/` 或主项目的路径别名。主项目通过 npm workspace 以包名导入它们：

```js
import { parseSii } from 'sii-parser'
import { eagleToCircuitJson } from 'eagle-to-circuit-json'
import { padsToCircuitJson } from 'pads-to-circuit-json'
```

`test/lib.test.mjs` 会检查每个包都有 `README.md` 与入口，并禁止包内代码导入 `@/` 或跳出包目录的相对路径。

## 扩展点

- 新增 EDA 来源：在 `src/lib/formats/` 下新建模块并在 `src/lib/formats/index.js` 加一行导入；支持矩阵、有损表、样例按钮和格式标签都会自动派生。
- 新增页面：在 `src/pages/` 下新建 `NamePage.vue` 并导出 `route`，路径与所有链接都会自动派生。
- 新增独立解析器：按 `lib/<name>/` 的结构新建包，再在主项目里按包名引用。

## 页面文档

- [应用外壳](../app/README.md)
- [EEPROM 解析器](../parser/README.md)
- [EDA 转 KiCad](../convert/README.md)

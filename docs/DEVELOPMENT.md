# 开发指南

convbin 是一个在浏览器中运行的二进制工具箱，当前包含 EtherCAT SII/ESI 与 EDA 格式转换工具，基于 Vite + Vue 3（Composition API，`<script setup>`）。所有数据只在本地处理，不会上传。

线上地址：https://kreedb.github.io/test-ai-web/

## 工具

导航页（`#/`）统一管理所有工具，后续新增的工具会继续挂在这里。

- [EEPROM 解析器](parser/README.md)（`#/parser`）
- [机器人包回放](replay/README.md)（`#/replay`）
- [EDA 转 KiCad](convert/README.md)（`#/convert`）

## 运行要求

- Node.js 20.19+ 或 22.12+
- npm 10+

## 本地启动

```bash
npm install
npm run dev
```

开发服务器运行在 http://localhost:5173/test-ai-web/，带热更新。`/test-ai-web/` 前缀来自[部署](#部署)里的 `base` 配置。

## 脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动带 HMR 的开发服务器 |
| `npm run build` | 构建到 `dist/`（构建前自动格式化） |
| `npm run preview` | 本地预览生产构建 |
| `npm test` | 运行 `node --test` 回归测试 |
| `npm run format` | 用 Prettier 格式化代码 |
| `npm run format:check` | 校验代码格式 |

## 路径别名

`@` 映射到 `src/`，在 `vite.config.js` 与 `jsconfig.json` 中同时配置：

```js
import { buildPreviewModel } from '@/lib/preview'
```

`lib/` 下的包通过 npm workspace 安装，用包名导入，不要写成 `@/lib/...`：

```js
import { parseSii } from 'sii-parser'
```

## 依赖说明

`package.json` 里的 `overrides` 把 `altiumts` 固定到 npm registry 版本，`.npmrc` 打开 `legacy-peer-deps`，两者都是为了让 tscircuit 这些依赖未声明完整的包能直接 `npm ci` 安装。

## 部署

站点发布在 GitHub Pages：https://kreedb.github.io/test-ai-web/。

部署由 `.github/workflows/deploy.yml` 处理：推送到 `main` 时自动运行，也可以在 Actions 页面手动触发（`workflow_dispatch`）。流程是 `npm ci`、`npm test`、`npm run build`（构建前会自动执行 `npm run format`），然后用 GitHub Pages 官方 actions 发布 `dist/`。

这是项目站点，路径带仓库名前缀，所以 `vite.config.js` 设置 `base: '/test-ai-web/'`，构建产物里的资源 URL 才能落在 `https://kreedb.github.io/test-ai-web/` 下。如果以后换成自定义域名或用户站点仓库，把 `base` 改回 `/`。

导航使用 hash 路由（`#/parser`），不需要服务端重写规则。本地预览生产构建：

```bash
npm run build
npm run preview
```

然后打开 http://localhost:4173/test-ai-web/。

构建会额外生成 `dist/sw.js`：它由 `build/offline.js` 在构建时写入，把本次构建的全部资源与解析器示例预缓存，页面在线加载过一次后即可断网重开。开发服务器不注册 Service Worker（注册代码只在生产构建里执行），离线行为要用 `npm run build` + `npm run preview` 验证。

`.github/workflows/pullfrog.yml` 由 Pullfrog 管理，标注了不要手改；新增 CI 或部署任务时另建 workflow 文件。

## 代码结构

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
src/lib/replay/rosbag.js   # ROS1 bag v2 读取（无 Vue 依赖）
src/lib/replay/mcap.js     # ROS2 MCAP 读取（无 Vue 依赖）
src/lib/replay/sqlite.js   # ROS2 sqlite3 (.db3) 只读解析（无 Vue 依赖）
src/lib/replay/bag.js      # ROS1 / ROS2 格式识别与统一读取入口
src/lib/replay/rosmsg.js   # 按消息定义解析 ROS1 / ROS2 消息（含 CDR）
src/lib/replay/profiles.js # 机型骨架、关节名映射与按机型识别
src/lib/replay/pose.js     # 骨架正运动学与四元数工具（无 Vue 依赖）
src/lib/replay/urdf.js     # URDF 解析与 STL 读取
public/robots/             # 预置机型 URDF（Luna / Oli / TRON2A）
src/lib/route-path.js      # hash 路径归一化与路由匹配（无 Vue 依赖，供路由与链接共用）
src/routes.js              # 按 src/pages/*Page.vue 自动收集路由、导航与首页工具卡片
src/router.js              # 极简 hash 路由（GitHub Pages 子路径下无需重写规则）
src/pages/                 # 解析器页、机器人回放页、EDA 转换页（首页在 App.vue）
src/components/            # 可编辑表格、PDO、DC、十六进制视图、设计预览、机器人骨架、格式支持与有损表
src/App.vue                # 页面外壳：品牌、导航、首页、路由出口、页脚
public/samples/            # 示例 EEPROM 转储、ESI XML、Altium / Specctra / EAGLE / PADS 工程文件
build/offline.js           # 构建时生成离线用 Service Worker（预缓存全部产物与解析器示例）
```

### 依赖方向

`lib/` 下的包可以单独安装、单独调用，不依赖 Vue、`src/` 或主项目的路径别名。主项目通过 npm workspace 以包名导入它们：

```js
import { parseSii } from 'sii-parser'
import { eagleToCircuitJson } from 'eagle-to-circuit-json'
import { padsToCircuitJson } from 'pads-to-circuit-json'
```

`test/lib.test.mjs` 会检查每个包都有 `README.md` 与入口，并禁止包内代码导入 `@/` 或跳出包目录的相对路径。

## 扩展点

- 新增 EDA 来源：在 `src/lib/formats/` 下新建 `<id>.js`，导出元数据、`losses`、`detect`、`convert`，然后在 `src/lib/formats/index.js` 的显式导入列表里加一行。支持矩阵、有损表、样例按钮和格式标签都从注册表派生，不需要改页面。
- 新增页面：在 `src/pages/` 下新建 `NamePage.vue`，在普通 `<script>` 块里导出 `route`（`label`、`order`，需要首页卡片时再加 `tool`）。路径由文件名自动生成，导航、路由出口和首页工具列表都从页面自身派生。
- 新增机器人型号：在 `public/robots/` 放一个 URDF，在 `src/lib/replay/profiles.js` 注册机型、关节顺序与名称映射。消息字段不同的厂商优先使用 bag 内嵌的消息定义；没有定义时在 `src/lib/replay/rosmsg.js` 补内置布局。
- 新增测试：按所属页面放到 `test/<page>/` 下（`parser`、`replay`、`convert`），跨页面的全功能测试放 `test/` 根目录；公共辅助函数也放在对应页面目录，但 `node --test` 会执行 `test/` 下的每个 `.js`/`.mjs`，所以辅助文件不能有顶层副作用。
- 新增可独立发布的解析器：在 `lib/<package-name>/` 下建立独立包（`package.json`、`src/index.js`、`README.md`），用包名在主项目里引用。`lib/` 不允许反向依赖 `src/`，由 `test/lib.test.mjs` 守护。

## 协作约定

以下约定用于减少多人并行开发时的合并冲突。

### 分支与提交

- 功能分支命名为 `feat/<简短描述>`、修复分支命名为 `fix/<简短描述>`，保持短生命周期。
- 合并前先 rebase 到最新的 `main`，不要用 merge commit 把主线历史带进功能分支。
- 提交信息使用 Conventional Commits，主题用中文，例如 `feat(convert): 增加 zip 压缩包解析`。
- 一个 PR 只处理一件事：一种新格式、一项界面调整或一次依赖升级。依赖与 lockfile 变更单独提交。
- 不要在功能 PR 里顺手做全文件格式化，否则会产生大量无意义冲突。

### 验证

```bash
npm ci
npm test
npm run build
```

格式不再由独立的 CI 检查：`npm run build` 会先自动执行 `npm run format`，需要单独校验时仍可运行 `npm run format:check`。

改动页面或模板后，再启动 `npm run dev` 并在浏览器里打开 `http://localhost:5173/test-ai-web/` 做一次冒烟检查。

### 样式与依赖

- 页面级样式优先写在组件的 `<style scoped>` 里；`src/assets/main.css` 只保留设计变量、基础排版和跨页面共用样式。
- 新增运行时依赖前先确认许可证与仓库的 GPL-3.0-only 兼容，并更新 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。
- 不要在 PR 中直接格式化 `package-lock.json`；需要升级时单独提交，并说明升级原因。

## 测试

测试使用 `node --test`，没有额外测试框架：

```bash
npm test
```

### 布局

- `test/parser/`：EEPROM 解析器（`#/parser`）的 SII 解析、编辑模型与 ESI 导出测试。
- `test/replay/`：机器人回放页（`#/replay`）的 bag 解析、机型识别与正运动学测试；`rosbag-fixture.mjs` 是共用样例辅助。
- `test/convert/`：EDA 转 KiCad（`#/convert`）的格式识别、转换、预览与注册表测试。
- `test/fixtures/`：转换器回归样例。
- `test/routes.test.mjs`：hash 路径归一化与匹配（全功能测试，保留在 `test/` 根目录）。
- `test/lib.test.mjs`：`lib/` 包的 README、入口与解耦约束。
- `test/offline.test.mjs`：离线 Service Worker 生成。

### 提速约定

- 同一个样例的转换结果用模块级 Promise 缓存复用，不要在多个测试里重复跑完整转换。Altium 样例单次转换就要 1–2 秒，重复调用是测试变慢的主因。
- 能异步就不要 `sleep`：等待转换、解压、文件读取时直接 `await` 对应的 Promise，不要用固定延时轮询。
- 纯函数优先直接测（解析器、预览模型、路径匹配），只有端到端路径才走 `convertEda`。
- 新增测试时先确认它测的是行为而不是实现细节；一个断言能覆盖的不要拆成多个转换。

## 页面文档

- [EEPROM 解析器](parser/README.md)
- [EDA 转 KiCad](convert/README.md)

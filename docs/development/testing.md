# 测试

测试使用 `node --test`，没有额外测试框架：

```bash
npm test
```

## 布局

- `test/archive.test.mjs`：zip 展开、大小/数量上限与成员筛选。
- `test/eagle.test.mjs`：EAGLE XML 识别、转换与镜像元件。
- `test/pads.test.mjs`：PADS ASCII 解析、转换与上游 fixture。
- `test/preview.test.mjs`：预览模型的几何、图层、网络与文字尺寸。
- `test/registry.test.mjs`：格式注册表元数据与样例文件存在性。
- `test/routes.test.mjs`：hash 路径归一化与匹配。
- `test/sii.test.mjs`：`sii-parser` 的样例解析、CRC 与畸形输入。
- `test/lib.test.mjs`：`lib/` 包的 README、入口与解耦约束。

## 提速约定

- 同一个样例的转换结果用模块级 Promise 缓存复用，不要在多个测试里重复跑完整转换。Altium 样例单次转换就要 1–2 秒，重复调用是测试变慢的主因。
- 能异步就不要 `sleep`：等待转换、解压、文件读取时直接 `await` 对应的 Promise，不要用固定延时轮询。
- 纯函数优先直接测（解析器、预览模型、路径匹配），只有端到端路径才走 `convertEda`。
- 新增测试时先确认它测的是行为而不是实现细节；一个断言能覆盖的不要拆成多个转换。

# 机器人包回放（`#/replay`）

读取 ROS1 bag 里的关节状态与 IMU 姿态，在浏览器里按时间轴还原机器人动作。
bag 不上传，解析与渲染都在本机完成。

## 输入

- ROS1 bag v2（`.bag`），最大 256 MiB。
- 数据块支持未压缩与 lz4；bz2 需要先用 `rosbag decompress` 转成未压缩或 lz4。
- 中断录制留下的 `.bag.active` / `.active` 不是完整 bag，需要先用 BagRepair 之类工具修复为 `.bag` 再导入。

## 自动识别的话题

| 用途 | 支持的消息类型 | 默认话题 |
| --- | --- | --- |
| 关节角度 | `controller_msgs/JointState`、`sensor_msgs/JointState` | `/joint/state`，其次 `/motor/state` |
| 底座姿态 | `controller_msgs/IMUData`、`sensor_msgs/Imu` | `/ImuData`，其次 `/imu/data`、`/imu` |

页面会列出 bag 里的全部话题，可以手动切换关节与 IMU 话题。时间轴使用 **bag 记录时间**，
不是消息头时间；同一时间戳有多条记录时保留最后一条，时间倒退的 bag 会直接报错而不是重排。

## 机型与骨架

内置 LimX Luna（HU_L04，27 关节）、Oli（HU_D04，31 关节）与 TRON2A（10 关节）三套骨架。
关节按名称映射；没有名称的 bag 按机型配置的硬件下标顺序映射。标准
`<left|right>_<hip|knee|ankle|shoulder|elbow|wrist>_<pitch|roll|yaw>_joint` 名称
可以落到通用人形骨架；未识别的名称仍会显示数值，但不会绘制 3D 姿态。

新增机型时在 `src/lib/replay/profiles.js` 加一个 profile（骨架节点、关节顺序），
不需要改页面或 3D 视图。骨架只保留关节偏移与转轴，不包含 STL/碰撞网格。

## 回放

- 空格：播放 / 暂停
- 左右方向键：暂停时单帧，播放时前后约 1 秒
- 进度条：拖动定位
- 鼠标拖动：旋转视角；滚轮：缩放；双击：复位
- 倍速 0.25× / 0.5× / 1× / 2×，可循环

## 已知边界

- 纯运动学显示：只写关节角与 IMU 底座姿态，不跑动力学，也不判断机器人是否真的站稳。
- 必须有一个受支持的 JointState 话题才能打开 bag；IMU 话题可选，只影响底座姿态。没有位置话题时底座固定在原点，不能复现真实行走轨迹与高度。
- 关节之间的数据缺口保持上一条记录并显示 `DATA GAP`，不会插值补动作。
- `/motor/state` 对 Luna / Oli 的并联踝、腰是电机空间角度，页面会提示它不等于串行关节角；需要精确姿态时优先用 `/joint/state`。
- 不解析日志、诊断信息、视频或点云，也不修改 bag。
- 骨架高度来自模型静止位姿，不是实测高度；模型与实机的安装偏差会直接反映在画面上。
- 未接入的厂商消息字段需要扩展 `src/lib/replay/rosbag.js` 的解码器，单加 profile 不够。

## 示例与测试

- 示例：`public/samples/replay/luna-demo.bag`，由 `test-support/rosbag-fixture.mjs` 生成的合成 Luna 动作，含 27 关节与 IMU。
- 回归测试：`test/replay.test.mjs`，覆盖 bag 解析、lz4 / 未压缩数据块、重复与倒退时间戳、机型识别、正运动学与示例文件。

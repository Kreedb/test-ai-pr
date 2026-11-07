# 机器人包回放（`#/replay`）

读取 ROS1 bag 与 ROS2 MCAP / sqlite3 bag 里的关节状态与 IMU 姿态，在浏览器里按时间轴还原机器人动作。
bag 不上传，解析与渲染都在本机完成。

## 输入

- ROS1 bag v2（`.bag`），最大 2 GiB。数据块支持未压缩与 lz4；bz2 需要先用 `rosbag decompress` 转成未压缩或 lz4。
- ROS2 MCAP（`.mcap`）与 sqlite3（`.db3`）。MCAP 数据块支持未压缩与 lz4；zstd 需要重新录制或解压。
  分片 bag 可以一次选择多个 `.mcap` / `.db3` 文件，消息按时间合并。ROS2 bag 目录可以直接打包成 `.zip` 拖入。
- 格式默认自动识别（文件头），也可以在导入卡片里手动切换为 ROS1 / ROS2 MCAP / ROS2 SQLite。
  选择与文件实际格式不一致时会明确报错，不会静默按错误布局解码。
- 中断录制留下的 `.bag.active` / `.active` 可以直接导入：页面按 BagRepair 的方式顺序扫描数据块，
  自动恢复截断前的完整消息并跳过尾部不完整的数据块。不重建索引，也不生成新的 `.bag`；
  尾部缺失的字节和未写完的最后一个压缩块无法找回。真正的文本 `.log.active` 不是 bag，不能打开。
- 文本日志（`.log` / `.txt`，最大 256 MiB）可以和 bag 一起拖入，也可以一次选多个或加载 bag 后再次选择。
  支持行内 `clk(秒)`、ROS 风格 `[epoch]` 和行首 `YYYY-MM-DD HH:MM:SS.mmm` 时间戳；
  多进程日志按时间排序，没有时间戳的续行并入上一条。页面保留全部日志条目，但 3D 视图下方只渲染
  当前时间附近约 2000 条的窗口，回放时滚动该窗口让对应日志保持在框中央。
  墙钟时间会同时按 UTC 和浏览器本地时区尝试，取与 bag 记录时间重叠的那个。
- URDF 可以随 bag 一起拖入，或单独上传；可同时选择同目录的 STL，也可以上传包含 URDF 与网格的 zip。

## 自动识别的话题

| 用途 | 支持的消息类型 | 默认话题 |
| --- | --- | --- |
| 关节角度 | `controller_msgs/JointState`、`sensor_msgs/JointState` | `/joint/state`，其次 `/motor/state` |
| 底座姿态 | `controller_msgs/IMUData`、`sensor_msgs/Imu` | `/ImuData`，其次 `/imu/data`、`/imu` |

ROS1 bag 与 MCAP 都内嵌消息定义，解码器按字段定义解析 `names` / `position` 或 `q`，不再依赖某个固定字节布局。
因此标准 `sensor_msgs/JointState` 走通用解析；LimX 的 `controller_msgs/JointState` 与 `controller_msgs/IMUData`
也由同一套通用读取器按其字段解析。页面会区分并提示“通用解析（标准 ROS 消息）”和“LimX 自定义消息”。
如果消息类型写着标准名称、字段却被改成 LimX 的 `q` / `quat`，会标记为“魔改字段”并继续按定义解析。
ROS2 sqlite3 的 `topics` 表不保存消息定义，已知类型会使用内置定义；未知的自定义类型需要先转成 MCAP 或补定义。

页面会列出 bag 里的全部话题，可以手动切换关节与 IMU 话题。时间轴使用 **bag 记录时间**，
不是消息头时间；同一时间戳有多条记录时保留最后一条，时间倒退的 bag 会直接报错而不是重排。

## 机型与骨架

预置骨架放在 `public/robots/`：Luna（`luna.urdf`，HU_L04，27 关节）、Oli（`oli.urdf`，HU_D04，31 关节）与
TRON2A（`tron2a.urdf`，10 关节）。Luna 的 URDF 直接来自
[luna-description](https://github.com/limxdynamics/luna-description)，引用其中的 STL。
关节按名称映射；没有名称的 bag 按机型配置的硬件下标顺序映射。标准
`<left|right>_<hip|knee|ankle|shoulder|elbow|wrist>_<pitch|roll|yaw>_joint` 名称
可以落到通用人形骨架；未识别的名称仍会显示数值，但不会绘制 3D 姿态。

页面支持上传自定义 URDF，也可以用“骨架 / URDF”下拉框强制选择预置机型。URDF 的
`origin xyz/rpy`、`axis` 与 fixed joint 都会参与正运动学；模型按连杆原点估算的静止位姿低于地面时会自动抬高到 z=0
（网格顶点不参与这个估算）。
勾选“加载 3D 模型”后会解析 URDF 引用的 STL（本机选择的文件优先，预置 Luna 从 luna-description 按需下载），
并按总三角形预算抽稀显示。`.dae` / `.obj` 暂不支持。

新增机型只需放一个 URDF 到 `public/robots/`，在 `src/lib/replay/profiles.js` 注册机型与关节顺序；
不需要把关节偏移写进 JavaScript，也不需要改页面或 3D 视图。

## 回放

- 空格：播放 / 暂停
- 左右方向键：暂停时单帧，播放时前后约 1 秒
- 进度条：拖动定位；关节与 IMU 波形图：在图表上拖动可快速定位异常点
- 全屏：3D 视图占满窗口，日志时间线固定在下方
- 鼠标拖动：旋转视角；滚轮：缩放；双击：复位
- 倍速 0.25× / 0.5× / 1× / 2×，可循环

## 已知边界

- 纯运动学显示：只写关节角与 IMU 底座姿态，不跑动力学，也不判断机器人是否真的站稳。
- 必须有一个受支持的 JointState 话题才能打开 bag；IMU 话题可选，只影响底座姿态。没有位置话题时底座固定在原点，不能复现真实行走轨迹与高度。
- 关节之间的数据缺口保持上一条记录并显示 `DATA GAP`，不会插值补动作。
- `/motor/state` 对 Luna / Oli 的并联踝、腰是电机空间角度，页面会提示它不等于串行关节角；需要精确姿态时优先用 `/joint/state`。
- 不解析 bag 内的 `/mrosout` 日志话题、视频或点云，也不修改 bag；日志对照只读取单独导入的文本文件。
- ROS2 sqlite3 bag 的 `topics` 表没有消息定义，只能按已知类型名选择内置字段布局；魔改字段请转存为 MCAP。
- MCAP 的 zstd 压缩块暂不支持；请重新录制为 lz4 / 未压缩。
- 3D 网格仅支持 STL；`.dae` / `.obj` 会提示跳过。预置 Luna 的 STL 需要联网按需下载，首次加载较慢。
- 日志与 bag 的时间基准不一致时（例如 bag 使用 epoch、日志只有 `clk`）无法自动对齐，页面会提示不重叠。
- 骨架高度来自模型静止位姿，不是实测高度；模型与实机的安装偏差会直接反映在画面上。
- 波形图最多渲染固定行数并为每行自动缩放，用于快速定位异常，不是精确的数值分析工具。

## 示例与测试

- 示例：`public/samples/replay/luna-demo.bag`，由 `test/replay/rosbag-fixture.mjs` 生成的合成 Luna 动作，含 27 关节与 IMU。
- 回归测试：`test/replay/replay.test.mjs` 覆盖 ROS1 bag 解析、lz4 / 未压缩数据块、重复与倒退时间戳、机型识别、正运动学与示例文件；
  `test/replay/ros2.test.mjs` 覆盖格式识别、MCAP / sqlite3、通用消息定义、URDF 与 STL。
- 社区测试包：<http://bashupload.app/pyc6lw.zip>（Luna ROS1 bag + 文本日志，约 78 MiB）。

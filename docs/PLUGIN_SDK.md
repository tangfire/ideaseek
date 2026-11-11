# IdeaSeek 插件 SDK 方向

插件是可选扩展，不是核心科研能力的替代品。核心能力来自论文证据、Protocol Synthesis Agent、通用数据/代码工具、实验调度和结果反馈。

## 可扩展点

- `PaperParser`：特殊论文/标注格式解析；
- `DatasetInspector`：数据字段、样本单位和质量探测；
- `SplitValidator`：领域切分和泄漏检查；
- `MetricProvider`：指标实现与统计汇总；
- `ExperimentAdapter`：把统一 `ExperimentSpec` 转为特定训练入口；
- `ResourceEstimator`：估算特殊任务的 CPU/GPU/内存/缓存需求；
- `ReportRenderer`：输出领域报告附录。

## 插件契约

每个插件声明：

- `plugin_id`、版本和兼容的 IdeaSeek API 版本；
- 提供的 capability 和 schema；
- 依赖、许可证和来源；
- 允许读取/写入的路径；
- 是否需要网络、GPU 或额外凭据；
- 输入/输出 hash 和可重建性；
- 测试、gold set 和已知限制。

插件输出必须是结构化对象或 artifact 引用，不能用自由文本改变工作流状态。插件不得覆盖原始数据、读取 secret、绕过 scheduler 或注册第二套 Agent Runtime。

## 用户开发插件

用户可以在自己的私有仓库开发实验室插件，先通过本地路径安装，再发布到内部 npm/Git 仓库。平台应在安装前显示权限和依赖，在运行前执行 `plugin doctor`，并把插件版本写入 run snapshot。插件失败时平台可以回退通用能力或进入明确阻塞，不应静默改变实验协议。

## 首发策略

Phase 0–6 不要求按方向实现多套插件。先完成领域无关的论文学习、协议综合、comparison、切片和 quick/standard 探索；遇到真实项目的特殊需求，再为该项目开发最小插件并加入 gold set。联邦学习模型异构、图像分割、短视频和多模态方向都只是验证样例或未来可选插件场景，不是 IdeaSeek 核心路线中的必做解析器。

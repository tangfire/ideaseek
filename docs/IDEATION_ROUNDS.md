# IdeaSeek 多轮 Idea 探索

同一个研究项目可以运行多轮 Idea 探索。用户过几天再次提出“继续想 idea”时，IdeaSeek 不会把原论文和数据当成新项目，也不会简单重复上一轮候选；它会创建新的 `IdeationRound`，复用不变的知识和实验 artifact，并把上一轮结果作为新一轮的上下文和约束。

## 轮次对象

```text
Project
  ├── InputSnapshot v1
  ├── KnowledgeSnapshot v1
  ├── ProtocolSnapshot v1
  ├── ComparisonSet v1
  ├── IdeationRound r1
  │    ├── Idea-001 / versions / experiments
  │    └── feedback / rejected reasons
  └── IdeationRound r2
       ├── inherited context references
       ├── novelty/diversity constraints
       └── new ideas and experiments
```

`IdeationRound` 记录输入 snapshot、知识/协议/comparison 版本、上一轮引用、用户指令、idea 数量、模型 route、预算和停止原因。旧 round 和 idea 不可覆盖。

## 重复输入时的行为

如果论文、数据、comparison、协议、模型和 prompt/schema 版本都没有变化：

1. 复用已有 PaperCard、研究地图、dataset card、baseline 结果和切片；
2. 读取上一轮 IdeaCard、最近邻结果、失败实验、消融和用户反馈；
3. 对已有候选做 canonical fingerprint 和语义近邻去重；
4. 把上一轮已验证/已否证的机制加入新一轮约束；
5. 要求新候选说明与旧 idea 的差异、未解决问题或新的可检验机制；
6. 只为新候选和受影响的实验创建任务；
7. 如果没有新的证据或可区分机制，诚实返回“没有足够新信息生成高质量新 idea”，而不是强行凑数量。

## 输入变化时

新论文、新数据集、新 comparison、用户反馈、协议或模型版本只使依赖图上的下游节点失效；没有变化时只创建新的 round，不重跑不相关节点。

## 用户命令

```bash
ideaseek ideate --round new --question "寻找与上一轮不同的机制"
ideaseek ideate --round new --ideas 3
ideaseek ideate --round r1 --continue
ideaseek rounds list
ideaseek rounds show r2
ideaseek feedback --idea idea-001 --label useful
```

新 round 不以“生成了几个文本候选”为成功标准，必须报告新增证据、候选差异、重复/近重复数量、用户反馈影响、预算和下一步实验。

export const PRODUCT_PROMPT_VERSIONS = {
  chapterAnalysis: "chapter-analysis-product-v1",
  storyBibleInterval: "story-bible-interval-product-v1",
  storyBibleFinal: "story-bible-final-product-v1",
  episodePlanning: "episode-local-plan-product-v1",
  episodeSkeleton: "episode-skeleton-product-v1",
  finishedNarrationBeat: "finished-narration-beat-product-v1",
  assetPromptDraft: "asset-prompt-draft-product-v1",
} as const;

export const PRODUCT_PROMPT_SET_VERSION = "narralume-product-prompts-v1";

export const PRODUCT_PROMPT_TITLES = {
  chapterAnalysis: "章节分析",
  storyBibleInterval: "全书世界观（区间整理）",
  storyBibleFinal: "全书世界观（全书归一）",
  episodePlanning: "逐集局部规划",
  episodeSkeleton: "旁白结构骨架",
  finishedNarrationBeat: "成片旁白",
  assetPromptDraft: "资产 Prompt 草稿",
} as const;

export const PRODUCT_PROMPTS = {
  chapterAnalysis: `你负责把小说章节转换为可追溯的结构化事件，不负责改写小说。
只提取对人物、因果、悬念、后续改编或视觉呈现有实际价值的内容；忽略不改变状态、关系、认知或行动结果的重复描写。
优先保留：人物目标和关键选择、选择的直接代价、关系变化、因果链、认知变化、规则或限制、骗局或误导、具体危险，以及可被画面呈现的人物、地点、器物和动作。
同一实体使用原文中最稳定的名称；别名和称呼写入 detail，不凭推测合并不同人物或物体。
第一人称只是叙事视角。除非原文明确，不要把“我”补写成姓名，也不要把主观判断改成客观事实。
选择与代价使用 causality；规则、骗局和认知变化使用 revelation；无法由现有类型准确表达时宁可省略，不新增字段。
每个事件只引用真正支持该事件的 evidenceId，不跨章、不伪造、不引用外部知识。`,
  storyBibleInterval: `你负责整理当前区间已经出现且有来源的稳定事实，不负责提前总结全书或创作新剧情。
归一人物、别名、地点、组织、器物和专有名词；区分人物在不同章节的状态、关系、目标和认知。
保留会影响后续改编的因果、规则、限制、未解决悬念、揭示条件和剧透边界。
把视觉一致性需要的稳定特征保留在现有实体 detail 中，但不要补写原文没有的年龄、外貌、服装或材质。
同一事实只保留一条最清楚的表达；冲突信息进入 confusingFacts，不自行裁决原文未裁决的矛盾。
只使用当前 interval 允许的 sourceEventIds 和 chapterIds。`,
  storyBibleFinal: `你负责对已验证 interval 全书世界观做全书级归一、去重和冲突整理，不重新阅读原文，也不创作新事实。
合并同一实体的别名和重复事实，保留状态随章节变化的顺序；不要把不同时期状态压成一个静态结论。
保留影响人物选择、关系、因果、悬念、剧透控制和视觉一致性的内容。
只能使用 interval 中已经存在的 sourceEventIds；无法由 interval 支持的内容不得补充。`,
  episodePlanning: `你只规划当前一个 Episode。章节范围和 sourceEventIds 已由程序与用户确认，不能移动、遗漏、跨集借用或重新分配。
根据当前集来源生成简洁标题、storyArc、必要的 recap 和一个与当前来源相符的 nextHook。
storyArc 应说明本集人物面临的核心处境、关键行动或选择以及产生的变化，不写空泛主题。
第一集或无需承接时 recap 返回 null；当前来源没有自然下集钩子时 nextHook 返回 null，不伪造悬念。
只输出运行合同允许的字段和来源 ID。`,
  episodeSkeleton: `你只规划当前 Episode 内的旁白 beats，不撰写正文。
按冻结来源顺序把所有 sourceIndexes 恰好分配一次；每个 beat 表达一个清楚的叙事推进目标。
优先在自然的行动、选择、发现、关系变化或场景变化处切分，不为追求平均长度打断完整因果或对话。
根据真实字符预算分配可选 targetDurationSeconds；总预算不得超过 Episode 目标时长。
开头 beat 负责尽快建立一个与原文相符的观看理由；结尾 beat 负责落在本集真实成立的变化或悬念上，但都不得凭空制造事实。`,
  finishedNarrationBeat: `你根据当前 beat 的冻结原文直接生成可配音的成片旁白，不生成“原著还原稿”，也不等待第二次整稿润色。
只陈述当前原文明确支持的事实，不补写外部设定、心理、动机、因果或结局。
保持原文叙事视角；只有书级提示词明确要求且不改变事实时，才调整讲述距离。
优先保留推动剧情、体现关系、揭示规则或改变认知的动作和关键对话；压缩重复描写，但不把具体过程压成百科总结。
使用自然、清楚、可朗读的中文口语。避免书面腔、宣传腔、空洞过渡句、重复问句和为填字数复述同一事实。
开头从具体问题、反常现象、关键选择、代价、冲突、认知反差、结果前置或必要前情中选择适用策略，不要求全部出现。
正文持续提供当前来源已有的新动作、新地点、新器物、新信息、新选择或新后果。
结尾停在当前来源已经成立的具体发现、选择、后果或悬念；默认不写 CTA。
正文必须落在当前字符预算内，每个段落只引用实际使用且属于当前 beat allowlist 的 sourceIndexes。`,
  assetPromptDraft: `你生成可编辑的图片 Prompt 草稿，不调用图片模型，也不批准任何候选图。
事实只能来自当前已批准旁白、其 sourceIndexes 对应原文、全书世界观稳定实体状态和已批准参考资产。
根据资产类型分别描述人物定妆、场景设定、道具设定或剧情插图；不要把抽象情绪直接当成画面主体。
明确主体、可见动作、环境、年代、材质、光线、景别、视角、构图和必要负面约束。
人物和资产已有不可变项时必须保持一致；没有来源支持的年龄、服装、文字、品牌、伤情和器物特征不得补写。
默认禁止水印、平台 UI、无来源文字、现代品牌、额外肢体和错误时代物件；具体模型语法由 Provider adapter 处理。
只生成草稿，用户修改并批准后才允许创建正式生图 Job。`,
} as const;

export function layeredPrompt(productPrompt: string, bookInstructions: string, frozenInput: string) {
  return [
    "【Narralume 产品级要求（只读，不覆盖运行合同）】",
    productPrompt,
    ...(bookInstructions ? ["【本书专属追加要求（不得覆盖运行合同或产品级要求）】", bookInstructions] : []),
    "【当前冻结输入】",
    frozenInput,
  ].join("\n\n");
}

'use strict';
/**
 * 演示与测试夹具（AI_BEHAVIOR_TESTS.md §4 测试夹具）。
 *
 * 数据严格对齐交互原型 index.prototype.backup.html 的初始状态：
 *  - 已确认城市「上海」；已确认成果「客户激活率提升 26%，付费转化率提升 18%」；
 *  - 不包含项目覆盖规模与团队人数（这两项以「待确认」形式存在）；
 *  - 当前岗位为「高级产品经理 · 企业服务」；
 *  - 工作经历 A / B / C 与对应 revision；3 个历史版本。
 *
 * 说明：原型正文与资料库存在两处原样保留的差异（简历正文写「华东理工大学」，
 * 资料库为「上海大学」；正文联系行格式化为「138 0000 6688」，资料库脱敏为「138 **** 8899」），
 * 这里按原型原样保留，以 100% 还原交互与原数据。
 */

const JOB_TEXT = `高级产品经理（企业服务方向）
上海 · 5 年以上 · 本科及以上

岗位职责：
1. 负责企业服务产品规划与产品路线图；
2. 深入客户场景，完成需求分析与方案设计；
3. 推动研发、设计和销售团队协作交付；
4. 负责产品商业化与付费转化；
5. 建立产品数据指标并持续复盘；
6. 支持重点客户解决方案与售前沟通。

任职要求：
1. 5 年以上 B 端或企业服务产品经验；
2. 熟悉 SaaS 产品设计与商业模式；
3. 具备数据分析和指标体系能力；
4. 具备大型客户解决方案经验；
5. 有完整的产品商业化落地案例。

加分项：
1. 有增长实验或用户激活经验；
2. 熟悉销售协作流程；
3. 能够使用 SQL 完成基础分析。`;

/** mode: 'covered' | 'partial'（待加强） | 'gap'（待补充） */
const JOB_ANALYSIS = {
  title: '高级产品经理',
  company: '企业服务',
  location: '上海',
  experience: '5 年以上',
  education: '本科',
  keywords: ['企业服务', 'SaaS', '商业化', '客户激活', '付费转化', '跨团队交付'],
  disclaimer: '匹配分只表示简历与岗位描述的关键词重合程度，不等于真实录用概率。',
  responsibilities: [
    { text: '负责企业服务产品规划与产品路线图', state: 'covered' },
    { text: '深入客户场景，完成需求分析与方案设计', state: 'covered' },
    { text: '推动研发、设计和销售团队协作交付', state: 'covered' },
    { text: '负责产品商业化与付费转化', state: 'covered' },
    { text: '建立产品数据指标并持续复盘', state: 'covered' },
    { text: '支持重点客户解决方案与售前沟通', state: 'partial' },
  ],
  must_have: [
    { text: '5 年以上 B 端或企业服务产品经验', state: 'covered' },
    { text: '熟悉 SaaS 产品设计与商业模式', state: 'covered' },
    { text: '具备数据分析和指标体系能力', state: 'covered' },
    { text: '具备大型客户解决方案经验', state: 'gap' },
    { text: '有完整的产品商业化落地案例', state: 'partial' },
  ],
  nice_to_have: [
    { text: '有增长实验或用户激活经验', state: 'covered' },
    { text: '熟悉销售协作流程', state: 'covered' },
    { text: '能够使用 SQL 完成基础分析', state: 'covered' },
  ],
  coverage: { covered: 8, total: 11 },
};

/** 个人资料库（已确认事实）。 */
const PROFILE_BASICS = {
  name: '陈知行',
  phone: '13800008899', // 资料库脱敏展示为 138 **** 8899
  email: 'chen.zhixing@example.com',
  city: '上海',
  current_title: '高级产品经理',
  years: 5,
  job_status: 'open_to_opportunities',
  summary:
    '5 年企业服务产品经验，聚焦 B 端 SaaS 与增长产品。擅长从复杂业务场景中提炼高价值需求，驱动跨职能团队完成从产品规划到商业化落地。',
};

/** 经历：description 使用换行分隔的 bullet（已确认事实）。 */
const EXPERIENCES = [
  {
    key: 'work-yunshan',
    type: 'work',
    organization: '云杉科技',
    title: '高级产品经理',
    start_date: '2022.06',
    end_date: '',
    is_current: 1,
    period_label: '2022.06—至今 · 企业服务 SaaS',
    description: [
      '完成 30+ 家客户深度访谈，形成核心场景与产品路线图。',
      '客户激活率提升 26%，付费转化率提升 18%。',
      '协同 15 人跨职能团队，准时交付率保持 95% 以上。',
    ].join('\n'),
  },
  {
    key: 'work-qinghe',
    type: 'work',
    organization: '青禾科技',
    title: '产品经理',
    start_date: '2020.07',
    end_date: '2022.05',
    is_current: 0,
    period_label: '2020.07—2022.05 · 增长产品',
    description: [
      '建设增长实验平台，支持市场团队完成 20+ 次策略实验。',
      '建立从实验设计到效果复盘的标准流程。',
    ].join('\n'),
  },
  {
    key: 'work-qiming',
    type: 'work',
    organization: '启明软件',
    title: '产品助理',
    start_date: '2019.07',
    end_date: '2020.06',
    is_current: 0,
    period_label: '2019.07—2020.06',
    description: ['参与需求整理、原型设计与版本验收。'].join('\n'),
  },
  {
    key: 'project-leads',
    type: 'project',
    organization: '企业线索智能分配项目',
    title: '产品负责人',
    start_date: '2023.03',
    end_date: '2023.09',
    is_current: 0,
    period_label: '产品负责人 · 2023.03—2023.09',
    description: ['设计线索评分模型，提升高价值线索触达效率。'].join('\n'),
  },
  {
    key: 'project-activation',
    type: 'project',
    organization: '客户激活增长项目',
    title: '核心成员',
    start_date: '2022.08',
    end_date: '2022.12',
    is_current: 0,
    period_label: '核心成员 · 2022.08—2022.12',
    description: ['参与激活路径分析与策略实验。'].join('\n'),
  },
  {
    key: 'education',
    type: 'education',
    organization: '上海大学',
    title: '信息管理与信息系统',
    start_date: '2016',
    end_date: '2020',
    is_current: 0,
    period_label: '',
    description: '本科',
  },
];

const SKILLS = ['产品规划', '用户研究', '数据分析', 'Axure', 'Figma', 'SQL', '企业服务 SaaS'];

/** 证书（资料库技能分组显示「7 项技能 · 2 个证书」）。 */
const CERTIFICATES = [
  {
    key: 'cert-npdp',
    type: 'certificate',
    organization: 'PDMA',
    title: 'NPDP 产品经理认证',
    start_date: '2021.05',
    end_date: '',
    is_current: 0,
    period_label: '2021.05 获得 · 有效期至 2024.05',
    description: '',
  },
  {
    key: 'cert-pmp',
    type: 'certificate',
    organization: 'PMI',
    title: 'PMP 项目管理认证',
    start_date: '2020.11',
    end_date: '',
    is_current: 0,
    period_label: '2020.11 获得',
    description: '',
  },
];

/** 当前简历草稿（中间画布正文，对应原型 HTML 的简历正文）。 */
const RESUME_DRAFT = {
  basics: {
    name: '陈知行',
    phone: '138 0000 6688',
    email: 'chen.zhixing@example.com',
    city: '上海',
  },
  headline: '高级产品经理',
  summary:
    '5 年企业服务产品经验，聚焦 B 端 SaaS 与增长产品。擅长从复杂业务场景中提炼高价值需求，驱动跨职能团队完成从产品规划到商业化落地。',
  experience: [
    {
      id: 'exp-yunshan',
      organization: '云杉科技（上海）有限公司',
      title: '高级产品经理',
      start: '2022.06',
      end: '',
      period_label: '2022.06 — 至今',
      bullets: [
        {
          id: 'bullet-planning',
          text: '主导企业协同 SaaS 产品从 0 到 1 规划，完成 30+ 家客户深度访谈，沉淀核心业务场景与版本路线图。',
        },
        {
          id: 'target-bullet',
          text: '推动线索管理与自动化工作流上线，使客户激活率提升 26%，付费转化率提升 18%。',
          ai_note: { suggestion: 'conversion', label: '建议突出转化' },
          scope_name: '@简历 · 付费转化成果',
        },
        {
          id: 'bullet-delivery',
          text: '协同 15 人跨职能团队推进产品交付，版本准时交付率稳定在 95% 以上。',
        },
      ],
    },
    {
      id: 'exp-xinghai',
      organization: '星海互联科技有限公司',
      title: '产品经理',
      start: '2020.07',
      end: '2022.05',
      period_label: '2020.07 — 2022.05',
      bullets: [
        {
          id: 'bullet-growth',
          text: '负责增长实验平台建设，支持市场团队完成 20+ 次策略实验，并建立从实验设计到效果复盘的标准流程。',
        },
      ],
    },
  ],
  projects: [
    {
      id: 'proj-leads',
      name: '企业线索智能分配项目',
      role: '产品负责人',
      start: '2023.03',
      end: '2023.09',
      period_label: '2023.03 — 2023.09',
      bullets: [
        {
          id: 'scale-bullet',
          text: '结合客户分层与销售行为数据设计线索评分模型，缩短首次跟进时间，并提升高价值线索触达效率。',
          ai_note: { suggestion: 'scale', label: '建议补充规模' },
          scope_name: '@简历 · 项目覆盖规模',
        },
      ],
    },
  ],
  education: [
    {
      id: 'edu',
      school: '华东理工大学',
      major: '信息管理与信息系统 · 本科',
      start: '2016',
      end: '2020',
      period_label: '2016 — 2020',
    },
  ],
  skills: SKILLS,
  generation_notes: [],
  validation_issues: [],
  layout_hints: { layout: 'classic', max_pages: 2 },
};

/** 历史版本（v1 为生成版本，v2 / v3 为主动保存）。 */
const VERSION_FIXTURES = [
  {
    key: 'v1',
    version_no: 1,
    kind: 'generated',
    name: '增长产品经理 · 初始版本',
    // 原型固定显示「8 月 28 日 20:16」：用绝对日期（去年 8 月 28 日），不随运行日期漂移
    fixed_date: { year_offset: -1, month: 8, day: 28, time: '20:16' },
    time: '20:16',
    template: '极简留白',
    template_key: 'minimal',
    job: '增长产品经理 · SaaS',
    advantage: '具备企业服务与增长产品经验，熟悉用户研究、增长实验和数据分析。',
    work: '建设增长实验平台，支持市场团队开展多轮策略实验并完成效果复盘。',
    project: '参与客户激活路径分析与策略实验，持续优化关键转化环节。',
    changes: ['首次整理个人经历', '优先选择增长相关项目', '生成单页简历'],
    list_summary: '第一次根据岗位信息生成',
    profile_data: '陈知行｜上海；云杉、青禾 2 段经历；1 个增长项目；用户研究、数据分析',
    job_data: '增长产品经理｜SaaS｜重点关注增长实验和数据分析',
    template_data: '极简留白｜单页排版',
    compare_note:
      '当前版本的目标岗位已从增长产品经理切换为高级产品经理，因此减少增长实验内容，增加企业服务、商业化和团队协作成果。',
  },
  {
    key: 'v2',
    version_no: 2,
    kind: 'manual',
    name: '高级产品经理 · 稳健表达',
    day_offset: 0,
    time: '14:32',
    template: '经典商务',
    template_key: 'classic',
    job: '高级产品经理 · 企业服务 SaaS',
    advantage: '5 年企业服务产品经验，熟悉 B 端 SaaS 产品规划、用户研究与跨团队协作。',
    work: '负责线索管理与自动化工作流设计，推动核心功能按计划上线。',
    project: '结合客户分层和销售行为数据设计线索评分模型，改善线索跟进效率。',
    changes: ['保留关系最强的工作经历', '减少未经量化的成果描述', '采用更稳健的表达'],
    list_summary: '保留核心经历，减少推断性表达',
    profile_data: '陈知行｜上海；3 段工作经历、2 个项目；项目覆盖规模尚未确认',
    job_data: '高级产品经理｜上海｜5 年以上；重点关注企业服务 SaaS',
    template_data: '经典商务｜单页排版',
    compare_note:
      '当前版本保留了这段经历，并补充客户激活率和付费转化率两个量化结果，表达也更加直接。',
  },
  {
    key: 'v3',
    version_no: 3,
    kind: 'manual',
    name: '高级产品经理 · 突出商业化成果',
    day_offset: 0,
    time: '15:48',
    template: '经典商务',
    template_key: 'classic',
    job: '高级产品经理 · 企业服务 SaaS',
    advantage:
      '5 年企业服务产品经验，聚焦 B 端 SaaS 与增长产品，擅长推动产品商业化与跨团队落地。',
    work: '推动线索管理与自动化工作流上线，使客户激活率提升 26%，付费转化率提升 18%。',
    project: '设计企业线索评分模型，提升高价值线索触达效率，并补充项目覆盖规模。',
    changes: ['更突出付费转化成果', '精简两条弱相关内容', '补充项目覆盖规模'],
    list_summary: '调整了个人优势和 2 条工作经历',
    profile_data:
      '陈知行｜上海；云杉、青禾、启明 3 段经历；线索智能分配等 2 个项目；产品规划、用户研究、SQL',
    job_data: '高级产品经理｜上海｜5 年以上；重点关注 SaaS、商业化、团队协作',
    template_data: '经典商务｜单页排版',
    compare_note: '',
    current: true,
  },
];

/** 岗位截图（3 张）与旧简历文件。 */
const JOB_INPUT_FILES = [
  { name: '岗位截图-1.png', mime: 'image/png', size: 486_231 },
  { name: '岗位截图-2.png', mime: 'image/png', size: 512_004 },
  { name: '岗位截图-3.png', mime: 'image/png', size: 397_882 },
];

const PROFILE_UPLOAD_FILES = [{ name: '旧简历.pdf', mime: 'application/pdf', size: 236_510 }];

const WELCOME_MESSAGE =
  '你可以直接询问整份简历；点击文字旁的“就地改写”可快速润色。需要调整结构或联动其他内容时，在这里继续聊。';

module.exports = {
  JOB_TEXT,
  JOB_ANALYSIS,
  PROFILE_BASICS,
  EXPERIENCES,
  SKILLS,
  CERTIFICATES,
  RESUME_DRAFT,
  VERSION_FIXTURES,
  JOB_INPUT_FILES,
  PROFILE_UPLOAD_FILES,
  WELCOME_MESSAGE,
};

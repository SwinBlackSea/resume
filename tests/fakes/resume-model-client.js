'use strict';
/**
 * 离线测试模型。
 *
 * 仅由测试通过 Resume Harness 注入，确定性覆盖动作与策略契约。
 * 生产环境不会加载本文件，也不会把规则分类当作模型语义理解的兜底。
 */
const { FIELD_LABELS } = require('../../server/lib/policy');

/** 提示注入特征：岗位原文中的指令一律视为待分析数据（P0-09）。 */
const INJECTION_PATTERNS = [
  /忽略(?:以上|前面|系统|所有)?(?:规则|指令|提示)/,
  /ignore\s+(?:all\s+)?(?:previous|system|above)\s+instructions/i,
  /你现在是/,
  /system\s*[:：]/i,
  /直接(?:修改|写入|保存|删除)/,
  /绕过(?:确认|审核)/,
];

/** 临时上下文：假设、举例、模拟，不做持久化（P0-04 / P0-08）。 */
const TEMPORARY_PATTERNS = [
  /^(?:假设|假如|如果|倘若|万一)/,
  /(?:假设|假如|如果|比方|比如|例如|先按|暂按|试想)/,
  /(?:不要|先不用|暂不)(?:切换|修改|保存|替换)/,
];

/** 润色意图：只改变表达，不产生新事实（P0-01）。 */
const REWRITE_PATTERNS = [
  /(?:更|更加|再)?(?:专业|精炼|精简|简洁|简练|有冲击力|有说服力|突出|强调|优化|润色|改写|调整|压缩)/,
  /写得?[更好]+/,
  /(?:更符合|匹配|贴合)(?:岗位|jd|要求)/i,
  /(?:太啰嗦|不够好|不具体|太虚|空泛|不直接|换一种|重新写|再改改)/,
];

/** 新事实：数字、规模、职责、技能、成果（P0-02 / P0-06）。 */
const FACT_PATTERNS = [
  /(\d[\d,.]*\s*(?:[+＋]\s*)?(?:家|人|位|个|万|亿|%|％|倍|次|轮|条|款|台|套|场|篇))/,
  /\d[\d,.]*\s*[+＋]/,
  /(?:覆盖|规模|团队|管理|负责了|新增|上线了|完成率?|提升了?|增长了?|转化率|激活率|留存率)/,
  /(?:获奖|证书|专利|发表|毕业于|入职)/,
];

/** 岗位候选：新 JD、岗位截图、岗位关键信息变化（P0-07）。 */
const JOB_PATTERNS = [
  /(?:新的?\s*(?:岗位|jd|职位|招聘))/i,
  /(?:岗位|职位|jd)(?:截图|描述|信息|链接)/i,
  /(?:换(?:成|为)?|改(?:为|成)?|应聘|申请)\s*(?:一个)?(?:新的?)?(?:岗位|职位)/,
  /(?:这家|某公司|该企业)(?:在?招|招聘)/,
];

/** 明确更正基础字段（P0-03）。 */
const FIELD_KEYWORDS = [
  { key: 'city', words: ['所在城市', '城市', 'base', '常驻'] },
  { key: 'phone', words: ['手机号', '手机', '电话', '联系电话'] },
  { key: 'email', words: ['邮箱', '邮件', 'e-mail', 'email'] },
  { key: 'name', words: ['姓名', '名字', '称呼'] },
  { key: 'current_title', words: ['当前职位', '当前岗位', '职位名称', '现任'] },
  { key: 'job_status', words: ['求职状态', '看机会状态'] },
];

/** 检查与评估：对已有内容做诊断，不改变资料（如「检查是否夸张」）。 */
const REVIEW_PATTERNS = [
  /(检查|评估|诊断|审(?:查|核)|体检|复查)/,
  /(是否|有没有|会不会)(夸张|过度|虚构|造假|夸大|问题)/,
  /(有(?:什么|哪些)|哪里)(问题|不足|缺点|风险|可改进)/,
  /(这样|这么)(?:写|表达)(?:行吗|可以吗|合适吗|对吗)/,
  /(?:你觉得|你认为)(?:呢|怎么样|如何)/,
];

/** 不能编造：要求直接写入来源不存在的数字（SYSTEM_PROMPT §7）。 */
const FABRICATION_PATTERNS = [
  /(?:不用确认|别问了|直接|就按|帮我)?(?:写成|改成|编(?:一个)?|造(?:一个)?|填(?:上)?)\s*\d/,
  /不需要(?:确认|证据)/,
];

/** 段落数量属于表达结构，不是业绩数字或新增事实。 */
const STRUCTURE_REWRITE_PATTERNS = [
  /(?:分成?|拆成?|改成|整理成|写成|变成|调整为|划分为)\s*(?:\d+|[一二三四五六七八九十两]+)\s*(?:个)?(?:自然段|段落|段|部分)/,
  /(?:段落|自然段).{0,8}(?:分成?|拆成?|改成|整理成|调整为)\s*(?:\d+|[一二三四五六七八九十两]+)/,
  /(?:保留|只要|控制在)\s*(?:\d+|[一二三四五六七八九十两]+)\s*(?:个)?(?:自然段|段落|段)/,
];

function isStructuralRewriteInstruction(text) {
  return STRUCTURE_REWRITE_PATTERNS.some((pattern) => pattern.test(String(text || '')));
}

/**
 * 从用户消息中识别明确的字段更正。
 * 支持「把我的所在城市从上海改成杭州」「邮箱改为 a@b.com」等表达。
 */
function detectFieldUpdate(text) {
  for (const { key, words } of FIELD_KEYWORDS) {
    for (const word of words) {
      // 「从 X 改成 Y」或「改成 Y」
      const fromTo = new RegExp(
        `${word}(?:从[^，。、\\s]{0,20})?(?:改成|改为|修改为|换成|更新为|设为|设为|是)\\s*([^\\s，。；]+)`,
      );
      const match = text.match(fromTo);
      if (match && match[1]) return { field: key, value: match[1] };
    }
  }
  return null;
}

/** 从消息中提取数字型事实的简短描述（尽量只保留「数字 + 单位 + 对象」）。 */
function extractFact(text) {
  const numeric = text.match(
    /(\d[\d,.]*\s*(?:[+＋]\s*)?(?:家|人|位|个|万|亿|%|％|倍|次|轮|条|款|台|套|场|篇)[^，。；\s]{0,8})/,
  );
  if (numeric) return numeric[1].trim();
  const plus = text.match(/(\d[\d,.]*\s*[+＋][^，。；\s]{0,12})/);
  if (plus) return plus[1].trim();
  const generic = text.match(/([^，。；\s]{2,16}(?:覆盖了|负责了|完成了|提升了|参与了)[^，。；\s]{0,16})/);
  return generic ? generic[1] : text.slice(0, 30);
}

/** 推断事实标签与字段路径，便于左侧资料按字段归类。 */
function inferFactMeta(text) {
  if (/(?:家|个)?(?:付费)?客户|用户/.test(text) && /覆盖|规模|服务|触达/.test(text))
    return { label: '项目覆盖规模', field_path: 'scale' };
  if (/(?:团队|管理|带)\s*\d|\d+\s*人/.test(text))
    return { label: '团队人数', field_path: 'team_size' };
  if (/(?:%|％|转化率|激活率|留存率|增长率|提升|增长)/.test(text))
    return { label: '业绩成果', field_path: 'achievement' };
  if (/(?:证书|获奖|专利|发表)/.test(text))
    return { label: '证书与荣誉', field_path: 'certificate' };
  if (/(?:演讲|宣讲|路演|场次|会议|沙龙|参展)/.test(text))
    return { label: '市场活动', field_path: 'market_activity' };
  return { label: '新增事实', field_path: 'fact' };
}

/**
 * 规则分类：把用户消息映射为结构化动作（SYSTEM_PROMPT §4、§7）。
 * @param {object} input {text, scope, messageId, jobText, profileBasics}
 */
function classify(input) {
  const { text, scope, messageId, jobText = '' } = input;
  const evidence = messageId ? [messageId] : [];
  const structuralRewrite = isStructuralRewriteInstruction(text);

  // 1. 提示注入：忽略，只作为数据分析（P0-09）
  if (INJECTION_PATTERNS.some((re) => re.test(jobText))) {
    return {
      actions: [{ type: 'NO_OP', requires_confirmation: false, reason: '岗位原文含指令性文本，已忽略' }],
      reply: '我只会把岗位内容当作待分析的资料，其中的指令不会被执行。你可以继续针对这份岗位提问。',
      uncertainty: [],
    };
  }

  // 2. 临时上下文（假设 / 举例 / 明确不要切换）
  if (TEMPORARY_PATTERNS.some((re) => re.test(text))) {
    const fabrication = FABRICATION_PATTERNS.some((re) => re.test(text));
    return {
      actions: [{ type: 'TEMPORARY_CONTEXT', requires_confirmation: false, reason: '假设性讨论，不持久化' }],
      reply: fabrication
        ? '这类数字只用于本次讨论，我不会把它写进简历或资料；真实数据需要你确认来源后才能保存。'
        : '已按临时假设理解，个人资料、当前岗位和简历正文都不会改变。',
      uncertainty: [],
    };
  }

  // 3. 不能编造：要求直接写入无来源的量化事实
  if (!structuralRewrite && FABRICATION_PATTERNS.some((re) => re.test(text)) && !/\d/.test(text.slice(0, 0))) {
    if (/(?:写成|改成|编|造|填)\s*\d/.test(text)) {
      return {
        actions: [{ type: 'NO_OP', requires_confirmation: false, reason: '缺少可验证来源，不能编造' }],
        reply: '没有可验证来源的数字我不能写入简历或资料。如果你确实有这个数据，告诉我它来自哪段经历，我先记为待确认。',
        uncertainty: ['该数值缺少来源'],
      };
    }
  }

  // 4. 明确更正基础字段
  const fieldUpdate = detectFieldUpdate(text);
  if (fieldUpdate) {
    return {
      actions: [
        {
          type: 'PROFILE_FIELD_UPDATE',
          target_type: 'profile_basics',
          field_path: fieldUpdate.field,
          payload: { field: fieldUpdate.field, value: fieldUpdate.value, explicit: true },
          requires_confirmation: false, // 由后端策略决定是否直接执行
          explicit: true,
          evidence_ids: evidence,
          reason: '用户明确更正基础字段',
        },
      ],
      reply: `已收到「${FIELD_LABELS[fieldUpdate.field] || fieldUpdate.field}」的更正，正在校验并更新；更新结果会在下方回执中展示。`,
      uncertainty: [],
    };
  }

  // 5. 新岗位候选
  if (JOB_PATTERNS.some((re) => re.test(text))) {
    return {
      actions: [
        {
          type: 'JOB_CANDIDATE',
          target_type: 'target_job',
          payload: { raw_text: text.slice(0, 200) },
          requires_confirmation: true,
          evidence_ids: evidence,
          reason: '识别到新的岗位信息，需要确认后才替换当前岗位',
        },
      ],
      reply: '我识别到一个新岗位。确认之后才会替换当前岗位，并重新分析匹配情况；当前简历不会自动重写。',
      uncertainty: [],
    };
  }

  // 6. 新事实候选
  if (!structuralRewrite && FACT_PATTERNS.some((re) => re.test(text))) {
    return {
      actions: [
        {
          type: 'FACT_CANDIDATE',
          target_type: 'profile_experience',
          field_path: inferFactMeta(text).field_path,
          payload: {
            label: inferFactMeta(text).label,
            value: extractFact(text),
            proposed_value: extractFact(text),
            raw_text: text.slice(0, 200),
          },
          requires_confirmation: true,
          evidence_ids: evidence,
          confidence: 0.62,
          reason: '用户提供了可能的新事实，需确认后进入可靠事实库',
        },
      ],
      reply: '这看起来是一段新的事实。我先放进待确认；你确认后才会写入个人资料，并据此生成简历修改方案。',
      uncertainty: ['需要确认该事实归属的具体经历'],
    };
  }

  // 6a. 用户指出缺少数据，但尚未提供真实数值：先追问，不生成空洞的新建议。
  if (scope && scope.type === 'RESUME_BLOCK' && /没有数据|数据不足|没数据|缺少数据|数据支撑/.test(text)) {
    return {
      actions: [{ type: 'NO_OP', requires_confirmation: false, reason: '需要补充可验证数据后再改写' }],
      reply: '这版表达可以继续保留。请告诉我可验证的规模或结果数据；我会先让你确认，再沿用这一版补充。',
      uncertainty: ['这段经历有哪些可验证的规模或结果数据？'],
    };
  }

  // 7. 检查与评估：基于已有内容给出诊断结论，不修改任何资料
  if (REVIEW_PATTERNS.some((re) => re.test(text))) {
    return {
      actions: [
        {
          type: 'NO_OP',
          requires_confirmation: false,
          reason: '检查类请求：只给结论，不产生写入',
          review: true,
        },
      ],
      reply: '', // 由策略层结合真实简历内容生成
      uncertainty: [],
      needs_review_reply: true,
    };
  }

  // 8. 表达润色
  if (structuralRewrite || REWRITE_PATTERNS.some((re) => re.test(text))) {
    return {
      actions: [
        {
          type: 'RESUME_REWRITE_PROPOSAL',
          target_type: scope && scope.type === 'RESUME_BLOCK' ? 'resume_block' : 'resume_document',
          target_id: (scope && scope.id) || null,
          payload: { intent: text.slice(0, 120) },
          requires_confirmation: true,
          evidence_ids: evidence,
          reason: '只改变表达，不新增事实',
        },
      ],
      reply: '我会保留原有事实和数字，只调整表达方式。方案在下方，你点击应用后才会替换正文。',
      uncertainty: [],
    };
  }

  // 9. 意图不明确：不猜测执行，只追问（fail-closed）
  return {
    actions: [{ type: 'NO_OP', requires_confirmation: false, reason: '意图不明确' }],
    reply: '我想先确认一下：你希望我修改哪一部分？可以选择中间简历的具体内容，或直接说明要补充什么资料。',
    uncertainty: ['未识别到明确意图'],
  };
}

/** 生成完整结构化响应。所有出口都通过同一 Schema 形状。 */
function generateResponse(input) {
  const { text, scope, messageId, jobText, profileBasics, profileRevision } = input;
  const classified = classify({ text, scope, messageId, jobText, profileBasics });
  // 为 PROFILE_FIELD_UPDATE 附带 expected_revision（P0-14 冲突检测）
  const actions = classified.actions.map((action) =>
    action.type === 'PROFILE_FIELD_UPDATE'
      ? { ...action, expected_revision: profileRevision }
      : action,
  );
  return {
    reply: classified.reply,
    needs_review_reply: Boolean(classified.needs_review_reply),
    scope: {
      type: (scope && scope.type) || 'RESUME_DOCUMENT',
      id: (scope && scope.id) || null,
      revision: (scope && scope.revision) || null,
    },
    actions,
    evidence: messageId ? [{ id: messageId, type: 'message' }] : [],
    uncertainty: classified.uncertainty || [],
  };
}

/** Resume Harness 测试接口。生产环境不会加载这个确定性模型。 */
async function generate({ input }) {
  const text = String((input && input.text) || '');
  if (/30\+从方案论证/.test(text)) {
    const question = '“30+”具体指什么数量？请补充单位或对象，例如“30+次方案论证”。';
    return {
      output: {
        reply: question,
        scope: input.scope,
        actions: [{ type: 'NO_OP', requires_confirmation: false, reason: '测试模型需要澄清' }],
        evidence: [],
        uncertainty: [question],
      },
      provider: 'test',
      model: 'resume-test-model',
    };
  }
  return {
    output: generateResponse(input),
    provider: 'test',
    model: 'resume-test-model',
  };
}

module.exports = {
  generate,
};

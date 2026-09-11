'use strict';
/**
 * 岗位分析（TECH §9.1 阶段一、PRD §6.3）。
 * 输入确认后的岗位文本，输出职责、必需能力、优先能力与关键词。
 * 分析结果不建立逐句证据映射；匹配分不等于真实录用概率（明示）。
 */
const { uuidv7 } = require('./util');

const RESPONSIBILITY_HINTS = ['负责', '职责', '参与', '推动', '协助', '支持', '主导', '搭建', '建设'];
const MUST_HAVE_HINTS = ['要求', '年以上', '熟悉', '精通', '具备', '掌握', '经验'];
const NICE_TO_HAVE_HINTS = ['优先', '加分', '更佳', '加分项', '优先考虑'];

/** 常见技能关键词表（用于关键词抽取与匹配）。 */
const KEYWORD_LEXICON = [
  '企业服务', 'SaaS', 'B 端', 'B端', '产品规划', '产品路线图', '需求分析', '方案设计',
  '商业化', '付费转化', '客户激活', '增长', '用户研究', '数据分析', '指标体系', 'SQL',
  '跨团队', '项目管理', '销售协作', '解决方案', '售前', '原型', 'Axure', 'Figma',
  '线索', '激活率', '转化率', '留存', '增长实验', 'A/B', '团队管理', '客户服务',
];

function splitSentences(text) {
  return String(text)
    .split(/\n+/)
    .flatMap((line) => line.split(/[。；;]/))
    .map((item) => item.replace(/^[\s\-•·*\d.、]+/, '').trim())
    .filter((item) => item.length >= 4);
}

/**
 * @param {string} text 已确认的岗位文本
 * @returns {object} JobAnalysis
 */
function analyzeJobText(text) {
  const sentences = splitSentences(text);
  const responsibilities = [];
  const mustHave = [];
  const niceToHave = [];
  const others = [];

  sentences.forEach((sentence) => {
    const item = { id: uuidv7(), text: sentence };
    if (NICE_TO_HAVE_HINTS.some((hint) => sentence.includes(hint))) niceToHave.push(item);
    else if (RESPONSIBILITY_HINTS.some((hint) => sentence.includes(hint))) responsibilities.push(item);
    else if (MUST_HAVE_HINTS.some((hint) => sentence.includes(hint))) mustHave.push(item);
    else others.push(item);
  });

  // 最少保证结构完整：无明确分类时按数量分配
  if (!responsibilities.length && others.length) responsibilities.push(others.shift());
  if (!mustHave.length && others.length) mustHave.push(others.shift());

  const keywords = [];
  KEYWORD_LEXICON.forEach((keyword) => {
    if (text.includes(keyword) && !keywords.includes(keyword)) keywords.push(keyword);
  });

  const titleMatch = text.match(/([^\s，。]{2,20}(?:产品经理|工程师|设计师|专员|主管|经理|总监|分析师|顾问))/);
  const companyMatch = text.match(/([^\s，。]{2,30}(?:科技有限公司|有限公司|股份有限公司|公司|集团))/);
  const cityMatch = text.match(/(北京|上海|广州|深圳|杭州|成都|南京|武汉|西安|苏州|厦门|天津|重庆)/);
  const experienceMatch = text.match(/(\d\s*[-—~至]\s*\d\s*年|\d\s*年以上|\d\s*年)/);
  const educationMatch = text.match(/(博士|硕士|研究生|本科|大专|学历)/);

  return {
    title: titleMatch ? titleMatch[1] : '',
    company: companyMatch ? companyMatch[1] : '',
    location: cityMatch ? cityMatch[1] : '',
    experience: experienceMatch ? experienceMatch[1] : '',
    education: educationMatch ? educationMatch[1] : '',
    responsibilities,
    must_have: mustHave,
    nice_to_have: niceToHave,
    keywords,
    disclaimer: '匹配分只表示简历与岗位描述的关键词重合程度，不等于真实录用概率。',
    analyzed_at: new Date().toISOString(),
  };
}

/**
 * 匹配度分析：把岗位要求与已确认事实比对，输出覆盖状态。
 * @returns {{score:number, covered:number, total:number, requirements:Array, missing:Array}}
 */
function matchJobWithProfile(analysis, factTexts = []) {
  const corpus = factTexts.join('\n');
  const requirements = [
    ...(analysis.responsibilities || []).map((item) => ({ ...item, group: 'responsibilities' })),
    ...(analysis.must_have || []).map((item) => ({ ...item, group: 'must_have' })),
    ...(analysis.nice_to_have || []).map((item) => ({ ...item, group: 'nice_to_have' })),
  ];

  const evaluated = requirements.map((requirement) => {
    const tokens = KEYWORD_LEXICON.filter((keyword) => requirement.text.includes(keyword));
    const hitCount = tokens.filter((token) => corpus.includes(token)).length;
    let state = 'gap';
    if (tokens.length && hitCount === tokens.length) state = 'covered';
    else if (hitCount > 0) state = 'partial';
    else if (!tokens.length) {
      // 无关键词可比对时，按整句字面重合判断
      state = corpus && requirement.text.slice(0, 8) && corpus.includes(requirement.text.slice(0, 8))
        ? 'covered'
        : 'gap';
    }
    return { ...requirement, state, matched_keywords: tokens.filter((t) => corpus.includes(t)) };
  });

  const total = evaluated.length || 1;
  const covered = evaluated.filter((item) => item.state === 'covered').length;
  const partial = evaluated.filter((item) => item.state === 'partial').length;
  const score = Math.round(((covered + partial * 0.5) / total) * 100);
  const missing = evaluated.filter((item) => item.state !== 'covered').map((item) => item.text);

  return { score, covered, total: evaluated.length, requirements: evaluated, missing, disclaimer: analysis.disclaimer };
}

module.exports = { analyzeJobText, matchJobWithProfile, KEYWORD_LEXICON };

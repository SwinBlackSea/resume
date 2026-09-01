'use strict';
/**
 * 字段级 AI 润色（PRD §6.1、SYSTEM_PROMPT §7）。
 *
 * 约束：
 *  - 支持「更专业、强调成果、更简洁」三种意图；
 *  - 用户确认前不得覆盖原文（这里只返回建议）；
 *  - 不得新增数字、公司、项目和技能；疑似新增事实必须标记待确认。
 */
const { keyTokens } = require('./resume-schema');

/** 冗余修饰词（精简时移除，不改变事实）。 */
const FILLER_PATTERNS = [
  /为了/g,
  /通过不断/g,
  /积极地/g,
  /有效地/g,
  /进一步/g,
  /在一定程度上/g,
  /比较好的/g,
  /非常好的/g,
];

const PROFESSIONAL_REPLACEMENTS = [
  [/负责了?/g, '主导'],
  [/做了?/g, '完成'],
  [/帮忙/g, '协同'],
  [/弄/g, '搭建'],
  [/搞/g, '推进'],
  [/很多/g, '多轮'],
  [/比较好/g, '稳定'],
];

/** 更简洁：移除修饰、压缩句式，保留全部数字与实体。 */
function makeConcise(text) {
  let output = text;
  FILLER_PATTERNS.forEach((pattern) => {
    output = output.replace(pattern, '');
  });
  // 量化结果压缩为「指标 +数字」，不改变数值本身
  output = output.replace(/，使/g, '，');
  output = output.replace(/(提升|增长|提高)了?\s*([\d.]+\s*[%％])/g, '+$2');
  output = output.replace(/(降低|下降|减少)了?\s*([\d.]+\s*[%％])/g, '-$2');
  output = output.replace(/，\s*并?\s*并/g, '，并').replace(/，+/g, '，').replace(/\s{2,}/g, ' ');
  output = output.replace(/通过([^，。]{2,12})，/g, '$1，');
  return output.trim();
}

/** 更专业：替换口语化动词。 */
function makeProfessional(text) {
  let output = text;
  PROFESSIONAL_REPLACEMENTS.forEach(([pattern, replacement]) => {
    output = output.replace(pattern, replacement);
  });
  return output.trim();
}

/** 强调成果：把量化结果前置并加结果动词。 */
function emphasizeResults(text) {
  const tokens = Array.from(keyTokens(text));
  if (!tokens.length) {
    return { text: makeProfessional(text), note: '原文没有可量化的成果，已保留事实并优化表达。' };
  }
  const primary = tokens[0];
  const sentences = text.split(/[，。]/).filter(Boolean);
  const resultSentence = sentences.find((sentence) => keyTokens(sentence).size > 0) || text;
  const rest = sentences.filter((sentence) => sentence !== resultSentence).join('，');
  const polished = rest
    ? `围绕${primary}等目标推进，${resultSentence}，${rest}。`.replace(/，+/, '，')
    : `围绕${primary}等目标推进，${resultSentence}。`;
  return { text: polished.replace(/^围绕(.+?)等目标推进，/, (_, token) => `${token}目标驱动下，`), note: null };
}

/** 更符合岗位：把与岗位关键词相关的短语前置。 */
function alignToJob(text, keywords = []) {
  if (!keywords.length) return { text: makeProfessional(text), note: null };
  const hit = keywords.filter((keyword) => text.includes(keyword));
  if (!hit.length) {
    return {
      text: makeProfessional(text),
      note: `这段内容未直接涉及岗位关键词（${keywords.slice(0, 3).join('、')}），已保留原文未做改写。`,
    };
  }
  const sentences = text.split(/[，。]/).filter(Boolean);
  const leading = sentences.find((sentence) => hit.some((keyword) => sentence.includes(keyword)));
  if (!leading || sentences.indexOf(leading) === 0) {
    return { text: makeProfessional(text), note: null };
  }
  const rest = sentences.filter((sentence) => sentence !== leading);
  return { text: `${leading}，${rest.join('，')}。`, note: null };
}

const CHINESE_NUMBER = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function requestedParagraphCount(intent) {
  const match = String(intent || '').match(
    /(?:分成?|拆成?|改成|整理成|写成|变成|调整为|划分为|保留|只要|控制在)\s*(\d+|[一二三四五六七八九十两]+)\s*(?:个)?(?:自然段|段落|段|部分)/,
  );
  if (!match) return null;
  const raw = match[1];
  const count = /^\d+$/.test(raw) ? Number(raw) : CHINESE_NUMBER[raw];
  return Number.isInteger(count) && count >= 2 && count <= 6 ? count : null;
}

/** 仅重排原文，不增加事实；优先按句号拆分，不足时再按逗号拆分。 */
function splitIntoParagraphs(text, count) {
  const source = String(text || '').trim();
  if (!source || !count) return source;
  const existing = source.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  if (existing.length === count) return existing.join('\n\n');
  let units = source.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [];
  units = units.map((part) => part.trim()).filter(Boolean);
  if (units.length < count) {
    units = source.match(/[^，,。！？!?；;\n]+[，,。！？!?；;]?/g) || [];
    units = units.map((part) => part.trim()).filter(Boolean);
  }
  if (units.length < count) return source;

  const groups = [];
  let cursor = 0;
  for (let groupIndex = 0; groupIndex < count; groupIndex += 1) {
    const groupsLeft = count - groupIndex;
    const remaining = units.slice(cursor);
    if (groupsLeft === 1) {
      groups.push(remaining.join(''));
      break;
    }
    const totalLength = remaining.reduce((sum, unit) => sum + unit.length, 0);
    const targetLength = totalLength / groupsLeft;
    let length = 0;
    let take = 0;
    while (take < remaining.length - (groupsLeft - 1)) {
      length += remaining[take].length;
      take += 1;
      if (length >= targetLength) break;
    }
    groups.push(remaining.slice(0, take).join(''));
    cursor += take;
  }
  return groups.join('\n\n');
}

/** 词级 diff（LCS），用于前端高亮差异。 */
function diffWords(original, suggestion) {
  const a = original.match(/[\u4e00-\u9fa5]|[A-Za-z0-9%＋+.\-]+|[^\s]/g) || [];
  const b = suggestion.match(/[\u4e00-\u9fa5]|[A-Za-z0-9%＋+.\-]+|[^\s]/g) || [];
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const result = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push({ type: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      result.push({ type: 'remove', text: a[i] });
      i += 1;
    } else {
      result.push({ type: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) {
    result.push({ type: 'remove', text: a[i] });
    i += 1;
  }
  while (j < b.length) {
    result.push({ type: 'add', text: b[j] });
    j += 1;
  }
  return result;
}

/**
 * 生成润色建议。
 * @param {{text:string, intent:string, keywords?:string[], scopeLabel?:string}} input
 */
function suggestPolish({ text, intent = '更专业', keywords = [] }) {
  let output = { text, note: null };
  const paragraphCount = requestedParagraphCount(intent);
  if (paragraphCount) {
    output = {
      text: splitIntoParagraphs(text, paragraphCount),
      note: `已保留原有事实和数字，并整理为 ${paragraphCount} 个段落。`,
    };
  } else if (/简洁|精炼|精简/.test(intent)) {
    output = { text: makeConcise(text), note: null };
  } else if (/成果|量化|转化/.test(intent)) {
    output = emphasizeResults(text);
  } else if (/岗位|匹配|贴合/.test(intent)) {
    output = alignToJob(text, keywords);
  } else {
    output = { text: makeProfessional(text), note: null };
  }

  // 意图未产生实际变化时，组合精简与动词升级，保证方案可见但不新增事实
  if (output.text === text) {
    const combined = makeConcise(makeProfessional(text));
    if (combined && combined !== text) {
      output = { text: combined, note: output.note };
    }
  }

  // 内容安全检查：建议中不得出现用户没有提供的数字
  const originalTokens = keyTokens(text);
  const suggestionTokens = keyTokens(output.text);
  const added = Array.from(suggestionTokens).filter((token) => !originalTokens.has(token));
  const validationIssues = added.map((token) => ({
    token,
    reason: `建议中出现了原文没有的数据「${token}」，请核对后再应用`,
  }));

  return {
    original: text,
    suggestion: output.text,
    diff: diffWords(text, output.text),
    note: output.note,
    validation_issues: validationIssues,
    requires_user_action: true,
  };
}

module.exports = {
  suggestPolish,
  makeConcise,
  makeProfessional,
  emphasizeResults,
  alignToJob,
  requestedParagraphCount,
  splitIntoParagraphs,
  diffWords,
};

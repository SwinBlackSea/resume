'use strict';
/**
 * 离线测试模型：只用于确定性验证 Harness → Policy → Domain 链路。
 * 生产环境完全依赖模型语义理解，不加载这些测试分支。
 */
const {
  suggestPolish,
  requestedParagraphCount,
  splitIntoParagraphs,
} = require('../../server/lib/polish');

function proposal(input, suggestion, note = '') {
  const original = String(input.currentText || '');
  return {
    type: 'RESUME_REWRITE_PROPOSAL',
    target_type: input.scope.type,
    target_id: input.scope.id || null,
    requires_user_action: true,
    payload: {
      proposal: {
        original,
        suggestion,
        note,
      },
    },
  };
}

function detectProfileSave(text) {
  const fields = [
    ['city', /(?:所在城市|城市|常驻)(?:改成|改为|更新为|是)\s*([^\s，。；]+?)(?=并|且|，|。|；|$)/],
    ['phone', /(?:手机号|手机|电话)(?:改成|改为|更新为|是)\s*([^\s，。；]+?)(?=并|且|，|。|；|$)/],
    ['email', /(?:邮箱|email)(?:改成|改为|更新为|是)\s*([^\s，。；]+?)(?=并|且|，|。|；|$)/i],
    ['name', /(?:姓名|名字)(?:改成|改为|更新为|是)\s*([^\s，。；]+?)(?=并|且|，|。|；|$)/],
    ['current_title', /(?:当前职位|当前岗位)(?:改成|改为|更新为|是)\s*([^\s，。；]+?)(?=并|且|，|。|；|$)/],
  ];
  for (const [field, pattern] of fields) {
    const matched = text.match(pattern);
    if (matched) return { field, value: matched[1] };
  }
  return null;
}

function buildOutput(input) {
  const text = String(input.text || '');
  const base = String(input.editingBase || input.currentText || '');
  const actions = [];

  if (input.scope.type === 'RESUME_BLOCK') {
    const paragraphCount = requestedParagraphCount(text);
    let suggestion = '';
    let note = '';
    if (paragraphCount) {
      suggestion = splitIntoParagraphs(base, paragraphCount);
      note = `已整理为 ${paragraphCount} 个段落。`;
    } else if (/写进|补充|加入|加上/.test(text) && /\d/.test(text)) {
      suggestion = `${base.replace(/[。；;]?$/, '')}，${text.replace(/^(?:把|将)?/, '').replace(/(?:写进|补充到|加入|加上).*/, '').trim()}。`;
      if (suggestion === base || suggestion.includes('，。')) suggestion = `${base}\n${text}`;
    } else if (/专业|精炼|精简|简洁|优化|改写|有说服力|突出|调整/.test(text)) {
      const polished = suggestPolish({ text: base, intent: text, keywords: [] });
      suggestion = polished.suggestion;
      note = polished.note || '';
      if (suggestion === base) {
        suggestion = base.includes('，')
          ? base.replace('，', '；')
          : base.endsWith('。')
            ? base.slice(0, -1)
            : `${base}。`;
      }
    }
    if (suggestion && suggestion !== base) actions.push(proposal(input, suggestion, note));
  }

  if (input.scope.type === 'RESUME_DOCUMENT' && /新增|添加|增加/.test(text) && /海外经历/.test(text)) {
    const contentMatch = text.match(/内容[：:]\s*([\s\S]+)/);
    const content = contentMatch ? contentMatch[1].trim() : '请在这里填写海外经历';
    actions.push({
      type: 'RESUME_REWRITE_PROPOSAL',
      target_type: input.scope.type,
      target_id: null,
      requires_user_action: true,
      payload: {
        proposal: {
          original: '',
          suggestion: '新增“海外经历”模块',
          note: '模块和内容均作为动态简历节点写入。',
          operations: [
            {
              op: 'insert_node',
              parent_id: 'resume-root',
              after_node_id: 'section-education',
              node: {
                id: 'section-overseas',
                type: 'element',
                tag: 'section',
                attributes: { class: 'resume-section' },
                label: '海外经历',
                children: [
                  {
                    id: 'section-overseas-title',
                    type: 'element',
                    tag: 'h2',
                    text: '海外经历',
                    editable: true,
                    label: '模块标题',
                  },
                  {
                    id: 'overseas-content-1',
                    type: 'element',
                    tag: 'p',
                    text: content,
                    editable: true,
                    label: '海外经历内容',
                  },
                ],
              },
            },
          ],
        },
      },
    });
  }

  const profile = detectProfileSave(text);
  if (profile && /保存|资料|更新/.test(text)) {
    actions.push({
      type: 'PROFILE_SAVE_PROPOSAL',
      target_type: 'profile_basics',
      target_id: input.workspace.profile.id || null,
      requires_user_action: true,
      payload: {
        operation: 'update_basics',
        values: { [profile.field]: profile.value },
      },
    });
  }

  if (/设为当前岗位|切换当前岗位/.test(text)) {
    const jobText = text.match(/岗位(?:内容|描述)?[：:]\s*([\s\S]+)/);
    if (jobText) {
      actions.push({
        type: 'JOB_SET_CURRENT_PROPOSAL',
        target_type: 'target_job',
        target_id: null,
        requires_user_action: true,
        payload: { title: '新岗位', company: '', confirmed_text: jobText[1].trim() },
      });
    }
  }

  return {
    reply: actions.length
      ? '我已根据你的意思准备好建议，确认相应操作后才会写入。'
      : '我理解了你的要求；如果要修改正文，请先选择具体内容，或明确说明要保存到资料的字段。',
    scope: input.scope,
    actions,
    uncertainty: [],
  };
}

async function generate({ input }) {
  return {
    output: buildOutput(input),
    provider: 'test',
    model: 'resume-test-model',
  };
}

module.exports = { generate };

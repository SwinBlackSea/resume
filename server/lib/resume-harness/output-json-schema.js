'use strict';

/**
 * DeepSeek strict structured output 要求对象 properties 与 required 完全一致。
 * 全局修改列表与约束直接结构化，只有开放字段的单个节点或完整重构
 * 使用短 JSON 字符串，不再把整份 proposal 二次序列化为巨大字符串。
 */
const DATA_ACTION_SCHEMA = {
  anyOf: [{
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['JOB_SET_CURRENT_PROPOSAL'] },
      target_id: { type: ['string', 'null'] },
      payload: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          company: { type: 'string' },
          confirmed_text: { type: 'string', minLength: 1,
            description: '本次建议采用的完整岗位描述，不能省略或只返回岗位标题。' },
        },
        required: ['title', 'company', 'confirmed_text'],
        additionalProperties: false,
      },
    },
    required: ['type', 'target_id', 'payload'],
    additionalProperties: false,
  }, {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['PROFILE_SAVE_PROPOSAL'] },
      target_id: { type: ['string', 'null'] },
      payload: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: ['name', 'phone', 'email', 'city', 'current_title', 'job_status'] },
          value: { type: 'string', minLength: 1 },
        },
        required: ['field', 'value'],
        additionalProperties: false,
      },
    },
    required: ['type', 'target_id', 'payload'],
    additionalProperties: false,
  }],
};

const GLOBAL_RESPONSE_SCHEMA = {
  name: 'resume_assistant_response_v3',
  schema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['message', 'proposal'],
        description: 'message仅自然语言沟通，resume_proposal必须null且data_actions必须为空；任何简历、资料或岗位建议均用proposal，包括仅建议设置岗位而尚未生成正文。' },
      content: { type: 'string' },
      awaiting_user: { type: 'boolean',
        description: '仅message可为true；proposal固定false，待用户应用的确认由界面负责。' },
      message_kind: { type: ['string', 'null'],
        description: 'proposal固定null；message可描述沟通类型。' },
      quick_replies: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['id', 'label', 'description'],
          additionalProperties: false,
        },
      },
      resume_proposal: {
        anyOf: [{
        type: 'object',
        properties: {
          asset_requests: {
            type: 'array', maxItems: 8,
            description: '把本任务附件的原图片或裁剪区域嵌入目标 img；无图片操作时为空。不要输出图片URL或字节。',
            items: {
              type: 'object',
              properties: {
                input_image_id: { type: 'string' },
                target_node_id: { type: 'string' },
                purpose: { type: 'string', enum: ['portrait', 'image'] },
                crop: { anyOf: [{ type: 'null' }, {
                  type: 'object',
                  properties: {
                    x: { type: 'number', minimum: 0, maximum: 1 },
                    y: { type: 'number', minimum: 0, maximum: 1 },
                    width: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
                    height: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
                  },
                  required: ['x', 'y', 'width', 'height'], additionalProperties: false,
                }] },
              },
              required: ['input_image_id', 'target_node_id', 'purpose', 'crop'], additionalProperties: false,
            },
          },
          changes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                target_id: { type: 'string' },
                replacement_json: { type: ['string', 'null'] },
              },
              required: ['target_id', 'replacement_json'],
              additionalProperties: false,
            },
          },
          insertions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                parent_id: { type: 'string' },
                after_id: { type: ['string', 'null'] },
                new_nodes_json: { type: 'array', items: { type: 'string' } },
              },
              required: ['parent_id', 'after_id', 'new_nodes_json'],
              additionalProperties: false,
            },
          },
          target_document_json: { type: ['string', 'null'] },
          change_constraints: {
            type: 'object',
            properties: {
              content: { type: 'string', enum: ['preserve', 'modify'] },
              structure: { type: 'string', enum: ['preserve', 'modify'] },
              style: { type: 'string', enum: ['preserve', 'modify'] },
              content_order: { type: 'string', enum: ['preserve', 'reorder'] },
              allowed_region_ids: { type: 'array', items: { type: 'string' } },
            },
            required: ['content', 'structure', 'style', 'content_order', 'allowed_region_ids'],
            additionalProperties: false,
          },
        },
        required: ['asset_requests', 'changes', 'insertions', 'target_document_json', 'change_constraints'],
        additionalProperties: false,
        }, { type: 'null' }],
      },
      data_actions: {
        type: 'array',
        description: '只提供本轮确实需要且尚未完成的资料或岗位变更；历史存在岗位不代表每轮都要再次设置。无本轮变更时为空。',
        items: DATA_ACTION_SCHEMA,
      },
    },
    required: [
      'type',
      'content',
      'awaiting_user',
      'message_kind',
      'quick_replies',
      'resume_proposal',
      'data_actions',
    ],
    additionalProperties: false,
  },
};

const INLINE_RESPONSE_SCHEMA = {
  name: 'resume_inline_response',
  schema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['message', 'proposal'] },
      content: { type: 'string' },
      handoff: { type: ['boolean', 'null'] },
      suggestion: { type: ['string', 'null'] },
      summary: { type: ['string', 'null'] },
    },
    required: ['type', 'content', 'handoff', 'suggestion', 'summary'],
    additionalProperties: false,
  },
};

const DOCUMENT_SEMANTIC_RESPONSE_SCHEMA = {
  name: 'resume_document_semantics',
  schema: {
    type: 'object',
    properties: {
      reading_order: {
        type: 'array',
        items: { type: 'string' },
      },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title_block_id: { type: ['string', 'null'] },
            block_ids: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['title_block_id', 'block_ids'],
          additionalProperties: false,
        },
      },
      layout: {
        type: 'object',
        properties: {
          columns: { type: 'integer', enum: [1, 2] },
          main_column_ratio: { type: 'number', minimum: 0.5, maximum: 1 },
          visual_style: { type: 'string' },
        },
        required: ['columns', 'main_column_ratio', 'visual_style'],
        additionalProperties: false,
      },
      uncertain_block_ids: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['reading_order', 'sections', 'layout', 'uncertain_block_ids'],
    additionalProperties: false,
  },
};

module.exports = {
  GLOBAL_RESPONSE_SCHEMA,
  DATA_ACTION_SCHEMA,
  INLINE_RESPONSE_SCHEMA,
  DOCUMENT_SEMANTIC_RESPONSE_SCHEMA,
};

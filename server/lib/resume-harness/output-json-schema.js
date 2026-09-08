'use strict';

/**
 * DeepSeek strict structured output 要求对象 properties 与 required 完全一致。
 * 全局修改列表与约束直接结构化，只有开放字段的单个节点或完整重构
 * 使用短 JSON 字符串，不再把整份 proposal 二次序列化为巨大字符串。
 */
const GLOBAL_RESPONSE_SCHEMA = {
  name: 'resume_assistant_response_v2',
  schema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['message', 'proposal'] },
      content: { type: 'string' },
      awaiting_user: { type: 'boolean' },
      message_kind: { type: ['string', 'null'] },
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
        required: ['changes', 'insertions', 'target_document_json', 'change_constraints'],
        additionalProperties: false,
        }, { type: 'null' }],
      },
      data_actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['PROFILE_SAVE_PROPOSAL', 'JOB_SET_CURRENT_PROPOSAL'] },
            target_type: { type: ['string', 'null'] },
            target_id: { type: ['string', 'null'] },
            payload_json: { type: 'string' },
          },
          required: ['type', 'target_type', 'target_id', 'payload_json'],
          additionalProperties: false,
        },
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
  INLINE_RESPONSE_SCHEMA,
  DOCUMENT_SEMANTIC_RESPONSE_SCHEMA,
};

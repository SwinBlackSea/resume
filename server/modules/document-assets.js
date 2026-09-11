'use strict';
const db = require('../lib/db');
const { problem } = require('../lib/util');
const { readDocumentAsset, prepareUploadImages } = require('../lib/document-assets');

const routes = [
  { method: 'GET', pattern: '/document-assets/:id/content', raw: true,
    handler: ({ params, user, res }) => {
      const image = readDocumentAsset(params.id, user.id);
      res.writeHead(200, { 'content-type': image.mime_type, 'content-length': image.buffer.length,
        'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'" });
      res.end(image.buffer);
      return { __handled: true };
    } },
  { method: 'POST', pattern: '/projects/:id/image-candidates',
    handler: async ({ params, body, user }) => {
      const conversation = db.get(`SELECT id FROM ai_conversations WHERE id = ? AND project_id = ?
        AND owner_id = ? AND status = 'active'`, [body.conversation_id, params.id, user.id]);
      if (!conversation) throw problem.notFound('当前对话不存在');
      if (typeof body.upload_id !== 'string') throw problem.badRequest('请选择图片或简历附件');
      const candidates = await prepareUploadImages(body.upload_id,
        { ownerId: user.id, projectId: params.id, conversationId: conversation.id });
      return { candidates: candidates.map((item) => ({ ...item,
        url: `/api/v1/document-assets/${item.asset_id}/content` })) };
    } },
];
module.exports = { routes };

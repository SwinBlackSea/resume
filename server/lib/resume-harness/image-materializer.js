'use strict';
const ResumeDom = require('../../../resume-dom');
const { materializeTargetFragments, materializeTargetDocument } = require('./target-fragments');

async function materializeImages(response, input, signal, diagnostics) {
  const errors = [];
  for (const [index, action] of (response.actions || []).entries()) {
    if (action.type !== 'RESUME_REWRITE_PROPOSAL') continue;
    const proposal = action.payload?.proposal || action.payload;
    const requests = proposal.asset_requests || [];
    if (!requests.length) continue;
    try {
      if (!Array.isArray(requests) || requests.length > 8 || !input.asset_authorization?.ownerId) {
        throw new Error('图片声明超过数量限制或缺少授权上下文');
      }
      const ownerId = input.asset_authorization.ownerId;
      // Pure harness/comparison runs must not load business persistence. The
      // server supplies authorization; only an actual asset operation resolves
      // its resource service (tests may inject an in-memory equivalent).
      const assets = input.asset_service || require('../document-assets');
      const base = input.workspace.resume.proposal_content || input.workspace.resume.content;
      const emptyFragments = proposal.target_resume_fragments
        && !(proposal.target_resume_fragments.changes || []).length
        && !(proposal.target_resume_fragments.insertions || []).length;
      const target = emptyFragments ? ResumeDom.toResumeDocument(base) : proposal.target_resume_fragments
        ? materializeTargetFragments(base, proposal.target_resume_fragments).document
        : materializeTargetDocument(base, proposal.target_resume_document);
      const nodes = new Set();
      const candidates = new Map((input.image_sources || []).map((item) => [item.input_image_id, item]));
      const additions = [];
      for (const request of requests) {
        signal?.throwIfAborted();
        if (!request || Object.keys(request).sort().join(',') !== 'crop,input_image_id,purpose,target_node_id'
          || !['portrait', 'image'].includes(request.purpose) || nodes.has(request.target_node_id)) {
          throw new Error('图片声明字段无效或同一目标重复插图');
        }
        const candidate = candidates.get(request.input_image_id);
        if (!candidate) throw new Error('图片不在本轮任务可用材料内，请使用输入中提供的 input_image_id');
        if (candidate.reference_only) throw new Error('这张图片仅供理解排版，不能复制为正文图片或求职者照片');
        if (request.purpose === 'portrait' && ['layout', 'job'].includes(candidate.material_role)) {
          throw new Error('岗位或排版参考不授权采用其中人像，请使用个人材料中的照片');
        }
        const find = (node) => node.id === request.target_node_id ? node
          : (node.children || []).map(find).find(Boolean);
        const node = find(target.root);
        if (!node || node.tag !== 'img') throw new Error('图片目标必须是目标文档中真实存在的 img 节点');
        nodes.add(request.target_node_id);
        const asset = await assets.cropImage(candidate, request.crop, ownerId);
        signal?.throwIfAborted();
        node.attributes = { ...(node.attributes || {}), src: asset.url,
          'data-document-asset-id': asset.id,
          alt: node.attributes?.alt || (request.purpose === 'portrait' ? '求职者照片' : '简历图片') };
        delete node.editable;
        additions.push(asset);
      }
      const byId = new Map([...(target.assets || []), ...additions].map((asset) => [asset.id, asset]));
      target.assets = [...byId.values()];
      assets.validateDocumentAssets(target, ownerId);
      proposal.target_resume_document = target;
      delete proposal.target_resume_fragments;
      delete proposal.asset_requests;
    } catch (error) {
      if (signal?.aborted) throw error;
      diagnostics.push({ action_index: index, code: 'DOCUMENT_IMAGE_INVALID', errors: [error.message] });
      errors.push(`actions[${index}] 的图片无法应用：${error.message}`);
    }
  }
  return errors;
}
module.exports = { materializeImages };

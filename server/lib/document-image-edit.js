'use strict';
const ResumeDom = require('../../resume-dom');
const { problem } = require('./util');
const { canReplaceImage } = require('../../resume-image-edit');

function replaceDocumentImage(document, nodeId, asset, ownerId) {
  const before = ResumeDom.toResumeDocument(document);
  if (!canReplaceImage(before, nodeId)) {
    throw problem.unprocessable('IMAGE_REPLACEMENT_UNAVAILABLE',
      '这里只支持更换独立图片；整页扫描背景请通过 AI 调整或提供独立照片');
  }
  const next = ResumeDom.toResumeDocument(before);
  const visit = (node) => {
    if (node.id === nodeId) {
      node.attributes = { ...(node.attributes || {}), src: asset.url, 'data-document-asset-id': asset.id };
      // A previous source set must not override the newly selected src.
      delete node.attributes.srcset;
    }
    (node.children || []).forEach(visit);
  };
  visit(next.root);
  const service = require('./document-assets');
  const references = service.referencedAssetIds(next.root);
  next.assets = [...(next.assets || []).filter(item => item.id !== asset.id && (
    !service.assetIdFromUrl(item.url) || references.has(item.id)
  )), asset];
  service.validateDocumentAssets(next, ownerId);
  return next;
}
module.exports = { replaceDocumentImage };

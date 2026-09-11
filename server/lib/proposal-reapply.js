'use strict';
const { gzipSync, gunzipSync } = require('node:zlib');
const { hashJson } = require('./util');
const FORMAT = 'resume-reapply-gzip-v1';

// Kept only with a global suggestion in the current conversation. It is not
// another draft or an undo step; new-chat cleanup removes it with its action.
function retainReapply(proposal) {
  if (proposal.reapply_material || !proposal.base_resume_json || !proposal.target_resume_document) return;
  const pair = { base: proposal.base_resume_json, target: proposal.target_resume_document };
  proposal.reapply_material = { format: FORMAT, digest: hashJson(pair),
    data: gzipSync(JSON.stringify(pair)).toString('base64') };
}
function readReapply(proposal) {
  if (proposal.base_resume_json && proposal.target_resume_document) {
    return { base: proposal.base_resume_json, target: proposal.target_resume_document };
  }
  const material = proposal.reapply_material;
  if (!material || material.format !== FORMAT) return null;
  const pair = JSON.parse(gunzipSync(Buffer.from(material.data, 'base64'), {
    maxOutputLength: 32 * 1024 * 1024,
  }).toString('utf8'));
  if (hashJson(pair) !== material.digest || !pair.base || !pair.target) throw new Error('建议内容校验失败');
  return pair;
}
module.exports = { retainReapply, readReapply };

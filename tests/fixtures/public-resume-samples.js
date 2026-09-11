'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const R = require('../../resume-dom');
const { parseDocx } = require('../../server/lib/document-recognition/docx');
const { parsePdf } = require('../../server/lib/document-recognition/pdf');
const { extractPageScene } = require('../../server/lib/document-recognition/page-scene');
const { normalizeSemantic } = require('../../server/lib/document-recognition/semantic-analyzer');
const { buildContentCandidate } = require('../../server/lib/document-recognition/candidates');

// Public files are downloaded explicitly into a temporary directory, not
// committed or fetched during the default test suite. Pin bytes for replay.
const samples = [
  { file: 'harvard-bullet.docx', sha256: 'acb7d106b353c2910561e93789a41682536b868bc59c2d885c9aeb5de236ebe4',
    url: 'https://cdn-careerservices.fas.harvard.edu/wp-content/uploads/sites/161/2025/09/2025-template_bullet.docx' },
  { file: 'harvard-paragraph.docx', sha256: '80bf4205a9cb74f55af2ed1a0f433bc544922ad70c5881f04f624cccad3a9438',
    url: 'https://cdn-careerservices.fas.harvard.edu/wp-content/uploads/sites/161/2025/09/2025-template_paragraph.docx' },
  { file: 'harvard-sample.pdf', sha256: '05acebff40db2781a30242459ce0470b675f2a0e7ab5012429137ce0229aae7b',
    url: 'https://cdn-careerservices.fas.harvard.edu/wp-content/uploads/sites/161/2026/07/resume-sample.pdf' },
  { file: 'mit-samples.pdf', sha256: '820b9551cee8c7476b964251d4405e22ae3df6439552b02be3577c9a264d80d6',
    url: 'https://cdn.uconnectlabs.com/wp-content/uploads/sites/123/2021/08/sampe-resumes-capd.pdf' },
];
async function publicDocuments(t) {
  const directory = process.env.RESUME_NODE_SAMPLE_DIR;
  if (!directory) return [];
  const results = [];
  for (const sample of samples) {
    const file = path.join(directory, sample.file);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (digest !== sample.sha256) throw new Error(`公开样本内容变化：${sample.file}`);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-sample-parse-'));
    t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
    const format = path.extname(file).slice(1);
    const parsed = format === 'docx'
      ? await parseDocx(file, { workDir, convertPreview: false })
      : await parsePdf(file, { workDir });
    const blocks = parsed.blocks || parsed.pages.flatMap((page) => page.blocks);
    const pages = parsed.pages || parsed.document.pages;
    const input = { blocks, pages, format, nativeDocument: parsed.document,
      semantic: normalizeSemantic({}, blocks) };
    // Actual file parsers and document projection, no fabricated resume text.
    // Model semantic recognition quality is outside this +/- regression.
    results.push({ name: sample.file, document: R.toResumeDocument(buildContentCandidate(input).resume_json) });
    if (format === 'pdf') {
      input.pageScene = await extractPageScene(file, workDir);
      results.push({ name: `${sample.file}/fixed-layout`,
        document: R.toResumeDocument(buildContentCandidate(input).resume_json) });
    }
  }
  return results;
}
module.exports = { samples, publicDocuments };

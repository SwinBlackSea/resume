'use strict';
// Re-render saved synthetic outputs without another model call. This separates
// visible content, layout, editability and application mechanics.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('node:child_process');
const { FACTS, geometry } = require('../../tests/fixtures/full-resume-comparison');
const R = require('../../resume-dom');

async function main() {
  const directory = path.resolve(process.argv[2] || '');
  assert.ok(directory.startsWith(path.resolve('.runtime/ai-comparison') + path.sep), '仅复核隔离测试产物');
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8'));
  assert.ok(path.resolve(report.temporary_database).startsWith('/tmp/resume-test-'));
  const source = new DatabaseSync(report.temporary_database, { readOnly: true });
  const initial = source.prepare(`SELECT v.resume_payload, p.id FROM resume_projects p
    JOIN resume_versions v ON p.id=v.project_id WHERE p.name LIKE '请直接制作中文简历%'
    AND v.kind='generated' ORDER BY p.created_at`).all();
  const initialProjects = source.prepare(`SELECT id FROM resume_projects
    WHERE name LIKE '请直接制作中文简历%' ORDER BY created_at`).all();
  const initialById = new Map(initial.map(r => [r.id, JSON.parse(r.resume_payload)]));
  const intakeEntries = report.entries.filter(e => e.scenario === 'link-and-image-intake');
  const documents = new Map();
  intakeEntries.forEach((e, i) => {
    const doc = initialById.get(initialProjects[i]?.id);
    if (doc) documents.set(e.key, doc);
  });
  source.close();
  process.env.RESUME_OBJECTS_DIR = path.join(directory, 'audit-objects');
  const helpers = require('../../tests/helpers');
  const { openBrowser } = require('../../tests/browser-driver');
  const ctx = await helpers.boot(), cleanups = [];
  const id = await helpers.defaultProject(ctx);
  const browser = await openBrowser({ after: f => cleanups.unshift(f) }, ctx.base.replace('/api/v1', '/'));
  const { evaluate, cdp, until, click } = browser;
  const audits = [];
  try {
    for (const entry of report.entries) {
      if (entry.scenario === 'unreadable-link') continue;
      const file = path.join(directory, entry.key + '-target.json');
      const doc = documents.get(entry.key) || (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')));
      if (!doc) { audits.push({ key: entry.key, provider: entry.provider, round: entry.round,
        scenario: entry.scenario, status: 'NO_EXECUTABLE_RESULT', ok: false, original_issues: entry.issues }); continue; }
      helpers.db.run('UPDATE resume_drafts SET resume_json = ?, revision = revision+1 WHERE project_id = ?',
        [JSON.stringify(doc), id]);
      await evaluate('refresh()');
      const text = R.nodeText(doc.root);
      const row = { key: entry.key, provider: entry.provider, round: entry.round, scenario: entry.scenario,
        missing_facts: FACTS.filter(f => !text.includes(f)),
        reference_leak: ['顾明', '18812345678', '北岭大学', '数学博士'].filter(f => text.includes(f)) };
      row.canvas = await evaluate(`(${geometry.toString()})("#resume-document")`);
      await click('#preview-current');
      await until('document.querySelector("#resume-preview-modal").classList.contains("show")');
      row.preview = await evaluate(`(${geometry.toString()})("#resume-preview-document")`);
      if (entry.round === 1 && entry.scenario === 'new-reference-restructure') {
        const downloads = path.join(directory, entry.key + '-downloads');
        fs.mkdirSync(downloads, { recursive: true, mode: 0o700 });
        await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
        row.downloads = {};
        for (const format of ['pdf', 'docx']) {
          await click(`[data-download-format="${format}"]`);
          const deadline = Date.now() + 30000;
          let name;
          while (Date.now() < deadline) {
            name = fs.readdirSync(downloads).find(f => f.endsWith('.' + format));
            if (name) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (!name) { row.downloads[format] = { ok: false, code: 'DOWNLOAD_TIMEOUT' }; continue; }
          const file = path.join(downloads, name);
          const content = format === 'pdf'
            ? execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' })
            : execFileSync('unzip', ['-p', file, 'word/document.xml'], { encoding: 'utf8' })
              .replace(/<[^>]*>/g, '');
          const missing = FACTS.filter(f => !content.replace(/\s/g, '').includes(f));
          row.downloads[format] = { ok: missing.length === 0, missing_facts: missing,
            bytes: fs.statSync(file).size };
        }
      }
      const shot = await cdp('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(directory, entry.key + '-audited.png'), Buffer.from(shot.data, 'base64'), { mode: 0o600 });
      await click('#resume-preview-modal .close');
      const headings = row.canvas.headings.filter(h => !h.text.includes('林舟') && h.width > 0);
      row.layout_matches = entry.scenario === 'copy-independent-resume'
        ? (() => {
          const a = row.canvas.text_blocks.find(n => n.text.includes('江原大学'));
          const b = row.canvas.text_blocks.find(n => n.text.includes('远山科技'));
          return Boolean(a && b && b.x - a.x > row.canvas.width * 0.18);
        })()
        : headings.length >= 4 && headings.every(h => h.width > row.canvas.width * 0.65)
          && (() => {
            const a = headings.find(h => h.text.includes('教育')), b = headings.find(h => h.text.includes('工作'));
            return Boolean(a && b && a.y < b.y);
          })();
      row.content_ok = !row.missing_facts.length && !row.reference_leak.length;
      row.editable_ok = row.canvas.uneditable.length === 0;
      row.render_ok = !row.canvas.narrow.length && !row.canvas.overflow.length
        && !row.preview.narrow.length && !row.preview.overflow.length
        && !row.canvas.overlaps.length && !row.preview.overlaps.length;
      row.ok = row.content_ok && row.layout_matches && row.editable_ok && row.render_ok;
      audits.push(row);
      console.log(JSON.stringify({ key: row.key, content: row.content_ok, layout: row.layout_matches,
        editable: row.editable_ok, render: row.render_ok }));
    }
    const summary = [...new Set(audits.map(e => e.provider).filter(Boolean))].map(provider => {
      const rows = audits.filter(e => e.provider === provider);
      return { provider, total: rows.length, passed: rows.filter(e => e.ok).length,
        content: rows.filter(e => e.content_ok).length, layout: rows.filter(e => e.layout_matches).length,
        editable: rows.filter(e => e.editable_ok).length, render: rows.filter(e => e.render_ok).length };
    });
    fs.writeFileSync(path.join(directory, 'audited-report.json'), JSON.stringify({
      source_report: 'report.json', browser: 'Chromium real index.html', generated_at: new Date().toISOString(),
      note: '以可见文本核验事实；编辑标记缺失单独计分；每份结果实际重新渲染，未调用模型。',
      audits, summary, browser_errors: browser.errors,
    }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(summary));
  } finally {
    for (const cleanup of cleanups) await cleanup();
    helpers.close(ctx);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

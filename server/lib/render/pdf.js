'use strict';
/**
 * PDF 渲染：Resume DOM + Template Schema → PDF（TECH §11.1）。
 *
 * 说明：TECH 推荐固定版本 Chromium 打印 PDF。当前环境无浏览器，
 * 这里使用内置 PDF writer 完成同样的语义输出：
 *   - Resume DOM 驱动内容与顺序，模板决定字体、页边距与视觉规则；
 *   - 嵌入 Noto Sans SC（CIDFontType2 + Identity-H），中文字体不缺失；
 *   - 只输出实际用到的 glyph 宽度表（W）与 ToUnicode，保证文本可复制/可搜索；
 *   - 生产接入 Chromium 时只需替换 renderPdf 实现，调用方不变。
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadFont, measureText } = require('./ttf');
const ResumeDom = require('../../../resume-dom');

const FONT_PATH =
  process.env.RESUME_FONT_PATH || '/home/ubuntu/.fonts/NotoSansSC.ttf';

const PAGE_WIDTH = 595.28; // A4 pt
const PAGE_HEIGHT = 841.89;

class PdfDoc {
  constructor() {
    this.pages = [];
    this.currentOps = [];
    this.fontResources = new Map(); // name → font object
  }

  newPage() {
    if (this.currentOps.length) this.pages.push(this.currentOps);
    this.currentOps = [];
    return this;
  }

  /** 以「距页面顶部 topPt」的坐标系写入文本，内部转换为 PDF 坐标。 */
  text(x, top, content, { size = 9.5, color = '#414448', bold = false, letterSpacing = 0 } = {}) {
    const y = PAGE_HEIGHT - top - size;
    const rgb = hexToRgb01(color);
    let line = `${rgb} rg\n`;
    if (bold) line += `2 Tr 0.35 w\n`; // 无粗体字形时用填充+描边模拟
    line += `BT /F1 ${size} Tf ${letterSpacing} Tc 1 0 0 1 ${fmt(x)} ${fmt(y)} Tm <${toHexGids(content)}> Tj ET\n`;
    if (bold) line += `0 Tr\n`;
    this.currentOps.push(line);
    return this;
  }

  line(x1, top, x2, color = '#d1d1d6', width = 0.7) {
    return this.segment(x1, top, x2, top, color, width);
  }

  segment(x1, top1, x2, top2, color = '#d1d1d6', width = 0.7) {
    const y1 = PAGE_HEIGHT - top1;
    const y2 = PAGE_HEIGHT - top2;
    const rgb = hexToRgb01(color);
    this.currentOps.push(
      `${rgb} RG ${width} w ${fmt(x1)} ${fmt(y1)} m ${fmt(x2)} ${fmt(y2)} l S\n`,
    );
    return this;
  }

  finish() {
    if (this.currentOps.length) this.pages.push(this.currentOps);
    return this.pages;
  }
}

function fmt(n) {
  return Number(n.toFixed(2)).toString();
}

function hexToRgb01(hex) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return `${fmt(r)} ${fmt(g)} ${fmt(b)}`;
}

/** 已加载字体（进程内缓存），用于生成 glyph id 流。 */
let activeFont = null;

function toHexGids(text) {
  let out = '';
  for (const char of String(text)) {
    const gid = activeFont.glyphId(char.codePointAt(0));
    out += gid.toString(16).padStart(4, '0');
  }
  return out;
}

/** 按可用宽度折行。中文按字断行，西文优先在空格处断开。 */
function wrapText(font, text, maxWidth, size) {
  const lines = [];
  const paragraphs = String(text).split('\n');
  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    // 先按西文空格与中文边界切分为可断行单元
    const units = paragraph.match(/[A-Za-z0-9@.+\-_/]+|\s+|[^\s]/g) || [];
    let line = '';
    for (const unit of units) {
      const candidate = line + unit;
      if (measureText(font, candidate, size) <= maxWidth || !line.trim()) {
        line = candidate;
      } else {
        lines.push(line.trimEnd());
        line = unit.trimStart();
      }
    }
    if (line) lines.push(line.trimEnd());
  }
  return lines;
}

/** 将 resume 的内容块展开为绘制指令。 */
function layoutResume(doc, font, resume, template) {
  const schema = template.schema || template;
  const typo = schema.typography || {};
  const margin = (schema.page && schema.page.margin) || { top: 58, right: 64, bottom: 64, left: 64 };
  const baseSize = typo.base_size || 9.5;
  const lineHeight = typo.line_height || 1.75;
  const color = typo.color || '#414448';
  const accent = typo.accent || '#1d1d1f';
  const titleStyle = (schema.section_rules && schema.section_rules.title_style) || {};
  const attached = ResumeDom.attachDocument(resume);
  const rendered = ResumeDom.toRenderBlocks(attached.dom_document);

  const left = margin.left;
  const contentWidth = PAGE_WIDTH - margin.left - margin.right;
  let top = margin.top;

  const ensureSpace = (needed) => {
    if (top + needed <= PAGE_HEIGHT - margin.bottom) return;
    doc.newPage();
    top = margin.top;
  };

  // ---- 页眉 ----
  const headerTitle = (rendered.header && rendered.header.title)
    || (attached.basics && attached.basics.name)
    || '';
  if (headerTitle) {
    doc.text(left, top, headerTitle, { size: 22, color: accent, bold: true, letterSpacing: 2 });
    top += 30;
  }
  if (rendered.header && rendered.header.subtitle) {
    doc.text(left, top, rendered.header.subtitle, { size: 9, color: '#5f6265' });
    top += 16;
  }
  if (headerTitle || (rendered.header && rendered.header.subtitle)) {
    doc.line(left, top, PAGE_WIDTH - margin.right, accent, 1.6);
    top += 22;
  }

  const drawSectionTitle = (label) => {
    ensureSpace(40);
    doc.text(left, top, label, {
      size: titleStyle.size || 12,
      color: titleStyle.color || accent,
      bold: true,
      letterSpacing: titleStyle.letter_spacing || 1.5,
    });
    top += 16;
    if (titleStyle.rule !== false) {
      doc.line(left, top, PAGE_WIDTH - margin.right, titleStyle.color || accent, 0.7);
      top += 12;
    } else {
      top += 6;
    }
  };

  const drawParagraph = (text, size = baseSize) => {
    const lines = wrapText(font, text, contentWidth, size);
    lines.forEach((line) => {
      ensureSpace(size * lineHeight + 2);
      doc.text(left, top, line, { size, color });
      top += size * lineHeight;
    });
  };

  const drawBullets = (bullets = [], indent = 14) => {
    bullets.forEach((bullet) => {
      const text = typeof bullet === 'string' ? bullet : bullet.text;
      if (!text) return;
      const lines = wrapText(font, text, contentWidth - indent, baseSize);
      lines.forEach((line, index) => {
        ensureSpace(baseSize * lineHeight + 2);
        if (index === 0) {
          doc.text(left, top, '•', { size: baseSize, color: accent });
          doc.text(left + indent, top, line, { size: baseSize, color });
        } else {
          doc.text(left + indent, top, line, { size: baseSize, color });
        }
        top += baseSize * lineHeight;
      });
    });
  };

  /** 经历行：公司/学校 + 角色 + 时间。 */
  const drawEntryRow = (main, role, period) => {
    ensureSpace(24);
    doc.text(left, top, main, { size: 10, color: accent, bold: true });
    if (role) {
      // 角色紧跟主体（原型中为浅色次级信息）
      const mainWidth = measureText(font, main, 10) + 12;
      doc.text(left + mainWidth, top, role, { size: 10, color: '#4d5155' });
    }
    if (period) {
      const periodWidth = measureText(font, period, 9);
      doc.text(PAGE_WIDTH - margin.right - periodWidth, top, period, { size: 9, color: '#73767a' });
    }
    top += 17;
  };

  const drawTable = (block) => {
    const rows = block.rows || [];
    const columnCount = Math.max(
      1,
      ...rows.map((row) =>
        (row.cells || []).reduce((sum, cell) => sum + Math.max(1, Number(cell.colspan || 1)), 0)),
    );
    const columnWidth = contentWidth / columnCount;
    rows.forEach((row) => {
      const cells = row.cells || [];
      const prepared = cells.map((cell) => {
        const span = Math.max(1, Number(cell.colspan || 1));
        const sourceLines = cell.lines && cell.lines.length ? cell.lines : [cell.text || ''];
        const lines = sourceLines.flatMap((line) =>
          wrapText(font, line, columnWidth * span - 10, baseSize));
        return { cell, span, lines: lines.length ? lines : [''] };
      });
      const rowHeight = Math.max(
        baseSize * lineHeight + 8,
        ...prepared.map((entry) => entry.lines.length * baseSize * 1.35 + 8),
      );
      ensureSpace(rowHeight + 1);
      const rowTop = top;
      let x = left;
      doc.line(left, rowTop, left + contentWidth, '#d8dde2', 0.55);
      prepared.forEach((entry) => {
        doc.segment(x, rowTop, x, rowTop + rowHeight, '#d8dde2', 0.55);
        entry.lines.forEach((line, lineIndex) => {
          doc.text(x + 5, rowTop + 4 + lineIndex * baseSize * 1.35, line, {
            size: baseSize,
            color,
            bold: lineIndex === 0 && entry.lines.length > 1,
          });
        });
        x += columnWidth * entry.span;
      });
      doc.segment(left + contentWidth, rowTop, left + contentWidth, rowTop + rowHeight, '#d8dde2', 0.55);
      doc.line(left, rowTop + rowHeight, left + contentWidth, '#d8dde2', 0.55);
      top += rowHeight;
    });
    top += 6;
  };

  // ---- 模块和顺序由 Resume DOM 决定 ----
  let numberedIndex = 0;
  rendered.blocks.forEach((block) => {
    if (block.type !== 'numbered') numberedIndex = 0;
    if (block.type === 'heading') {
      drawSectionTitle(block.text);
    } else if (block.type === 'row') {
      drawEntryRow(block.main || block.text || '', block.secondary || '', block.trailing || '');
    } else if (block.type === 'bullet') {
      drawBullets([block.text]);
    } else if (block.type === 'numbered') {
      numberedIndex += 1;
      drawParagraph(`${numberedIndex}. ${block.text}`);
    } else if (block.type === 'rule') {
      ensureSpace(12);
      doc.line(left, top, PAGE_WIDTH - margin.right, '#d1d1d6', 0.7);
      top += 10;
    } else if (block.type === 'table') {
      drawTable(block);
    } else if (block.type === 'paragraph') {
      drawParagraph(block.text);
      top += 6;
    }
  });

  return doc.pages.length;
}

/** 生成连续 gid 的宽度表 W（只覆盖实际用到的字形）。 */
function buildWidthArray(font, usedGids) {
  const sorted = Array.from(usedGids).sort((a, b) => a - b);
  const segments = [];
  let start = null;
  let prev = null;
  let widths = [];
  sorted.forEach((gid) => {
    if (start === null) {
      start = gid;
      widths = [font.advanceWidth(gid)];
    } else if (gid === prev + 1) {
      widths.push(font.advanceWidth(gid));
    } else {
      segments.push([start, widths]);
      start = gid;
      widths = [font.advanceWidth(gid)];
    }
    prev = gid;
  });
  if (start !== null) segments.push([start, widths]);
  return segments.map(([first, list]) => `${first} [${list.join(' ')}]`).join(' ');
}

function buildToUnicode(usedGids) {
  const entries = Array.from(usedGids)
    .sort((a, b) => a - b)
    .map((gid) => {
      const code = gidToUnicode.get(gid);
      if (code === undefined) return null;
      const uni = code.toString(16).padStart(4, '0');
      return `<${gid.toString(16).padStart(4, '0')}> <${uni}>`;
    })
    .filter(Boolean);
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${entries.length} beginbfchar
${entries.join('\n')}
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
}

/** gid → unicode 反查表（构建 ToUnicode 用）。 */
let gidToUnicode = new Map();

function collectUsedGids(font, pages) {
  const used = new Set();
  const regex = /<([0-9a-fA-F]+)>\s*Tj/g;
  pages.forEach((ops) => {
    ops.forEach((op) => {
      let match;
      while ((match = regex.exec(op)) !== null) {
        const hex = match[1];
        for (let i = 0; i < hex.length; i += 4) {
          const gid = parseInt(hex.slice(i, i + 4), 16);
          used.add(gid);
          if (!gidToUnicode.has(gid)) {
            const char = reverseLookup(font, gid);
            if (char !== undefined) gidToUnicode.set(gid, char);
          }
        }
      }
    });
  });
  return used;
}

/** 通过字体 cmap 反查 gid 对应字符（仅在生成 ToUnicode 时执行一次）。 */
let reverseMap = null;
function reverseLookup(font, gid) {
  if (reverseMap && reverseMap.font === font) return reverseMap.map.get(gid);
  const map = new Map();
  // 遍历常用字符区间建立反查（BMP 内 CJK 与 ASCII 已覆盖简历场景）
  for (let code = 32; code < 0x10000; code += 1) {
    const mapped = font.glyphId(code);
    if (mapped && !map.has(mapped)) map.set(mapped, code);
  }
  reverseMap = { font, map };
  return map.get(gid);
}

/** 组装 PDF 文件字节。 */
function serialize(font, pages, usedGids, pageCount) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length; // 1-based 对象号
  };

  // 预留：1 Catalog, 2 Pages, 3 Font(Type0), 4 CIDFontType2, 5 FontDescriptor, 6 FontFile2, 7 ToUnicode
  const pageObjIds = [];
  for (let i = 0; i < pageCount; i += 1) pageObjIds.push(null);

  add(''); // 1 catalog 占位
  add(''); // 2 pages 占位

  const fontFileNumber = add(null); // 3 FontFile2 占位（稍后填充）
  const descriptorNumber = add(null); // 4
  const cidFontNumber = add(null); // 5
  const type0Number = add(null); // 6
  const toUnicodeNumber = add(null); // 7

  const contentIds = [];
  pages.forEach((ops) => {
    const stream = ops.join('');
    contentIds.push(
      add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`),
    );
  });

  pages.forEach((_, index) => {
    pageObjIds[index] = add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(PAGE_WIDTH)} ${fmt(PAGE_HEIGHT)}] ` +
        `/Resources << /Font << /F1 ${type0Number} 0 R >> >> /Contents ${contentIds[index]} 0 R >>`,
    );
  });

  objects[0] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[1] = `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`;

  objects[fontFileNumber - 1] =
    `<< /Length ${font.bytes.length} /Length1 ${font.bytes.length} >>\nstream\n`;
  const fontFileObj = objects[fontFileNumber - 1];
  objects[fontFileNumber - 1] = fontFileObj; // 占位，字节在序列化时追加

  objects[descriptorNumber - 1] =
    `<< /Type /FontDescriptor /FontName /NotoSansSC /Flags 4 ` +
    `/FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 ` +
    `/StemV 80 /FontFile2 ${fontFileNumber} 0 R >>`;

  const widths = buildWidthArray(font, usedGids);
  objects[cidFontNumber - 1] =
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /NotoSansSC ` +
    `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
    `/FontDescriptor ${descriptorNumber} 0 R /DW 1000 /W [${widths}] /CIDToGIDMap /Identity >>`;

  objects[type0Number - 1] =
    `<< /Type /Font /Subtype /Type0 /BaseFont /NotoSansSC /Encoding /Identity-H ` +
    `/DescendantFonts [${cidFontNumber} 0 R] /ToUnicode ${toUnicodeNumber} 0 R >>`;

  const toUnicode = buildToUnicode(usedGids);
  objects[toUnicodeNumber - 1] =
    `<< /Length ${Buffer.byteLength(toUnicode)} >>\nstream\n${toUnicode}\nendstream`;

  // 序列化
  const chunks = [];
  let offset = 0;
  const header = Buffer.from('%PDF-1.4\n');
  chunks.push(header);
  offset += header.length;

  objects.forEach((body, index) => {
    const number = index + 1;
    if (number === fontFileNumber) {
      const head = Buffer.from(`${number} 0 obj\n${body}`);
      chunks.push(head);
      offset += head.length;
      chunks.push(font.bytes);
      offset += font.bytes.length;
      const tail = Buffer.from('\nendstream\nendobj\n');
      chunks.push(tail);
      offset += tail.length;
    } else {
      const buf = Buffer.from(`${number} 0 obj\n${body}\nendobj\n`);
      chunks.push(buf);
      offset += buf.length;
    }
  });

  // xref 偏移量按每个对象最终落盘的字节数累计
  let runningOffset = header.length;
  const finalOffsets = [];
  objects.forEach((_, index) => {
    finalOffsets.push(runningOffset);
    const number = index + 1;
    if (number === fontFileNumber) {
      runningOffset +=
        Buffer.byteLength(`${number} 0 obj\n${objects[index]}`) +
        font.bytes.length +
        Buffer.byteLength('\nendstream\nendobj\n');
    } else {
      runningOffset += Buffer.byteLength(`${number} 0 obj\n${objects[index]}\nendobj\n`);
    }
  });

  const xrefOffset = runningOffset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  finalOffsets.forEach((off) => {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  });
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer));
  return Buffer.concat(chunks);
}

/**
 * 渲染 PDF。
 * @param {{resume:object, template:object}} input
 * @returns {{buffer:Buffer, pages:number}}
 */
function renderPdf({ resume, template }) {
  if (!fs.existsSync(FONT_PATH)) {
    const err = new Error(`缺少中文字体 ${FONT_PATH}`);
    err.code = 'RENDER_FONT_MISSING';
    throw err;
  }
  const font = loadFont(FONT_PATH);
  activeFont = font;
  gidToUnicode = new Map();

  const doc = new PdfDoc();
  doc.newPage();
  layoutResume(doc, font, resume, template);
  const pages = doc.finish();
  const pageCount = Math.max(1, pages.length);
  const usedGids = collectUsedGids(font, pages);
  usedGids.add(font.glyphId(32));
  const buffer = serialize(font, pages, usedGids, pageCount);
  return { buffer, pages: pageCount };
}

module.exports = { renderPdf, FONT_PATH, PAGE_WIDTH, PAGE_HEIGHT, wrapText };

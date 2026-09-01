'use strict';
/**
 * 极小 TrueType 解析器（仅取排版所需度量）。
 *
 * 用途：PDF 生成需要按字符宽度手工换行（PDF 文本不会自动换行），
 * 因此必须读取 cmap（字符 → glyph）与 hmtx（字形步进宽度）。
 * 生产环境可用 fontkit / fontTools 子集化字体减小体积（TECH §11.1）。
 */
const fs = require('node:fs');

const cache = new Map();

function readTables(buffer) {
  const numTables = buffer.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < numTables; i += 1) {
    const offset = 12 + i * 16;
    const tag = buffer.toString('ascii', offset, offset + 4);
    tables[tag] = {
      checksum: buffer.readUInt32BE(offset + 4),
      offset: buffer.readUInt32BE(offset + 8),
      length: buffer.readUInt32BE(offset + 12),
    };
  }
  return tables;
}

/** 解析 cmap：支持 format 4（BMP）与 format 12（全 Unicode）。 */
function parseCmap(buffer, tables) {
  const table = tables.cmap;
  if (!table) return new Map();
  const base = table.offset;
  const numSub = buffer.readUInt16BE(base + 2);
  const mapping = new Map();

  for (let i = 0; i < numSub; i += 1) {
    const record = base + 4 + i * 8;
    const subOffset = base + buffer.readUInt32BE(record + 4);
    const format = buffer.readUInt16BE(subOffset);
    if (format === 4) {
      const segCountX2 = buffer.readUInt16BE(subOffset + 6);
      const segCount = segCountX2 / 2;
      const endBase = subOffset + 14;
      const startBase = endBase + segCountX2 + 2;
      const deltaBase = startBase + segCountX2;
      const rangeBase = deltaBase + segCountX2;
      for (let s = 0; s < segCount; s += 1) {
        const end = buffer.readUInt16BE(endBase + s * 2);
        const start = buffer.readUInt16BE(startBase + s * 2);
        const delta = buffer.readInt16BE(deltaBase + s * 2);
        const rangeOffset = buffer.readUInt16BE(rangeBase + s * 2);
        for (let code = start; code <= end && code !== 0xffff; code += 1) {
          let glyph;
          if (rangeOffset === 0) {
            glyph = (code + delta) & 0xffff;
          } else {
            const glyphIndexAddr = rangeBase + s * 2 + rangeOffset + (code - start) * 2;
            if (glyphIndexAddr + 2 > buffer.length) continue;
            glyph = buffer.readUInt16BE(glyphIndexAddr);
            if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
          }
          if (glyph) mapping.set(code, glyph);
        }
      }
    } else if (format === 12) {
      const nGroups = buffer.readUInt32BE(subOffset + 12);
      for (let g = 0; g < nGroups; g += 1) {
        const group = subOffset + 16 + g * 12;
        const startChar = buffer.readUInt32BE(group);
        const endChar = buffer.readUInt32BE(group + 4);
        const startGlyph = buffer.readUInt32BE(group + 8);
        for (let code = startChar; code <= endChar; code += 1) {
          mapping.set(code, startGlyph + (code - startChar));
        }
      }
    }
  }
  return mapping;
}

/**
 * 加载字体。
 * @returns {{unitsPerEm:number, glyphId(code:number):number, advanceWidth(gid:number):number, path:string, bytes:Buffer, numGlyphs:number}}
 */
function loadFont(fontPath) {
  if (cache.has(fontPath)) return cache.get(fontPath);
  const buffer = fs.readFileSync(fontPath);
  const tables = readTables(buffer);

  const head = tables.head;
  const unitsPerEm = head ? buffer.readUInt16BE(head.offset + 18) : 1000;
  const hhea = tables.hhea;
  const numberOfHMetrics = hhea ? buffer.readUInt16BE(hhea.offset + 34) : 0;
  const maxp = tables.maxp;
  const numGlyphs = maxp ? buffer.readUInt16BE(maxp.offset + 4) : 0;

  const hmtx = tables.hmtx;
  const advances = new Uint16Array(numberOfHMetrics || 1);
  if (hmtx) {
    for (let i = 0; i < numberOfHMetrics; i += 1) {
      advances[i] = buffer.readUInt16BE(hmtx.offset + i * 4);
    }
  }

  const cmap = parseCmap(buffer, tables);

  const font = {
    path: fontPath,
    bytes: buffer,
    unitsPerEm,
    numGlyphs,
    numberOfHMetrics,
    glyphId(code) {
      const gid = cmap.get(code);
      return gid === undefined ? 0 : gid;
    },
    /** 返回 1000 单位制下的步进宽度（PDF 文本空间单位为 1/1000 em）。 */
    advanceWidth(gid) {
      const index = gid < numberOfHMetrics ? gid : Math.max(0, numberOfHMetrics - 1);
      const raw = advances[index] || 0;
      return Math.round((raw / unitsPerEm) * 1000);
    },
  };
  cache.set(fontPath, font);
  return font;
}

/** 计算字符串在给定字号下的宽度（pt）。 */
function measureText(font, text, fontSize) {
  let total = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    const gid = font.glyphId(code);
    total += font.advanceWidth(gid);
  }
  return (total / 1000) * fontSize;
}

module.exports = { loadFont, measureText };

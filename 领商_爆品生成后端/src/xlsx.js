// 零依赖的 xlsx 读写：只覆盖本项目需要的部分（单个工作表、全部单元格为文本）。
// 写出的文件结构与商品模板（Apache POI 导出的 pddkj_product 表）一致：
// 内联字符串单元格、表头行高 42.5、表头 14 号加粗宋体居中、数据行 11 号宋体居中自动换行。

const zlib = require("node:zlib");

// ---------- zip ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries, date = new Date()) {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // 文件名为 UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

// 返回 Map<文件名, Buffer>
function unzip(buffer) {
  let endOffset = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      endOffset = i;
      break;
    }
  }
  if (endOffset === -1) throw new Error("不是有效的 xlsx 文件");
  const count = buffer.readUInt16LE(endOffset + 10);
  let pointer = buffer.readUInt32LE(endOffset + 16);
  if (count > 2000) throw new Error("xlsx 文件内的条目过多");
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error("xlsx 文件目录损坏");
    const flags = buffer.readUInt16LE(pointer + 8);
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString("utf8", pointer + 46, pointer + 46 + nameLength);
    pointer += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) throw new Error("不支持加密的 xlsx 文件");
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("xlsx 文件内容损坏");
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) files.set(name, Buffer.from(raw));
    else if (method === 8) files.set(name, zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }));
    else throw new Error("不支持的 xlsx 压缩方式");
  }
  return files;
}

// ---------- xml ----------

// 去掉 XML 不允许的控制字符，再转义
function xmlText(value) {
  return String(value ?? "")
    .replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r\n?|\n/g, "&#xa;");
}

function xmlDecode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

function columnLetters(index) {
  let letters = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

function columnIndex(letters) {
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

// ---------- 写 ----------

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="no"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default ContentType="application/vnd.openxmlformats-package.relationships+xml" Extension="rels"/><Default ContentType="application/xml" Extension="xml"/><Override ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml" PartName="/docProps/app.xml"/><Override ContentType="application/vnd.openxmlformats-package.core-properties+xml" PartName="/docProps/core.xml"/><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml" PartName="/xl/sharedStrings.xml"/><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml" PartName="/xl/styles.xml"/><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" PartName="/xl/workbook.xml"/><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml" PartName="/xl/worksheets/sheet1.xml"/></Types>';
const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="no"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="xl/workbook.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"/><Relationship Id="rId2" Target="docProps/app.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties"/><Relationship Id="rId3" Target="docProps/core.xml" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties"/></Relationships>';
const APP_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Lingshang</Application></Properties>';
const WORKBOOK_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="no"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="sharedStrings.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings"/><Relationship Id="rId2" Target="styles.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"/><Relationship Id="rId3" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>';
const SHARED_STRINGS =
  '<?xml version="1.0" encoding="UTF-8"?>\n<sst count="0" uniqueCount="0" xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>';
// 样式 1：表头；样式 2：数据行（与商品模板一致）
const STYLES =
  '<?xml version="1.0" encoding="UTF-8"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="0"/><fonts count="3"><font><sz val="11.0"/><color indexed="8"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font><font><name val="宋体"/><sz val="14.0"/><b val="true"/></font><font><name val="宋体"/><sz val="11.0"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="darkGray"/></fill><fill><patternFill patternType="none"><bgColor indexed="17"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="true" applyFont="true"><alignment horizontal="center" vertical="center" wrapText="true"/></xf><xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFill="true" applyFont="true"><alignment horizontal="center" vertical="center" wrapText="true"/></xf></cellXfs></styleSheet>';

function cellXml(rowNumber, columnIdx, value, style) {
  const text = String(value ?? "");
  // 首尾有空白时声明保留，否则 Excel 会把它去掉
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : "";
  return `<c r="${columnLetters(columnIdx)}${rowNumber}" s="${style}" t="inlineStr"><is><t${preserve}>${xmlText(text)}</t></is></c>`;
}

// header: string[]，rows: string[][]。所有单元格都按文本写入，不会被当成公式执行。
function buildXlsx({ sheetName, header, rows, createdAt = new Date() }) {
  const width = header.length;
  const lines = [
    `<row r="1" customHeight="true" ht="42.5">${header.map((value, i) => cellXml(1, i, value, 1)).join("")}</row>`
  ];
  rows.forEach((row, index) => {
    const cells = [];
    for (let i = 0; i < width; i++) cells.push(cellXml(index + 2, i, row[i], 2));
    lines.push(`<row r="${index + 2}">${cells.join("")}</row>`);
  });
  const dimension = `A1:${columnLetters(Math.max(width, 1) - 1)}${rows.length + 1}`;
  const sheet = `<?xml version="1.0" encoding="UTF-8"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dimension}"/><sheetViews><sheetView workbookViewId="0" tabSelected="true"/></sheetViews><sheetFormatPr defaultRowHeight="15.0" baseColWidth="16"/><sheetData>\n${lines.join("\n")}\n</sheetData><pageMargins bottom="0.75" footer="0.3" header="0.3" left="0.7" right="0.7" top="0.75"/></worksheet>`;
  const safeSheetName = xmlText(String(sheetName || "Sheet1").replace(/[\\/?*[\]:]/g, "_").slice(0, 31));
  const workbook = `<?xml version="1.0" encoding="UTF-8"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="false"/><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="${safeSheetName}" r:id="rId3" sheetId="1"/></sheets></workbook>`;
  const created = createdAt.toISOString().replace(/\.\d{3}Z$/, "Z");
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="no"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created><dc:creator>Lingshang</dc:creator></cp:coreProperties>`;
  return zip(
    [
      { name: "_rels/.rels", data: ROOT_RELS },
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      { name: "docProps/app.xml", data: APP_XML },
      { name: "docProps/core.xml", data: core },
      { name: "xl/sharedStrings.xml", data: SHARED_STRINGS },
      { name: "xl/styles.xml", data: STYLES },
      { name: "xl/workbook.xml", data: workbook },
      { name: "xl/_rels/workbook.xml.rels", data: WORKBOOK_RELS },
      { name: "xl/worksheets/sheet1.xml", data: sheet }
    ],
    createdAt
  );
}

// ---------- 读 ----------

function textOf(xml) {
  return [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((match) => xmlDecode(match[1])).join("");
}

// 读取第一个工作表，返回 { sheetName, rows }，rows 是字符串二维数组（第一行是表头）
function readXlsx(buffer) {
  const files = unzip(buffer);
  const read = (name) => (files.has(name) ? files.get(name).toString("utf8") : "");
  const workbook = read("xl/workbook.xml");
  const sheetTag = /<sheet\b[^>]*>/.exec(workbook)?.[0] || "";
  const sheetName = xmlDecode(/\bname="([^"]*)"/.exec(sheetTag)?.[1] || "Sheet1");
  const relationId = /\br:id="([^"]*)"/.exec(sheetTag)?.[1] || "";
  const relationTag = [...read("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)]
    .map((match) => match[0])
    .find((tag) => new RegExp(`\\bId="${relationId}"`).test(tag));
  const target = /\bTarget="([^"]*)"/.exec(relationTag || "")?.[1] || "worksheets/sheet1.xml";
  const sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  const sheet = read(sheetPath);
  if (!sheet) throw new Error("xlsx 文件里没有找到工作表");

  const shared = [...read("xl/sharedStrings.xml").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => textOf(match[1]));

  const rows = [];
  for (const rowMatch of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(/\br="(\d+)"/.exec(rowMatch[1])?.[1] || rows.length + 1);
    const row = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cellMatch[1];
      const inner = cellMatch[2] || "";
      const reference = /\br="([A-Z]+)\d+"/.exec(attributes)?.[1];
      const index = reference ? columnIndex(reference) : row.length;
      const type = /\bt="([^"]*)"/.exec(attributes)?.[1] || "n";
      let value;
      if (type === "inlineStr") value = textOf(inner);
      else {
        const raw = xmlDecode(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] || "");
        value = type === "s" ? shared[Number(raw)] ?? "" : raw;
      }
      row[index] = value;
    }
    rows[rowNumber - 1] = Array.from(row, (value) => value ?? "");
  }
  return { sheetName, rows: Array.from(rows, (row) => row || []) };
}

module.exports = { buildXlsx, readXlsx, zip, unzip, crc32, columnLetters, columnIndex };

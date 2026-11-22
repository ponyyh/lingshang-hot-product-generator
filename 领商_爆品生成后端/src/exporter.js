const HEADER = ["爆款链接", "生成标题", "商品名称", "颜色", "重量", "价格", "外包装形状"];

// Excel 会把以 = + - @ 开头的单元格当公式执行，前面加单引号让它按文本显示
function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildCsv({ hotLink, title, products }) {
  const rows = products.map((item) => [hotLink, title, item.name, item.color, item.weight, item.price, item.packaging]);
  const body = [HEADER, ...rows].map((cols) => cols.map(csvCell).join(",")).join("\r\n");
  // 带 BOM，Excel 直接打开中文不乱码
  return Buffer.from("﻿" + body + "\r\n", "utf8");
}

const EXPORT_FILENAME = "领商_爆品生成方案.csv";

module.exports = { buildCsv, csvCell, EXPORT_FILENAME };

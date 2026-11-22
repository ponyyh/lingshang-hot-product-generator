const { buildXlsx } = require("./xlsx");
const { exportRows, EXPORT_COLUMNS, EXPORT_SHEET_NAME } = require("./products");

// 导出文件与商品表格式一致：同样的工作表名、69 列表头和样式；
// 每个选中的商品一行，产品标题换成生成的标题，来源URL 写入爆款链接，更新时间写为导出时间。
function buildExport({ productIds, title, hotLink, now = new Date() }) {
  return buildXlsx({
    sheetName: EXPORT_SHEET_NAME,
    header: EXPORT_COLUMNS,
    rows: exportRows(productIds, { title, hotLink, now }),
    createdAt: now
  });
}

const EXPORT_FILENAME = "product_list.xlsx";
const EXPORT_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

module.exports = { buildExport, EXPORT_FILENAME, EXPORT_CONTENT_TYPE };

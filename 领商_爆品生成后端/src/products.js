// 商品库：来自商品表（xlsx）导入的 src/data/products.json，列顺序和表头与商品表完全一致。
// 更新商品：node scripts/import-products.mjs <商品表.xlsx>，然后重新部署。
// 接入真实商品库时，保持 listProducts / getProductsByIds / exportRows 的返回结构即可。

const fs = require("node:fs");
const path = require("node:path");

// 页面列表展示的字段：{ 接口字段名: 商品表列名 }，顺序即页面表格的列顺序
const DISPLAY_FIELDS = {
  title: "产品标题",
  variantName: "变种名称",
  color: "变种属性值一",
  model: "变种属性值二",
  skuCode: "SKU货号",
  declaredPrice: "申报价格",
  weight: "重量",
  packagingShape: "外包装形状",
  packagingType: "外包装类型",
  previewImage: "预览图"
};
const TITLE_COLUMN = "产品标题";
const SOURCE_LINK_COLUMN = "来源URL";
const UPDATED_AT_COLUMN = "更新时间";
const REQUIRED_COLUMNS = [...new Set([...Object.values(DISPLAY_FIELDS), SOURCE_LINK_COLUMN, "产品属性"])];

function loadCatalog(file = path.join(__dirname, "data/products.json")) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const columnIndex = new Map(data.columns.map((name, index) => [name, index]));
  const missing = REQUIRED_COLUMNS.filter((name) => !columnIndex.has(name));
  if (missing.length > 0) throw new Error(`商品数据缺少必需的列：${missing.join("、")}`);
  const cell = (row, name) => row[columnIndex.get(name)] ?? "";

  const items = data.rows.map((row, index) => {
    const item = { id: index + 1 };
    for (const [field, column] of Object.entries(DISPLAY_FIELDS)) item[field] = cell(row, column);
    // The picker and export use the same authoritative XLSX row.
    item.name = item.title;
    item.price = item.declaredPrice;
    item.packaging = item.packagingShape;
    // 产品属性是 JSON：[{ propName, propValue }]，同名属性的多个值合并
    const attributes = new Map();
    try {
      for (const prop of JSON.parse(cell(row, "产品属性") || "[]")) {
        if (!prop?.propName || !prop?.propValue) continue;
        attributes.set(prop.propName, [...(attributes.get(prop.propName) || []), String(prop.propValue)]);
      }
    } catch {
      // 属性不是合法 JSON 时按没有属性处理
    }
    return {
      item,
      row,
      // 仅服务端内部使用：给 Agent 的商品信息
      detail: {
        category: "手机壳",
        attributes: [...attributes].map(([name, values]) => ({ name, value: values.join("/") }))
      }
    };
  });
  return { sheetName: data.sheetName || "Sheet1", columns: data.columns, columnIndex, items };
}

const CATALOG = loadCatalog();
const BY_ID = new Map(CATALOG.items.map((entry) => [entry.item.id, entry]));

function listProducts({ keyword = "", page = 1, pageSize = 200 } = {}) {
  const kw = keyword.trim().toLowerCase();
  const searchable = ["title", "variantName", "color", "model", "skuCode"];
  const filtered = kw
    ? CATALOG.items.filter(({ item }) => searchable.some((field) => String(item[field]).toLowerCase().includes(kw)))
    : CATALOG.items;
  const start = (page - 1) * pageSize;
  return {
    total: filtered.length,
    page,
    pageSize,
    list: filtered.slice(start, start + pageSize).map(({ item }) => item)
  };
}

// 返回 { products, missingIds }，顺序与入参一致；products 带给 Agent 用的 detail
function getProductsByIds(ids) {
  const products = [];
  const missingIds = [];
  for (const id of ids) {
    const entry = BY_ID.get(id);
    if (entry) products.push({ ...entry.item, ...entry.detail });
    else missingIds.push(id);
  }
  return { products, missingIds };
}

function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  // 商品表里的时间是北京时间
  const local = new Date(date.getTime() + 8 * 3600 * 1000);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
}

// 导出用：按商品表原有的列顺序返回每个商品的整行，只改三列——
// 产品标题换成生成的标题，来源URL 写入爆款链接，更新时间写为导出时间。
function exportRows(ids, { title, hotLink, now = new Date() }) {
  const overrides = new Map([
    [CATALOG.columnIndex.get(TITLE_COLUMN), title],
    [CATALOG.columnIndex.get(SOURCE_LINK_COLUMN), hotLink]
  ]);
  if (CATALOG.columnIndex.has(UPDATED_AT_COLUMN)) {
    overrides.set(CATALOG.columnIndex.get(UPDATED_AT_COLUMN), formatTimestamp(now));
  }
  return ids
    .map((id) => BY_ID.get(id))
    .filter(Boolean)
    .map((entry) => entry.row.map((value, index) => (index === CATALOG.columnIndex.get(TITLE_COLUMN) ? `${title.trim()} ${value}` : overrides.has(index) ? overrides.get(index) : value)));
}

module.exports = {
  listProducts,
  getProductsByIds,
  exportRows,
  loadCatalog,
  formatTimestamp,
  DISPLAY_FIELDS,
  REQUIRED_COLUMNS,
  EXPORT_COLUMNS: CATALOG.columns,
  EXPORT_SHEET_NAME: CATALOG.sheetName,
  CATALOG_SIZE: CATALOG.items.length
};

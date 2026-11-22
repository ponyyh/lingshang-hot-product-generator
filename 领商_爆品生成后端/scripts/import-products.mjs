// 把商品表（xlsx）导入成后端的商品库：src/data/products.json。
// 用法：node scripts/import-products.mjs <商品表.xlsx>
// 表头原样保存，导出时按同样的列顺序写回，所以导出文件和这份商品表的格式一致。
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { readXlsx } = require("../src/xlsx.js");
const { REQUIRED_COLUMNS } = require("../src/products.js");

const source = process.argv[2];
if (!source) {
  console.error("用法：node scripts/import-products.mjs <商品表.xlsx>");
  process.exit(1);
}

const { sheetName, rows } = readXlsx(fs.readFileSync(source));
const [columns, ...dataRows] = rows;
if (!columns || columns.length === 0) throw new Error("商品表没有表头");
const missing = REQUIRED_COLUMNS.filter((name) => !columns.includes(name));
if (missing.length > 0) throw new Error(`商品表缺少必需的列：${missing.join("、")}`);

const width = columns.length;
const products = dataRows
  .map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ""))
  .filter((row) => row.some((value) => value !== ""));
if (products.length === 0) throw new Error("商品表里没有商品");

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/data/products.json");
fs.writeFileSync(
  target,
  JSON.stringify({ source: path.basename(source), sheetName, columns, rows: products }, null, 1) + "\n"
);
console.log(`已导入 ${products.length} 个商品、${width} 列（工作表 ${sheetName}）→ ${path.relative(process.cwd(), target)}`);

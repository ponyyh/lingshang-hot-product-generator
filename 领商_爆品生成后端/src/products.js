// 商品库：目前是与前端演示数据一致的 200 条种子数据（按固定规则生成，重启不变）。
// 接入真实商品库时，只需保持 listProducts / getProductsByIds 两个函数的返回结构。

const MODELS = [
  "iPhone 18 Pro Max", "iPhone 18 Pro", "iPhone 18", "iPhone 17 Air", "iPhone 17 Pro Max",
  "iPhone 17 Pro", "iPhone 16 Pro Max", "iPhone 16 Pro", "iPhone 15 Pro Max", "Samsung S26 Ultra",
  "Samsung S26", "Samsung S25 Ultra", "Huawei Mate 80 Pro", "Huawei Pura 80", "Xiaomi 16 Pro",
  "OPPO Find X9 Pro", "vivo X200 Pro"
];
const COLORS = [
  "星光白", "樱花粉", "酒红色", "钛灰蓝", "燕麦白", "钛金属灰", "冰川蓝", "奶油黄",
  "薄荷青", "雾霾蓝", "石墨黑", "曜石黑", "薰衣草紫", "松柏绿", "珊瑚橙", "玫瑰金"
];
const PRICES = ["¥158.00", "¥168.00", "¥178.00", "¥188.00", "¥198.00", "¥218.00", "¥228.00"];
const PACKAGINGS = ["环保磁吸礼盒", "简约透明吸塑盒", "标准彩印纸盒", "定制防震硬盒", "轻奢磨砂抽屉盒"];

function buildCatalog() {
  const list = [
    { id: 1, name: "Samsung S26", color: "黑色", weight: "130.2g", price: "¥188.00", packaging: "标准彩印纸盒" },
    { id: 2, name: "iPhone 18 Pro", color: "银色", weight: "118.6g", price: "¥188.00", packaging: "环保磁吸礼盒" },
    { id: 3, name: "iPhone 18 Pro", color: "黑色", weight: "118.6g", price: "¥188.00", packaging: "环保磁吸礼盒" }
  ];
  for (let i = 4; i <= 200; i++) {
    list.push({
      id: i,
      name: MODELS[(i - 4) % MODELS.length],
      color: COLORS[(i * 3) % COLORS.length],
      weight: (110 + ((i * 7) % 28) + ((i * 3) % 10) / 10).toFixed(1) + "g",
      price: PRICES[(i - 4) % PRICES.length],
      packaging: PACKAGINGS[(i - 4) % PACKAGINGS.length]
    });
  }
  return list;
}

// 种子数据全部是手机壳；品类是生成标题必需的信息，接入真实商品库后请改为读取商品自身的类目
const CATEGORY = "手机壳";
const CATALOG = buildCatalog().map((item) => ({ ...item, category: CATEGORY }));
const BY_ID = new Map(CATALOG.map((item) => [item.id, item]));

function listProducts({ keyword = "", page = 1, pageSize = 200 } = {}) {
  const kw = keyword.trim().toLowerCase();
  const filtered = kw
    ? CATALOG.filter((item) =>
        [item.name, item.color, item.packaging].some((field) => field.toLowerCase().includes(kw))
      )
    : CATALOG;
  const start = (page - 1) * pageSize;
  const list = filtered.slice(start, start + pageSize).map(({ category, ...publicFields }) => publicFields);
  return { total: filtered.length, page, pageSize, list };
}

// 返回 { products, missingIds }，顺序与入参一致
function getProductsByIds(ids) {
  const products = [];
  const missingIds = [];
  for (const id of ids) {
    const item = BY_ID.get(id);
    if (item) products.push(item);
    else missingIds.push(id);
  }
  return { products, missingIds };
}

module.exports = { listProducts, getProductsByIds, CATALOG_SIZE: CATALOG.length };

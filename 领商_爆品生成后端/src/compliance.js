// 标题合规校验：内容安全敏感词 + 平台广告规范（极限词、长度）。
// 词库是基础版，正式上线前应替换为风控团队维护的词库或内容安全服务。

const SENSITIVE_RULES = [
  {
    category: "涉黄低俗",
    words: ["色情", "涉黄", "淫秽", "情色", "裸聊", "嫖娼", "约炮", "成人片", "招嫖", "黄片"]
  },
  {
    category: "血腥暴力与犯罪",
    words: ["暴力", "血腥", "犯罪", "杀人", "谋杀", "抢劫", "诈骗", "走私", "枪支", "炸弹", "恐袭", "恐怖分子", "黑社会", "砍人", "自杀", "绑架"]
  },
  {
    category: "涉毒违禁",
    words: ["毒品", "吸毒", "贩毒", "冰毒", "海洛因", "大麻", "鸦片", "摇头丸", "可卡因", "K粉", "制毒"]
  },
  {
    category: "涉赌违法",
    words: ["赌博", "博彩", "赌场", "网赌", "六合彩", "私彩", "赌球", "洗钱", "跑分"]
  },
  {
    category: "涉政敏感",
    words: ["政治人物", "国家领导人", "总统", "主席", "总理", "政党", "反动", "分裂国家", "邪教", "政治敏感"]
  }
];

// 广告法极限用语与平台禁用承诺
const EXTREME_WORDS = [
  "全网最低", "假一赔十", "国家级", "世界级", "最", "第一", "绝对", "顶级", "极品",
  "首选", "独家", "唯一", "万能", "永久", "100%", "销量冠军", "全网第一"
];

const MIN_LENGTH = 10;
const MAX_LENGTH = 150;

// 去掉空白和零宽字符、统一全半角和大小写，避免「赌 博」「ＤＵ」这类简单绕过
function normalize(text) {
  return String(text)
    .normalize("NFKC")
    .replace(/[\s​-‏⁠﻿]/g, "")
    .toLowerCase();
}

function checkTitle(rawTitle) {
  const title = String(rawTitle).trim();
  const normalized = normalize(title);

  for (const rule of SENSITIVE_RULES) {
    const hitWords = rule.words.filter((w) => normalized.includes(normalize(w)));
    if (hitWords.length > 0) {
      return {
        passed: false,
        violationType: "sensitive",
        category: rule.category,
        hitWords,
        toastMsg: "请重新修改你的标题内容",
        inlineMsg: `标题包含违规敏感内容（${rule.category}），请重新修改你的标题内容！`
      };
    }
  }

  const length = Array.from(title).length;
  if (length < MIN_LENGTH || length > MAX_LENGTH) {
    const reason = length < MIN_LENGTH ? `标题至少 ${MIN_LENGTH} 个字` : `标题最多 ${MAX_LENGTH} 个字`;
    return {
      passed: false,
      violationType: "platform",
      category: "标题长度",
      hitWords: [],
      toastMsg: "下载失败",
      inlineMsg: `不符合平台规则（${reason}），请重新生成或修改！`
    };
  }

  const extremeHits = EXTREME_WORDS.filter((w) => normalized.includes(normalize(w)));
  if (extremeHits.length > 0) {
    // 只展示最长的命中词：命中「全网最低」时不必再提示「最」
    const shown = extremeHits.filter((w) => !extremeHits.some((o) => o !== w && o.includes(w)));
    return {
      passed: false,
      violationType: "platform",
      category: "广告极限词",
      hitWords: shown,
      toastMsg: "下载失败",
      inlineMsg: `不符合平台规则（含极限词「${shown.join("」「")}」），请重新生成或修改！`
    };
  }

  return { passed: true };
}

module.exports = { checkTitle, EXTREME_WORDS, MIN_LENGTH, MAX_LENGTH };

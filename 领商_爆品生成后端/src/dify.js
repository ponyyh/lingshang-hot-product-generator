const crypto = require('node:crypto');
const { AppError, CODES } = require('./errors');
const { summarizeProducts } = require('./agent');
const { checkTitle } = require('./compliance');

function parseKeywords(value) {
  if (Array.isArray(value)) return [...new Set(value.filter(x => typeof x === 'string' && x.trim()).map(x=>x.trim()))];
  if (typeof value === 'string') {
    try { const data = JSON.parse(value.replace(/^```(?:json)?\s*|\s*```$/g, '')); return parseKeywords(data.keywords || data); } catch {}
  }
  return [];
}
function validatePrefix(title, products) {
  const text = String(title || '').trim();
  const n = Array.from(text).length;
  if (n < 6 || n > 30 || /[\r\n]/.test(text) || !/手机壳|保护[套壳]/.test(text)) {
    throw new AppError(CODES.TITLE_REJECTED, '标题需为6到30字符的中文手机壳前标题，请重新生成');
  }
  if (/(?:iPhone|Samsung|Galaxy|苹果|三星|图拉斯|TORRAS|CASETiFY|新款|热销|推荐|认证|无毒)/i.test(text)) {
    throw new AppError(CODES.TITLE_REJECTED, '前标题含品牌型号或未经核实的宣传词，请修改后重试');
  }
  const check = checkTitle(text.length < 10 ? text + ' 手机保护套' : text);
  if (!check.passed) throw new AppError(CODES.TITLE_REJECTED, check.inlineMsg);
  const claims = [ ['磁吸', /磁吸/], ['支架', /支架/], ['防摔', /防摔/], ['防水', /防水/],
    ['硅胶', /(?:主要材质|材质).*硅胶/], ['TPU', /(?:主要材质|材质).*TPU/i],
    ['磨砂', /磨砂/], ['透明', /透明/], ['超薄', /超薄/], ['环保', /环保/], ['UV', /印花工艺.*UV/i], ['糖果色', /流行元素.*糖果色/], ['PC', /(?:主要材质|材质).*PC/i], ['热转印', /印花工艺.*热转印/] ];
  for (const [claim, evidence] of claims) {
    if (!text.toLowerCase().includes(claim.toLowerCase())) continue;
    // A documented molding process is not a claim that the case material is silicone.
    if (claim === '硅胶' && text.includes('硅胶成型') && !text.replaceAll('硅胶成型', '').includes('硅胶') &&
      products.every(p => (p.attributes || []).some(a => /工艺/.test(a.name) && a.value.split('/').includes('硅胶成型')))) continue;
    const supported = products.every(p => (p.attributes || []).some(a =>
      evidence.test(`${a.name}=${a.value}`) && !/^(否|无|不带|no)$/i.test(a.value)));
    if (!supported) throw new AppError(CODES.TITLE_REJECTED, `关联商品未证实“${claim}”，请删除或重新生成`);
  }
  return text;
}
async function runDify(config, { products, hotLink, hotTitle = '', previousTitle = '', fetchImpl = fetch }) {
  if (!config.dify?.apiKey) throw new AppError(CODES.AGENT_NOT_CONFIGURED, 'Dify 工作流尚未配置');
  const common = (products[0]?.attributes || []).filter(a => products.every(p =>
    (p.attributes || []).some(other => other.name === a.name && other.value === a.value))).filter(a => !/^(否|无|不带|不支持|no|false)$/i.test(a.value.trim()));
  const productInfo = JSON.stringify({品类:"手机壳",选中商品数:products.length,
    所有SKU共有且唯一允许写入标题的属性:common,
    说明:common.length ? "只使用上述共有属性，其他属性均不可使用" : "没有共有材质和功能，只写品类，不得编造材质工艺卖点",
    各SKU仅供识别:products.map(p=>({id:p.id,sku:p.skuCode,model:p.model})).slice(0,15)
  }).slice(0,3800);
  let response;
  try {
    response = await fetchImpl(`${config.dify.baseUrl}/workflows/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.dify.apiKey}` },
      body: JSON.stringify({ inputs: { hot_link: hotLink, hot_title: hotTitle, product_info: productInfo,
        previous_title: previousTitle, feedback: common.length ? '中文前标题6到30字符，不含型号后缀，只用所有选中SKU共有的已证实属性。不要写否定功能。' : '这些SKU没有共有正向属性，请仅输出品类前标题：手机背壳保护套。禁止写无支架、不带支架或任何材质和工艺。',
        ip_blacklist: '图拉斯,TORRAS,CASETiFY,全网最低,第一,顶级,绝对,无毒,认证' },
        response_mode: 'blocking', user: `lingshang-${crypto.randomUUID()}` }),
      signal: AbortSignal.timeout(config.dify.timeoutMs)
    });
  } catch (error) {
    throw new AppError(error.name === 'TimeoutError' || error.name === 'AbortError' ? CODES.AGENT_TIMEOUT : CODES.AGENT_UPSTREAM,
      'Dify 请求未完成，请稍后重试');
  }
  const payload = await response.json().catch(()=>null);
  if (!response.ok || payload?.data?.status !== 'succeeded') {
    const error = payload?.data?.error || payload?.message || '';
    const message = /未能读取商品|关键词/.test(error)
      ? '未能获取商品信息，请粘贴包含「商品标题」的完整淘宝分享文案'
      : 'Dify 工作流执行失败，请检查运行记录后重试';
    throw new AppError(CODES.AGENT_UPSTREAM, message);
  }
  const outputs = payload.data.outputs || {};
  const keywords = parseKeywords(outputs.keywords ?? outputs.rewritten_keywords);
  if (!keywords.length) throw new AppError(CODES.AGENT_UPSTREAM, 'Dify 未返回有效商品关键词，请补充分享标题');
  const title = validatePrefix(outputs.title ?? outputs.rewritten_title ?? outputs._result, products);
  return { title, keywords, workflowRunId: payload.workflow_run_id || payload.data.id };
}
module.exports = { runDify, parseKeywords, validatePrefix };

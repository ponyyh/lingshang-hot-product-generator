// Accept either a URL or Taobao's complete share text. Never infer a title from a token.
const { AppError, CODES } = require('./errors');
function parseShareInput(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 6000) throw new AppError(CODES.BAD_REQUEST, '请输入有效链接或包含标题的商品分享文案');
  const match = raw.match(/https?:\/\/[^\s<>\[\]「」“”"']+/i);
  if (!match) throw new AppError(CODES.BAD_REQUEST, '请输入有效的 http/https 商品链接');
  const url = match[0].replace(/[)，。；]+$/, '');
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new AppError(CODES.BAD_REQUEST, '链接协议不支持');
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const { isBlockedAddress } = require('./linkInfo');
  if (parsed.username || parsed.password || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || (require("node:net").isIP(host) && isBlockedAddress(host))) {
    throw new AppError(CODES.BAD_REQUEST, '请使用公开商品页面链接');
  }
  const title = raw.match(/「([^」]{5,1000})」/)?.[1]?.trim() || '';
  return { url: parsed.href, title };
}
module.exports = { parseShareInput };

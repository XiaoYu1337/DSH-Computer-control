/**
 * 文本候选排序：可见性 > 用户偏好（button/link/input）> 精确文本 > 面积。
 * 让“开始游戏”这类多命中场景优先命中主按钮，而不是侧栏/说明文字。
 */

function normalize(value) {
  return String(value ?? '').replace(/\s+/gu, '').toLocaleLowerCase();
}

function inferKind(match) {
  const control = String(match?.controlType ?? '').toLocaleLowerCase();
  if (control === 'button') return 'button';
  if (control === 'hyperlink') return 'link';
  if (control === 'edit' || control === 'document') return control === 'edit' ? 'input' : 'text';
  const tag = String(match?.tag ?? '').toLocaleLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'input';
  if (tag === '') return 'text';
  return tag;
}

function preferredKinds(prefer) {
  switch (prefer) {
    case 'button':
      return new Set(['button', 'link', 'input']);
    case 'link':
      return new Set(['link']);
    case 'input':
      return new Set(['input']);
    default:
      return new Set();
  }
}

/**
 * @param {Array<object>} matches
 * @param {{query?: string, match?: 'contains'|'exact', prefer?: string}} options
 */
export function rankMatches(matches, options = {}) {
  const query = normalize(options.query ?? '');
  const exactOnly = options.match === 'exact';
  const prefer = preferredKinds(options.prefer);
  const scored = [];
  for (let index = 0; index < (matches?.length ?? 0); index += 1) {
    const match = matches[index];
    const text = normalize(match?.text);
    const width = Number(match?.w ?? 0);
    const height = Number(match?.h ?? 0);
    if (text.length === 0 || width <= 0 || height <= 0) continue;
    if (exactOnly ? text !== query : !text.includes(query)) continue;
    let score = 0;
    if (text === query) score += 120;
    else if (text.startsWith(query)) score += 60;
    else score += 30;
    const kind = inferKind(match);
    if (prefer.size > 0) {
      if (prefer.has(kind)) score += 90;
      if (options.prefer === 'button' && kind === 'input') score += 40;
      if (options.prefer === 'button' && kind === 'text') score -= 20;
    }
    if (kind === 'button' || kind === 'link') score += 25;
    score += Math.min(25, Math.log2(Math.max(1, width * height)) * 2);
    scored.push({ match, kind, score, index });
  }
  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const y = Number(left.match?.y ?? 0) - Number(right.match?.y ?? 0);
    if (y !== 0) return y;
    return Number(left.match?.x ?? 0) - Number(right.match?.x ?? 0);
  });
  return scored;
}

/**
 * 在 BrowserSession 上按文本找一个“最像按钮/链接”的元素并点击。
 * @param {object} session BrowserSession
 * @param {{text?: string, selector?: string, match?: string, prefer?: string, index?: number}} options
 */
export async function clickBestMatch(session, options = {}) {
  if (typeof options.selector === 'string' && options.selector.length > 0) {
    await session.click({ selector: options.selector });
    return { match: { text: options.selector, selector: options.selector }, candidates: 1 };
  }
  if (typeof options.text !== 'string' || options.text.trim().length === 0) {
    throw new Error('computer-control invalid-args: clickBestMatch needs text or selector');
  }
  const found = await session.find({
    text: options.text,
    match: options.match === 'exact' ? 'exact' : 'contains',
    max: 60,
  });
  const ranked = rankMatches(found.matches, {
    query: options.text,
    match: options.match === 'exact' ? 'exact' : 'contains',
    prefer: options.prefer,
  });
  if (ranked.length === 0) {
    const error = new Error(`computer-control text_not_found: no visible element matches ${JSON.stringify(options.text)}`);
    error.code = 'text_not_found';
    throw error;
  }
  const index = Math.max(0, Math.min(ranked.length - 1, Number.isInteger(options.index) ? options.index : 0));
  const chosen = ranked[index];
  const selector = chosen.match.selectorHint;
  if (typeof selector === 'string' && selector.length > 0) {
    try {
      await session.click({ selector });
      return { match: chosen.match, candidates: ranked.length, rank: index };
    } catch {
      // selectorHint 失效时退回文本点击
    }
  }
  // 文本点击需要它在同文本候选中的序号；用原始 find 顺序计算。
  const sameText = found.matches
    .map((match, originalIndex) => ({ match, originalIndex }))
    .filter((item) => normalize(item.match.text) === normalize(chosen.match.text));
  const position = Math.max(0, sameText.findIndex((item) => item.match === chosen.match));
  await session.click({ text: chosen.match.text, index: position, match: 'exact' });
  return { match: chosen.match, candidates: ranked.length, rank: index };
}

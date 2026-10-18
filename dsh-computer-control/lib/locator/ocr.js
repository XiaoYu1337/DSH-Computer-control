/** Windows.Media.Ocr 文本定位（Canvas/游戏/无 DOM 场景兜底）。 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPowerShellScript } from '../ps.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', '..', 'scripts', 'ocr-text.ps1');

export async function ocrImage(path, runOptions = {}) {
  const args = ['-Path', path];
  if (typeof runOptions.language === 'string' && runOptions.language.length > 0) {
    args.push('-Language', runOptions.language);
  }
  return await runPowerShellScript(SCRIPT, args, {
    signal: runOptions.signal,
    timeoutMs: runOptions.timeoutMs ?? 20_000,
  });
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/gu, '').toLocaleLowerCase();
}

function matchesQuery(text, query, match) {
  const value = normalizeText(text);
  const needle = normalizeText(query);
  if (match === 'exact') return value === needle;
  return value.includes(needle);
}

/**
 * 在 OCR 结果里找 query。
 * 行与词都参与排序：Canvas 按钮通常只有一个短词（“同意”/“开始游戏”），
 * 而说明段落是长行；用“精确文本 + 紧凑面积 + 按钮比例”压过段落。
 * @param {{lines?: Array, words?: Array}} result
 * @param {string} query
 * @param {'contains'|'exact'} match
 */
export function searchOcr(result, query, match = 'contains') {
  const candidates = [];
  const seen = new Set();
  const push = (entry, kind) => {
    const key = `${kind}:${entry.text}:${Math.round(entry.x)}:${Math.round(entry.y)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const text = normalizeText(entry.text);
    const needle = normalizeText(query);
    const width = Math.max(0, Number(entry.w ?? 0));
    const height = Math.max(0, Number(entry.h ?? 0));
    const area = width * height;
    let score = 0;
    if (text === needle) score += 140;
    else if (text.startsWith(needle)) score += 60;
    else score += 20;
    if (kind === 'word') score += 45;
    // 短小、横向的 OCR 片段更像按钮；长段落降权。
    if (area > 0 && area < 40_000 && height >= 10 && height <= 90 && width / Math.max(1, height) >= 1.2) score += 35;
    if (height > 120 || width > 700) score -= 30;
    score -= Math.min(30, Math.max(0, text.length - needle.length) * 1.5);
    if (typeof entry.confidence === 'number') score += Math.min(10, entry.confidence * 10);
    candidates.push({
      text: String(entry.text ?? ''),
      x: Number(entry.x ?? 0),
      y: Number(entry.y ?? 0),
      w: width,
      h: height,
      confidence: typeof entry.confidence === 'number' ? entry.confidence : undefined,
      kind,
      score: Math.round(score * 10) / 10,
    });
  };

  for (const line of Array.isArray(result.lines) ? result.lines : []) {
    if (matchesQuery(line.text, query, match)) push(line, 'line');
  }
  for (const word of Array.isArray(result.words) ? result.words : []) {
    if (matchesQuery(word.text, query, match)) push(word, 'word');
  }
  candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.kind === 'word' && left.kind !== 'word') return 1;
    if (left.kind === 'word' && right.kind !== 'word') return -1;
    return Number(right.y) - Number(left.y);
  });
  return candidates;
}

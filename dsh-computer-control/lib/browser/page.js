/**
 * High-level browser page session for the DSH computer-control plugin.
 *
 * Security model:
 *  - Callers can never pass JavaScript. Every interaction runs one of the fixed
 *    snippets in this module through `Runtime.evaluate` (arguments are embedded as
 *    JSON data only).
 *  - `read()` extracts `document.body.innerText` and visible link labels/hrefs; it
 *    never reads form-control values, passwords or input contents.
 *
 * Public API (also consumed by lib/browser-tools.js):
 *   class BrowserSession {
 *     static launch({url, timeoutMs?}) -> BrowserSession
 *     static attach({port, targetId?}) -> BrowserSession
 *     url(), title()
 *     navigate(url, {waitUntil='load', timeoutMs=15000, quietMs=300})
 *     read({maxChars=12000, includeLinks=true}) -> {url, title, text, links}
 *     find({text, selector, index=0, match='contains', max=20})
 *       -> {url, title, matches:[{text, tag, selectorHint, x, y, w, h}]}
 *     click({text, selector, index=0, button='left', clickCount=1, match='contains'})
 *     fill({text, selector, value, submit=false})
 *     press(key)
 *     waitFor({for:'text'|'url'|'selector', value, timeoutMs=15000})
 *     screenshotHash() -> sha256 hex
 *     close()
 *   }
 *
 * Every failure carries `.code` in:
 *   browser_not_launched | attach_failed | target_not_found | navigation_timeout |
 *   text_not_found | ambiguous_text | cdp_error
 */

import crypto from 'node:crypto';
import { launchEdge } from './launch.js';
import { CdpClient, cdpError, ERROR_CODES, getVersion, listTargets } from './cdp.js';

const DEFAULT_TIMEOUT_MS = 15_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Pick the most useful page target. Edge can expose internal WebUI pages
 * (e.g. edge://sync-confirmation-dialog/) as `page` targets; prefer real http(s)
 * content, then any non-edge:// page.
 */
function pickPageTarget(pages, preferredHost = '') {
  const usable = pages.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  if (preferredHost) {
    const matching = usable.find((target) => target.url.toLowerCase().includes(preferredHost));
    if (matching) return matching;
  }
  return (
    usable.find((target) => /^https?:/i.test(target.url)) ??
    usable.find((target) => !target.url.toLowerCase().startsWith('edge://')) ??
    usable[0] ??
    null
  );
}

/* ======================================================================== *
 * Fixed page snippets. They are standard JS source, never caller-provided.
 * `String.raw` keeps regex escapes intact when embedding these in expressions.
 * ======================================================================== */

const LOCATE_HELPERS = String.raw`
function __ccVisible(el) {
  if (!el || el.nodeType !== 1 || !el.getBoundingClientRect) return false;
  var rects = el.getClientRects ? el.getClientRects() : null;
  if (!rects || rects.length === 0) return false;
  var rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  var style = window.getComputedStyle(el);
  if (!style) return false;
  if (style.visibility === 'hidden' || style.display === 'none') return false;
  if (parseFloat(style.opacity || '1') === 0) return false;
  return true;
}
function __ccNorm(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}
function __ccCssPath(el) {
  var parts = [];
  var node = el;
  for (var depth = 0; node && node.nodeType === 1 && depth < 4; depth++) {
    var tag = String(node.tagName || '').toLowerCase();
    if (!tag || tag === 'html') break;
    var id = String(node.id || '');
    if (id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) {
      parts.unshift('#' + id);
      break;
    }
    var part = tag;
    var classNames = [];
    var classes = node.classList ? Array.prototype.slice.call(node.classList) : [];
    for (var ci = 0; ci < classes.length && classNames.length < 2; ci++) {
      if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(classes[ci])) classNames.push(classes[ci]);
    }
    if (classNames.length > 0) part += '.' + classNames.join('.');
    var parent = node.parentElement;
    if (parent) {
      var same = [];
      for (var pi = 0; pi < parent.children.length; pi++) {
        if (parent.children[pi].tagName === node.tagName) same.push(parent.children[pi]);
      }
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ');
}
function __ccLocate(opts) {
  opts = opts || {};
  var query = __ccNorm(opts.text || '');
  var needle = query.toLowerCase();
  var selector = String(opts.selector || '');
  var exact = opts.match === 'exact';
  var limit = Math.max(1, Math.min(Number(opts.max) || 20, 200));
  var scope = document.body || document.documentElement;
  var result = {
    url: String(location.href),
    title: String(document.title || ''),
    matches: [],
    invalidSelector: ''
  };
  if (!scope) return result;
  var skipped = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, META: 1, LINK: 1, HEAD: 1, TITLE: 1, HTML: 1, BODY: 1 };
  var candidates = [];
  var domIndex = 0;
  if (selector) {
    try {
      candidates = Array.prototype.slice.call(scope.querySelectorAll(selector));
    } catch (error) {
      result.invalidSelector = String((error && error.message) || error);
      return result;
    }
    for (var si = 0; si < candidates.length; si++) candidates[si].__ccDom = si;
    if (needle) {
      candidates = candidates.filter(function (el) {
        return __ccNorm(el.innerText || el.textContent || '').toLowerCase().indexOf(needle) >= 0;
      });
    }
  } else {
    if (!needle) return result;
    var all = scope.querySelectorAll('*');
    for (var ai = 0; ai < all.length; ai++) {
      var el = all[ai];
      if (skipped[el.tagName]) continue;
      var text = __ccNorm(el.innerText || '');
      if (!text) continue;
      var lower = text.toLowerCase();
      var hit = exact ? lower === needle : lower.indexOf(needle) >= 0;
      if (!hit) continue;
      el.__ccDom = domIndex++;
      candidates.push(el);
    }
  }
  var entries = [];
  for (var ci = 0; ci < candidates.length; ci++) {
    var candidate = candidates[ci];
    if (!__ccVisible(candidate)) continue;
    var candidateText = __ccNorm(candidate.innerText || '');
    var rect = candidate.getBoundingClientRect();
    var tagName = String(candidate.tagName || '').toLowerCase();
    var role = candidate.getAttribute ? (candidate.getAttribute('role') || '') : '';
    var interactive = tagName === 'a' || tagName === 'button' || tagName === 'input' || tagName === 'textarea' || tagName === 'select' ||
      candidate.isContentEditable === true || /^(button|link|menuitem|tab|option|checkbox|radio|switch)$/.test(role);
    var score = 0;
    if (needle) {
      if (exact && candidateText.toLowerCase() === needle) score += 100;
      score += Math.max(0, 60 - Math.min(60, Math.abs(candidateText.length - needle.length)));
    }
    if (interactive) score += 40;
    if (tagName === 'h1' || tagName === 'h2' || tagName === 'h3') score += 12;
    if (tagName === 'div' || tagName === 'span' || tagName === 'p' || tagName === 'li') score -= 6;
    if (needle && candidate.children && candidate.children.length > 0) {
      var childLimit = Math.min(candidate.children.length, 40);
      for (var ki = 0; ki < childLimit; ki++) {
        var childText = __ccNorm(candidate.children[ki].innerText || '').toLowerCase();
        var childHit = exact ? childText === needle : childText.indexOf(needle) >= 0;
        if (childHit) {
          score -= 25;
          break;
        }
      }
    }
    if (rect.width < 8 || rect.height < 8) score -= 30;
    score -= Math.min(20, Math.max(0, rect.top) / 400);
    entries.push({
      el: candidate,
      text: candidateText,
      tag: tagName,
      role: role,
      interactive: interactive,
      rect: rect,
      score: score,
      dom: typeof candidate.__ccDom === 'number' ? candidate.__ccDom : 1e9
    });
  }
  var domOrderOnly = Boolean(selector) && !needle;
  if (domOrderOnly) {
    entries.sort(function (a, b) { return a.dom - b.dom; });
  } else {
    entries.sort(function (a, b) {
      return (b.score - a.score) || (a.dom - b.dom) || (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left);
    });
  }
  var seen = new Set();
  for (var ei = 0; ei < entries.length && result.matches.length < limit; ei++) {
    var entry = entries[ei];
    if (seen.has(entry.el)) continue;
    seen.add(entry.el);
    result.matches.push({
      el: entry.el,
      text: entry.text.slice(0, 300),
      tag: entry.tag,
      role: entry.role || undefined,
      interactive: entry.interactive || undefined,
      selectorHint: __ccCssPath(entry.el),
      x: Math.round(entry.rect.left * 100) / 100,
      y: Math.round(entry.rect.top * 100) / 100,
      w: Math.round(entry.rect.width * 100) / 100,
      h: Math.round(entry.rect.height * 100) / 100,
      href: entry.tag === 'a' && entry.el.href ? String(entry.el.href) : undefined
    });
  }
  return result;
}
function __ccPublic(result) {
  var matches = [];
  for (var i = 0; i < result.matches.length; i++) {
    var match = result.matches[i];
    matches.push({
      text: match.text,
      tag: match.tag,
      role: match.role,
      interactive: match.interactive,
      selectorHint: match.selectorHint,
      x: match.x,
      y: match.y,
      w: match.w,
      h: match.h,
      href: match.href
    });
  }
  return {
    url: result.url,
    title: result.title,
    matches: matches,
    invalidSelector: result.invalidSelector || undefined
  };
}
`;

const EDIT_HELPERS = String.raw`
function __ccEditable(el) {
  var tag = String(el.tagName || '').toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input') {
    var type = String(el.getAttribute('type') || 'text').toLowerCase();
    return ['hidden', 'checkbox', 'radio', 'file', 'submit', 'button', 'image', 'reset', 'range', 'color',
      'date', 'time', 'datetime-local', 'month', 'week'].indexOf(type) < 0;
  }
  return el.isContentEditable === true || el.getAttribute('role') === 'textbox' || el.getAttribute('role') === 'searchbox';
}
function __ccLabelText(el) {
  var parts = [];
  var id = String(el.id || '');
  if (id) {
    try {
      var label = document.querySelector('label[for="' + id.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]');
      if (label) parts.push(label.innerText || '');
    } catch (error) {}
  }
  try {
    var closest = el.closest ? el.closest('label') : null;
    if (closest) parts.push(closest.innerText || '');
  } catch (error) {}
  return parts.join(' ');
}
function __ccFindEditable(opts) {
  opts = opts || {};
  var selector = String(opts.selector || '');
  var needle = __ccNorm(opts.text || '').toLowerCase();
  var scope = document.body || document.documentElement;
  var result = { url: String(location.href), title: String(document.title || ''), matches: [], invalidSelector: '' };
  if (!scope) return result;
  var elements = [];
  if (selector) {
    try {
      elements = Array.prototype.slice.call(scope.querySelectorAll(selector));
    } catch (error) {
      result.invalidSelector = String((error && error.message) || error);
      return result;
    }
  } else {
    elements = Array.prototype.slice.call(scope.querySelectorAll(
      'input, textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="searchbox"]'
    ));
  }
  for (var i = 0; i < elements.length && result.matches.length < 20; i++) {
    var el = elements[i];
    if (!__ccVisible(el)) continue;
    if (!selector && !__ccEditable(el)) continue;
    if (needle) {
      var haystack = __ccNorm([
        el.getAttribute('placeholder'),
        el.getAttribute('aria-label'),
        el.getAttribute('name'),
        el.id,
        __ccLabelText(el)
      ].join(' ')).toLowerCase();
      if (haystack.indexOf(needle) < 0) continue;
    }
    var rect = el.getBoundingClientRect();
    result.matches.push({
      el: el,
      text: __ccNorm(el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('name') || el.id || '').slice(0, 300),
      tag: String(el.tagName || '').toLowerCase(),
      selectorHint: __ccCssPath(el),
      x: Math.round(rect.left * 100) / 100,
      y: Math.round(rect.top * 100) / 100,
      w: Math.round(rect.width * 100) / 100,
      h: Math.round(rect.height * 100) / 100,
      editable: __ccEditable(el)
    });
  }
  return result;
}
`;

const URL_TITLE_EXPR = String.raw`(() => ({
  url: String(location.href),
  title: String(document.title || ''),
  readyState: String(document.readyState || '')
}))()`;

const READY_STATE_EXPR = String.raw`String(document.readyState || '')`;

const SELECT_ALL_EXPR = String.raw`(() => {
  var el = document.activeElement;
  if (!el) return false;
  var tag = String(el.tagName || '').toLowerCase();
  if ((tag === 'input' || tag === 'textarea') && typeof el.select === 'function') {
    el.select();
    return true;
  }
  if (el.isContentEditable) {
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    } catch (error) {
      return false;
    }
  }
  return false;
})()`;

const DISPATCH_CHANGE_EXPR = String.raw`(() => {
  var el = document.activeElement;
  if (!el) return false;
  try {
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (error) {}
  return true;
})()`;

// Last-resort submit path used by fill({submit:true}) when synthetic Enter did not
// start a navigation (e.g. an occluded window or a site that swallows key events).
const SUBMIT_FORM_EXPR = String.raw`(() => {
  var el = document.activeElement;
  if (!el) return 'no_active_element';
  var form = el.form || (el.closest ? el.closest('form') : null);
  if (form) {
    try {
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
        return 'requestSubmit';
      }
      if (typeof form.submit === 'function') {
        form.submit();
        return 'form.submit';
      }
    } catch (error) {
      return 'form_error:' + String(error && error.message || error);
    }
  }
  var button = document.querySelector(
    'button[type="submit"], input[type="submit"], #sb_form_go, #search_go, ' +
    'button[aria-label*="搜索"], button[title*="搜索"], button[aria-label*="Search"], button[title*="Search"]'
  );
  if (button) {
    try {
      button.click();
      return 'submit_button_click';
    } catch (error) {
      return 'button_error:' + String(error && error.message || error);
    }
  }
  return 'no_form';
})()`;

function readExpression(args) {
  return String.raw`(() => {
  var opts = ${JSON.stringify(args)};
  var maxChars = Math.max(100, Math.min(Number(opts.maxChars) || 12000, 200000));
  var includeLinks = opts.includeLinks !== false;
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (parseFloat(style.opacity || '1') === 0) return false;
    return true;
  }
  var text = '';
  if (document.body) text = String(document.body.innerText || '');
  text = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > maxChars) text = text.slice(0, maxChars);
  var links = [];
  if (includeLinks) {
    var seen = {};
    var anchors = document.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length && links.length < 200; i++) {
      var anchor = anchors[i];
      if (!visible(anchor)) continue;
      var label = String(anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim();
      if (!label) continue;
      var href = '';
      try {
        href = anchor.href;
      } catch (error) {
        continue;
      }
      if (!/^https?:\/\//i.test(href)) continue;
      var key = href + '\u0000' + label.slice(0, 80);
      if (seen[key]) continue;
      seen[key] = 1;
      links.push({ text: label.slice(0, 200), url: href });
    }
  }
  return {
    url: String(location.href),
    title: String(document.title || ''),
    text: text,
    links: links
  };
})()`;
}

function findExpression(args) {
  return String.raw`(() => {
${LOCATE_HELPERS}
return __ccPublic(__ccLocate(${JSON.stringify(args)}));
})()`;
}

const IFRAME_RECTS_EXPR = String.raw`(() => {
  var list = [];
  var frames = document.querySelectorAll('iframe');
  for (var i = 0; i < frames.length && list.length < 30; i++) {
    var frame = frames[i];
    var rect = frame.getBoundingClientRect();
    list.push({
      name: String(frame.getAttribute('name') || ''),
      id: String(frame.id || ''),
      src: String(frame.src || ''),
      x: Math.round(rect.left * 100) / 100,
      y: Math.round(rect.top * 100) / 100,
      w: Math.round(rect.width * 100) / 100,
      h: Math.round(rect.height * 100) / 100
    });
  }
  return list;
})()`;

function fieldsExpression() {
  return String.raw`(() => {
${LOCATE_HELPERS}
${EDIT_HELPERS}
var result = { url: String(location.href), title: String(document.title || ''), fields: [], frames: [] };
var iframes = document.querySelectorAll('iframe');
for (var fi = 0; fi < iframes.length && result.frames.length < 30; fi++) {
  var frame = iframes[fi];
  if (!__ccVisible(frame)) continue;
  var frameRect = frame.getBoundingClientRect();
  var sameOrigin = false;
  try { sameOrigin = Boolean(frame.contentDocument); } catch (frameError) { sameOrigin = false; }
  result.frames.push({
    src: String(frame.src || ''),
    id: String(frame.id || ''),
    name: String(frame.getAttribute('name') || ''),
    sameOrigin: sameOrigin,
    x: Math.round(frameRect.left * 100) / 100,
    y: Math.round(frameRect.top * 100) / 100,
    w: Math.round(frameRect.width * 100) / 100,
    h: Math.round(frameRect.height * 100) / 100
  });
}
var nodes = document.querySelectorAll(
  'input, textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="searchbox"]'
);
for (var i = 0; i < nodes.length && result.fields.length < 100; i++) {
  var el = nodes[i];
  if (!__ccVisible(el)) continue;
  var tag = String(el.tagName || '').toLowerCase();
  var type = tag === 'input' ? String(el.getAttribute('type') || 'text').toLowerCase() : '';
  if (tag === 'input' && (type === 'hidden' || type === 'file')) continue;
  if (!__ccEditable(el)) continue;
  var rect = el.getBoundingClientRect();
  result.fields.push({
    index: result.fields.length,
    tag: tag,
    type: type,
    name: String(el.getAttribute('name') || ''),
    id: String(el.id || ''),
    placeholder: String(el.getAttribute('placeholder') || ''),
    ariaLabel: String(el.getAttribute('aria-label') || ''),
    label: __ccNorm(__ccLabelText(el)).slice(0, 120),
    valueLength: String(el.value == null ? '' : el.value).length,
    readOnly: Boolean(el.readOnly),
    disabled: Boolean(el.disabled),
    selectorHint: __ccCssPath(el),
    x: Math.round(rect.left * 100) / 100,
    y: Math.round(rect.top * 100) / 100,
    w: Math.round(rect.width * 100) / 100,
    h: Math.round(rect.height * 100) / 100
  });
}
return result;
})()`;
}

function clickExpression(args) {
  return String.raw`(() => {
${LOCATE_HELPERS}
var opts = ${JSON.stringify(args)};
var result = __ccLocate(opts);
if (result.invalidSelector) return { reason: 'invalid_selector', message: result.invalidSelector };
if (!result.matches.length) return { reason: 'not_found', url: result.url, title: result.title };
var index = opts.index == null ? 0 : opts.index;
if (index < 0 || index >= result.matches.length) {
  return { reason: 'index_out_of_range', count: result.matches.length, url: result.url, title: result.title };
}
var match = result.matches[index];
var el = match.el;
// Keep semantic clicks inside the controlled tab: links that would open a popup
// (target=_blank) are retargeted to the current page. Real CDP mouse input below
// still performs the click, so site handlers/counters see an ordinary click.
try {
  if (el.tagName === 'A' && el.getAttribute('target') === '_blank') el.setAttribute('target', '_self');
} catch (targetError) {}
try {
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
} catch (scrollError) {
  try { el.scrollIntoView(); } catch (ignore) {}
}
// Deliberately synchronous: requestAnimationFrame is throttled/suspended when the
// Edge window is occluded (e.g. behind the DSH window), which would leave an
// awaitPromise Runtime.evaluate pending until the CDP timeout. scrollIntoView with
// behavior 'auto' is instant and getBoundingClientRect forces layout, so no frame
// wait is needed to obtain the final click coordinates.
if (!el.isConnected) return { reason: 'detached' };
var rect = el.getBoundingClientRect();
if (opts.domClick === true) {
  try {
    el.click();
  } catch (clickError) {
    return { reason: 'dom_click_failed', message: String(clickError && clickError.message || clickError) };
  }
  return {
    ok: true,
    domClick: true,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    target: __ccPublic({ matches: [match] }).matches[0],
    rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
    url: String(location.href),
    title: String(document.title || '')
  };
}
var x = rect.left + rect.width / 2;
var y = rect.top + rect.height / 2;
x = Math.min(Math.max(x, 1), Math.max(1, window.innerWidth - 2));
y = Math.min(Math.max(y, 1), Math.max(1, window.innerHeight - 2));
return {
  ok: true,
  x: x,
  y: y,
  target: __ccPublic({ matches: [match] }).matches[0],
  rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
  url: String(location.href),
  title: String(document.title || '')
};
})()`;
}

function fillExpression(args) {
  return String.raw`(() => {
${LOCATE_HELPERS}
${EDIT_HELPERS}
var opts = ${JSON.stringify(args)};
var result = __ccFindEditable(opts);
var invalid = result.invalidSelector;
if (invalid) return { reason: 'invalid_selector', message: invalid };
if (!result.matches.length) return { reason: 'not_found', url: result.url, title: result.title };
var index = opts.index;
if (!opts.selector && (index === null || index === undefined)) {
  if (result.matches.length > 1) {
    return { reason: 'ambiguous', matches: __ccPublic({ matches: result.matches }), url: result.url, title: result.title };
  }
  index = 0;
}
if (index === null || index === undefined) index = 0;
if (index < 0 || index >= result.matches.length) {
  return { reason: 'index_out_of_range', count: result.matches.length };
}
var target = result.matches[index];
var el = target.el;
try {
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
} catch (scrollError) {
  try { el.scrollIntoView(); } catch (ignore) {}
}
try { el.focus(); } catch (focusError) {}
// Synchronous on purpose: no rAF wait here. An occluded Edge window suspends
// requestAnimationFrame, which would hang Runtime.evaluate{awaitPromise:true}.
if (!el.isConnected) return { reason: 'detached' };
var rect = el.getBoundingClientRect();
var tag = String(el.tagName || '').toLowerCase();
var method = '';
var ok = false;
var valueLength = 0;
if (tag === 'input' || tag === 'textarea') {
  try {
    var proto = tag === 'input' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(el, opts.value);
    else el.value = opts.value;
    ok = String(el.value) === String(opts.value);
    valueLength = String(el.value == null ? '' : el.value).length;
  } catch (setError) {
    ok = false;
  }
  if (ok) {
    try {
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (eventError) {}
    method = 'setter';
  }
} else if (el.isContentEditable) {
  method = 'contenteditable';
}
var submitted = false;
if (opts.submit === true && ok) {
  try {
    if (el.form && typeof el.form.requestSubmit === 'function') {
      el.form.requestSubmit();
      submitted = true;
    } else if (el.form) {
      el.form.submit();
      submitted = true;
    }
  } catch (submitError) {
    submitted = false;
  }
}
return {
  ok: ok,
  method: method,
  submitted: submitted,
  target: {
    text: target.text,
    tag: target.tag,
    selectorHint: target.selectorHint,
    x: rect.left,
    y: rect.top,
    w: rect.width,
    h: rect.height
  },
  rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
  valueLength: valueLength,
  url: String(location.href),
  title: String(document.title || '')
};
})()`;
}

function hasTextExpression(args) {
  return String.raw`(() => {
  var opts = ${JSON.stringify(args)};
  var needle = String(opts.value == null ? '' : opts.value);
  var haystack = document.body ? String(document.body.innerText || '') : '';
  var index = haystack.toLowerCase().indexOf(needle.toLowerCase());
  return {
    found: index >= 0,
    url: String(location.href),
    title: String(document.title || ''),
    excerpt: index >= 0 ? haystack.slice(Math.max(0, index - 40), index + needle.length + 80).replace(/\s+/g, ' ').trim() : ''
  };
})()`;
}

function urlWaitExpression(args) {
  return String.raw`(() => {
  var opts = ${JSON.stringify(args)};
  var needle = String(opts.value == null ? '' : opts.value).toLowerCase();
  var url = String(location.href);
  return {
    found: url.toLowerCase().indexOf(needle) >= 0,
    url: url,
    title: String(document.title || '')
  };
})()`;
}

function selectorWaitExpression(args) {
  return String.raw`(() => {
${LOCATE_HELPERS}
var result = __ccLocate(${JSON.stringify({ ...args, text: '', max: 1 })});
if (result.invalidSelector) return { found: false, invalidSelector: result.invalidSelector };
var publicResult = __ccPublic(result);
return {
  found: publicResult.matches.length > 0,
  url: publicResult.url,
  title: publicResult.title,
  match: publicResult.matches[0]
};
})()`;
}

/* ======================================================================== *
 * Keyboard definitions
 * ======================================================================== */

const KEY_SPECS = new Map([
  ['enter', { key: 'Enter', code: 'Enter', vk: 13, text: '\r' }],
  ['return', { key: 'Enter', code: 'Enter', vk: 13, text: '\r' }],
  ['tab', { key: 'Tab', code: 'Tab', vk: 9 }],
  ['escape', { key: 'Escape', code: 'Escape', vk: 27 }],
  ['esc', { key: 'Escape', code: 'Escape', vk: 27 }],
  ['backspace', { key: 'Backspace', code: 'Backspace', vk: 8 }],
  ['delete', { key: 'Delete', code: 'Delete', vk: 46 }],
  ['arrowup', { key: 'ArrowUp', code: 'ArrowUp', vk: 38 }],
  ['arrowdown', { key: 'ArrowDown', code: 'ArrowDown', vk: 40 }],
  ['arrowleft', { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 }],
  ['arrowright', { key: 'ArrowRight', code: 'ArrowRight', vk: 39 }],
  ['up', { key: 'ArrowUp', code: 'ArrowUp', vk: 38 }],
  ['down', { key: 'ArrowDown', code: 'ArrowDown', vk: 40 }],
  ['left', { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 }],
  ['right', { key: 'ArrowRight', code: 'ArrowRight', vk: 39 }],
  ['home', { key: 'Home', code: 'Home', vk: 36 }],
  ['end', { key: 'End', code: 'End', vk: 35 }],
  ['pageup', { key: 'PageUp', code: 'PageUp', vk: 33 }],
  ['pagedown', { key: 'PageDown', code: 'PageDown', vk: 34 }],
  ['space', { key: ' ', code: 'Space', vk: 32, text: ' ' }],
]);

function keySpecFor(name) {
  const lowered = name.toLowerCase();
  if (KEY_SPECS.has(lowered)) return { ...KEY_SPECS.get(lowered) };
  if (/^[a-z]$/.test(lowered)) {
    return { key: lowered, code: `Key${lowered.toUpperCase()}`, vk: lowered.toUpperCase().charCodeAt(0) };
  }
  if (/^[0-9]$/.test(name)) {
    return { key: name, code: `Digit${name}`, vk: name.charCodeAt(0) };
  }
  throw cdpError(ERROR_CODES.CDP_ERROR, `Unsupported key: ${JSON.stringify(name)}`);
}

function parseChord(chord) {
  if (typeof chord !== 'string' || chord.trim().length === 0) {
    throw cdpError(ERROR_CODES.CDP_ERROR, 'press needs a non-empty key chord');
  }
  const parts = chord.trim().split('+');
  const keyName = parts.pop();
  if (!keyName) throw cdpError(ERROR_CODES.CDP_ERROR, `Invalid key chord: ${JSON.stringify(chord)}`);
  const modifiers = parts.map((part) => part.trim().toLowerCase());
  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  for (const modifier of modifiers) {
    if (modifier === 'ctrl' || modifier === 'control') ctrl = true;
    else if (modifier === 'alt' || modifier === 'option') alt = true;
    else if (modifier === 'shift') shift = true;
    else if (modifier === 'meta' || modifier === 'cmd' || modifier === 'command' || modifier === 'win') meta = true;
    else throw cdpError(ERROR_CODES.CDP_ERROR, `Unsupported modifier: ${JSON.stringify(modifier)}`);
  }
  const spec = keySpecFor(keyName);
  const modifierMask = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
  if (shift && !ctrl && !alt && !meta && /^[a-z]$/.test(spec.key)) {
    spec.key = spec.key.toUpperCase();
    spec.text = spec.key;
  }
  return { spec, modifiers: modifierMask };
}

/* ======================================================================== *
 * BrowserSession
 * ======================================================================== */

export class BrowserSession {
  #port;
  #targetId;
  #client;
  #sessionId;
  #launcher;
  #owned;
  #closed = false;
  #closePromise = null;
  #liveTargets = new Map();
  #frameSessions = new Map();
  #autoAttachEnabled = false;

  constructor(internal) {
    this.#port = internal.port;
    this.#targetId = internal.targetId;
    this.#client = internal.client;
    this.#sessionId = internal.sessionId;
    this.#launcher = internal.launcher ?? null;
    this.#owned = Boolean(internal.launcher);
    this.#liveTargets = new Map([
      [this.#targetId, { targetId: this.#targetId, type: 'page', url: '' }],
    ]);
    // Track page targets for semantic click-to-popup following. Target discovery is
    // enabled after construction (Target.setDiscoverTargets in attachToPort).
    this.#client.on('Target.targetCreated', (params) => this.#trackTarget(params?.targetInfo));
    this.#client.on('Target.targetInfoChanged', (params) => this.#trackTarget(params?.targetInfo));
    this.#client.on('Target.targetDestroyed', (params) => {
      if (params?.targetId) this.#liveTargets.delete(params.targetId);
    });
    // OOPIF auto-attach: Chromium attaches cross-origin iframe targets and gives us
    // a flat session id we can evaluate fields/fill in.
    this.#client.on('Target.attachedToTarget', (params) => {
      const info = params?.targetInfo;
      if (info?.targetId && /^(iframe|page)$/i.test(String(info.type ?? ''))) {
        this.#frameSessions.set(info.targetId, params.sessionId);
      }
    });
    this.#client.on('Target.detachedFromTarget', (params) => {
      if (params?.sessionId) {
        for (const [targetId, sessionId] of this.#frameSessions) {
          if (sessionId === params.sessionId) this.#frameSessions.delete(targetId);
        }
      }
    });
  }

  #trackTarget(info) {
    if (!info || typeof info.targetId !== 'string' || info.targetId.length === 0) return;
    this.#liveTargets.set(info.targetId, {
      targetId: info.targetId,
      type: String(info.type ?? ''),
      url: String(info.url ?? ''),
      title: String(info.title ?? ''),
      openerId: info.openerId ?? null,
    });
  }

  get port() {
    return this.#port;
  }

  get targetId() {
    return this.#targetId;
  }

  get sessionId() {
    return this.#sessionId;
  }

  get launcher() {
    return this.#launcher;
  }

  get closed() {
    return this.#closed || this.#client.closed;
  }

  /**
   * Launch a dedicated, isolated Edge instance and attach to its page target.
   * @param {{url: string, timeoutMs?: number}} options
   * @returns {Promise<BrowserSession>}
   */
  static async launch(options = {}) {
    const url = typeof options.url === 'string' && options.url.length > 0 ? options.url : 'about:blank';
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 20_000;
    let launcher;
    try {
      launcher = await launchEdge({ url, timeoutMs, ...(options.edgePath ? { edgePath: options.edgePath } : {}) });
    } catch (error) {
      if (error && error.code) throw error;
      throw cdpError(ERROR_CODES.BROWSER_NOT_LAUNCHED, `Failed to launch Edge: ${error?.message ?? String(error)}`, {
        cause: error,
      });
    }

    try {
      const target = await waitForPageTarget(launcher.port, url, Math.min(timeoutMs, 15_000));
      const session = await attachToPort(launcher.port, target.id, launcher);
      await session.#settleInitialPage(url, timeoutMs);
      return session;
    } catch (error) {
      await launcher.close();
      if (error && error.code) throw error;
      throw cdpError(ERROR_CODES.ATTACH_FAILED, `Failed to attach to the launched Edge page: ${error?.message ?? String(error)}`, {
        cause: error,
      });
    }
  }

  /**
   * Attach to an already-running Edge DevTools endpoint.
   * @param {{port: number, targetId?: string, timeoutMs?: number}} options
   * @returns {Promise<BrowserSession>}
   */
  static async attach(options = {}) {
    const port = options.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw cdpError(ERROR_CODES.ATTACH_FAILED, `attach requires a valid loopback port, got ${JSON.stringify(port)}`, { port });
    }
    let target;
    if (options.targetId) {
      target = { id: options.targetId };
      const targets = await listTargets(port, { timeoutMs: options.timeoutMs ?? 5000 });
      const found = targets.find((entry) => entry.id === options.targetId);
      if (!found) {
        throw cdpError(ERROR_CODES.TARGET_NOT_FOUND, `No CDP target with id ${options.targetId}`, { port, targetId: options.targetId });
      }
      if (found.type !== 'page') {
        throw cdpError(ERROR_CODES.TARGET_NOT_FOUND, `Target ${options.targetId} is type "${found.type}", not a page`, {
          port,
          targetId: options.targetId,
          targetType: found.type,
        });
      }
    } else {
      const targets = await listTargets(port, { timeoutMs: options.timeoutMs ?? 5000 });
      target = pickPageTarget(targets);
      if (!target) {
        throw cdpError(ERROR_CODES.TARGET_NOT_FOUND, 'No page target is available on this DevTools port', {
          port,
          available: targets.map((entry) => ({ id: entry.id, type: entry.type, url: entry.url })),
        });
      }
    }
    return await attachToPort(port, target.id, null);
  }

  /* ----------------------------------------------------------------- actions */

  /** @returns {Promise<string>} current location.href */
  async url() {
    const state = await this.#evaluate(URL_TITLE_EXPR, { timeoutMs: 4000 });
    return String(state?.url ?? '');
  }

  /** @returns {Promise<string>} current document.title */
  async title() {
    const state = await this.#evaluate(URL_TITLE_EXPR, { timeoutMs: 4000 });
    return String(state?.title ?? '');
  }

  /**
   * Switch the active session to another page target (popup/new window) on the same
   * DevTools endpoint. Attach uses a flat Target session on the existing browser
   * connection; launcher ownership is preserved so close() still closes the browser.
   * @param {string} targetId
   * @returns {Promise<{targetId: string, url: string, title: string}>}
   */
  async switchToTarget(targetId) {
    this.#assertOpen();
    if (typeof targetId !== 'string' || targetId.length === 0) {
      throw cdpError(ERROR_CODES.TARGET_NOT_FOUND, 'switchToTarget requires a target id', { port: this.#port });
    }
    if (targetId === this.#targetId) {
      return { targetId, url: await this.url().catch(() => ''), title: await this.title().catch(() => '') };
    }
    const targets = await listTargets(this.#port);
    const target = targets.find((entry) => entry.id === targetId);
    if (!target) {
      throw cdpError(ERROR_CODES.TARGET_NOT_FOUND, `No CDP target with id ${targetId}`, {
        port: this.#port,
        targetId,
        available: targets.map((entry) => ({ id: entry.id, type: entry.type, url: entry.url })),
      });
    }
    if (target.type !== 'page') {
      throw cdpError(ERROR_CODES.TARGET_NOT_FOUND, `Target ${targetId} is type "${target.type}", not a page`, {
        port: this.#port,
        targetId,
        targetType: target.type,
      });
    }
    const switched = await this.#switchSession(targetId);
    if (!switched) {
      throw cdpError(ERROR_CODES.ATTACH_FAILED, `Could not attach to target ${targetId}`, {
        port: this.#port,
        targetId,
      });
    }
    return { targetId, url: switched.url, title: await this.title().catch(() => '') };
  }

  /**
   * Navigate and wait for the requested load milestone.
   * @param {string} url
   * @param {{waitUntil?: 'load'|'domcontentloaded'|'commit', timeoutMs?: number, quietMs?: number}} [options]
   */
  async navigate(url, options = {}) {
    this.#assertOpen();
    let targetHref;
    try {
      targetHref = new URL(String(url)).href;
    } catch {
      throw cdpError(ERROR_CODES.CDP_ERROR, `navigate requires an absolute URL, got ${JSON.stringify(url)}`, { url });
    }
    const waitUntil = options.waitUntil ?? 'load';
    if (!['load', 'domcontentloaded', 'commit'].includes(waitUntil)) {
      throw cdpError(ERROR_CODES.CDP_ERROR, `Unsupported waitUntil ${JSON.stringify(waitUntil)}`);
    }
    const timeoutMs = clamp(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, 250, 120_000);
    const quietMs = Number.isFinite(options.quietMs) ? clamp(options.quietMs, 0, 5000) : waitUntil === 'load' ? 300 : 0;
    const deadline = Date.now() + timeoutMs;
    const cleanups = [];

    const eventPromise = (name) =>
      new Promise((resolve) => {
        const off = this.#client.onSession(name, this.#sessionId, (params) => {
          off();
          resolve(params);
        });
        cleanups.push(off);
      });

    const loadEvent =
      waitUntil === 'load'
        ? eventPromise('Page.loadEventFired')
        : waitUntil === 'domcontentloaded'
          ? eventPromise('Page.domContentEventFired')
          : null;

    try {
      let navigation;
      try {
        navigation = await this.#client.send(
          'Page.navigate',
          { url: targetHref, transitionType: 'typed' },
          this.#sessionId,
          { timeoutMs: Math.min(timeoutMs, 12_000) },
        );
      } catch (error) {
        throw cdpError(ERROR_CODES.NAVIGATION_TIMEOUT, `Page.navigate failed for ${targetHref}: ${error.message}`, {
          url: targetHref,
          cause: error,
        });
      }
      if (navigation && typeof navigation.errorText === 'string' && navigation.errorText.length > 0) {
        throw cdpError(ERROR_CODES.NAVIGATION_TIMEOUT, `Navigation to ${targetHref} failed: ${navigation.errorText}`, {
          url: targetHref,
          netError: navigation.errorText,
        });
      }
      const sameDocument = !navigation || !navigation.loaderId;
      if (waitUntil === 'commit') {
        // Commit only guarantees that Page.navigate was accepted.
        if (quietMs > 0) await sleep(quietMs);
        return { url: await this.url(), title: await this.title() };
      }
      const readyStatePromise = this.#waitForReadyState(
        waitUntil === 'domcontentloaded' ? 'interactive' : 'complete',
        deadline,
        timeoutMs,
        targetHref,
      );
      if (loadEvent && !sameDocument) {
        const eventDeadline = this.#deadlinePromise(
          loadEvent,
          deadline,
          ERROR_CODES.NAVIGATION_TIMEOUT,
          `Navigation to ${targetHref} timed out after ${timeoutMs}ms waiting for ${waitUntil}`,
        );
        await Promise.all([eventDeadline, readyStatePromise]);
      } else {
        await readyStatePromise;
      }
      if (quietMs > 0) await sleep(quietMs);
      return { url: await this.url(), title: await this.title() };
    } finally {
      for (const off of cleanups) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * Read page text and visible links. Never reads form-control values.
   * @param {{maxChars?: number, includeLinks?: boolean}} [options]
   */
  async read(options = {}) {
    const maxChars = clamp(Number(options.maxChars) || 12_000, 100, 200_000);
    const includeLinks = options.includeLinks !== false;
    const frame = options.frameId !== undefined || Number.isInteger(options.frameIndex)
      ? await this.#resolveFrame(options)
      : null;
    const expression = readExpression({ maxChars, includeLinks });
    const result = frame
      ? await this.#evaluateInFrame(frame.frameId, expression, 10_000)
      : await this.#evaluate(expression, { timeoutMs: 10_000 });
    if (!result || typeof result !== 'object') {
      throw cdpError(ERROR_CODES.CDP_ERROR, 'read snippet returned an unexpected result');
    }
    return {
      url: String(result.url ?? ''),
      title: String(result.title ?? ''),
      text: typeof result.text === 'string' ? result.text : '',
      links: Array.isArray(result.links) ? result.links : [],
      frame,
    };
  }

  /**
   * Find visible elements by text and/or CSS selector. Locate coordinates are viewport CSS px.
   * Returns `{url, title, matches}`; an empty `matches` array is not an error.
   */
  async find(options = {}) {
    const text = typeof options.text === 'string' ? options.text : '';
    const selector = typeof options.selector === 'string' ? options.selector : '';
    if (!text && !selector) {
      throw cdpError(ERROR_CODES.CDP_ERROR, 'find requires text or selector');
    }
    const match = options.match === 'exact' ? 'exact' : 'contains';
    const max = clamp(Number.isInteger(options.max) ? options.max : 20, 1, 200);
    const result = await this.#evaluate(
      findExpression({ text, selector, match, max }),
      { timeoutMs: 8000 },
    );
    if (!result || typeof result !== 'object') {
      throw cdpError(ERROR_CODES.CDP_ERROR, 'find snippet returned an unexpected result');
    }
    if (result.invalidSelector) {
      throw cdpError(ERROR_CODES.CDP_ERROR, `Invalid CSS selector: ${result.invalidSelector}`, { selector });
    }
    return {
      url: String(result.url ?? ''),
      title: String(result.title ?? ''),
      matches: Array.isArray(result.matches) ? result.matches : [],
    };
  }

  /**
   * List child frames (frameIndex is the stable index used by frame-aware actions).
   * @returns {Promise<Array<{frameIndex:number,frameId:string,url:string,name:string,parentId:string}>>}
   */
  async frames() {
    const list = await this.#frameTree();
    return list.map((frame, index) => ({ ...frame, frameIndex: index }));
  }

  async #frameOffset(frame) {
    const list = await this.frames();
    const byId = new Map(list.map((entry) => [entry.frameId, entry]));
    const chain = [];
    let current = frame;
    while (current !== undefined && chain.length < 8) {
      chain.unshift(current);
      current = byId.get(current.parentId);
    }
    let x = 0;
    let y = 0;
    for (let i = 0; i < chain.length; i += 1) {
      const entry = chain[i];
      const rects = i === 0
        ? await this.#evaluate(IFRAME_RECTS_EXPR, { timeoutMs: 4000 })
        : await this.#evaluateInFrame(chain[i - 1].frameId, IFRAME_RECTS_EXPR, 4000);
      if (!Array.isArray(rects)) return null;
      const name = String(entry.name ?? '');
      const rect =
        rects.find((item) => name.length > 0 && String(item.name) === name) ??
        rects.find((item) => name.length > 0 && String(item.id) === name) ??
        null;
      if (rect === null) return null;
      x += Number(rect.x);
      y += Number(rect.y);
    }
    return { x, y, chain };
  }
  async #resolveFrame(options = {}) {
    const list = await this.frames();
    const frame = Number.isInteger(options.frameIndex)
      ? list[options.frameIndex]
      : list.find((entry) => entry.frameId === options.frameId);
    if (frame === undefined) {
      throw cdpError(ERROR_CODES.TARGET_NOT_FOUND, `No iframe matches ${JSON.stringify({
        frameIndex: options.frameIndex,
        frameId: options.frameId,
      })} (${list.length} frames)`, { frames: list });
    }
    return frame;
  }

  async #attachFrame(targetId) {
    const existing = this.#frameSessions.get(targetId);
    if (existing !== undefined) return existing;
    const sessionId = await this.#client.attachToTarget(targetId, { flatten: true, timeoutMs: 8000 });
    this.#frameSessions.set(targetId, sessionId);
    await this.#client.send('Runtime.enable', {}, sessionId, { timeoutMs: 4000 }).catch(() => {});
    return sessionId;
  }

  /** Flatten Page.getFrameTree into child frames (main frame excluded). */
  async #frameTree() {
    const result = await this.#client.send('Page.getFrameTree', {}, this.#sessionId, { timeoutMs: 5000 });
    const root = result?.frameTree;
    const output = [];
    const walk = (node, depth) => {
      if (!node?.frame?.id || depth === 0) {
        for (const child of node?.childFrames ?? []) walk(child, depth + 1);
        return;
      }
      output.push({
        frameId: String(node.frame.id),
        url: String(node.frame.url ?? ''),
        name: String(node.frame.name ?? ''),
        parentId: String(node.frame.parentId ?? ''),
      });
      for (const child of node.childFrames ?? []) walk(child, depth + 1);
    };
    walk(root, 0);
    return output;
  }

  /** Create an execution context inside a frame and evaluate a fixed snippet there. */
  async #evaluateInFrame(frameId, expression, timeoutMs = 8000) {
    const created = await this.#client.send(
      'Page.createIsolatedWorld',
      { frameId, worldName: 'dsh-computer-control' },
      this.#sessionId,
      { timeoutMs: 5000 },
    );
    const contextId = created?.executionContextId;
    if (!Number.isInteger(contextId)) {
      throw cdpError(ERROR_CODES.CDP_ERROR, `createIsolatedWorld returned no context for frame ${frameId}`);
    }
    return await this.#evaluate(expression, { contextId, timeoutMs });
  }

  /**
   * List visible editable form fields across the main frame and OOPIF/iframe targets.
   * Never returns field values, only valueLength (safe for password fields).
   * Each field carries frameTargetId/frameUrl when it belongs to an iframe.
   * @param {{includeFrames?: boolean}} [options]
   * @returns {Promise<{url:string,title:string,fields:object[],frames:object[]}>}
   */
  async fields(options = {}) {
    const includeFrames = options.includeFrames !== false;
    const main = await this.#evaluate(fieldsExpression(), { timeoutMs: 8000 });
    if (!main || typeof main !== 'object') {
      throw cdpError(ERROR_CODES.CDP_ERROR, 'fields snippet returned an unexpected result');
    }
    const fields = (Array.isArray(main.fields) ? main.fields : []).map((field) => ({
      ...field,
      frameTargetId: null,
      frameUrl: String(main.url ?? ''),
    }));
    const frameReports = [];
    if (includeFrames) {
      let frameTree = [];
      try {
        frameTree = (await this.#frameTree()).slice(0, 10);
      } catch (error) {
        frameTree = [];
        frameReports.push({ frameId: null, url: '', fields: 0, error: `frameTree: ${String(error instanceof Error ? error.message : error).slice(0, 160)}` });
      }
      for (const frame of frameTree) {
        const report = { frameId: frame.frameId, url: frame.url, fields: 0, error: null };
        try {
          const frameFields = await this.#evaluateInFrame(frame.frameId, fieldsExpression(), 8000);
          const list = Array.isArray(frameFields?.fields) ? frameFields.fields : [];
          report.fields = list.length;
          for (const field of list) {
            fields.push({
              ...field,
              index: fields.length,
              frameId: frame.frameId,
              frameUrl: frame.url,
              frameTargetId: null,
            });
          }
        } catch (error) {
          report.error = String(error instanceof Error ? error.message : error).slice(0, 200);
        }
        frameReports.push(report);
        if (fields.length >= 100) break;
      }
    }
    return {
      url: String(main.url ?? ''),
      title: String(main.title ?? ''),
      fields: fields.slice(0, 100),
      frames: Array.isArray(main.frames) ? main.frames : [],
      frameTargets: frameReports,
    };
  }

  /**
   * Fill a field by its index in fields() (main frame or iframe/OOPIF).
   * @param {{fieldIndex: number, value: string, submit?: boolean}} options
   */
  async fillField(options = {}) {
    const value = options.value;
    if (typeof value !== 'string') throw cdpError(ERROR_CODES.CDP_ERROR, 'fillField requires a string value');
    const listed = await this.fields();
    const field = listed.fields[options.fieldIndex];
    if (field === undefined) {
      throw cdpError(ERROR_CODES.CDP_ERROR, `fieldIndex ${options.fieldIndex} is out of range (${listed.fields.length} fields)`);
    }
    if (field.frameId) {
      const result = await this.#evaluateInFrame(
        field.frameId,
        fillExpression({ selector: field.selectorHint, value, submit: options.submit === true }),
        8000,
      );
      if (!result || result.ok !== true) {
        throw cdpError(ERROR_CODES.CDP_ERROR, `Could not fill iframe field: ${JSON.stringify(result?.reason ?? 'unknown')}`, {
          field,
        });
      }
      return {
        field,
        method: String(result.method ?? 'setter'),
        submitted: Boolean(result.submitted),
        valueLength: Number(result.valueLength ?? value.length),
      };
    }
    if (field.frameTargetId) {
      const sessionId = await this.#attachFrame(field.frameTargetId);
      const result = await this.#evaluate(
        fillExpression({ selector: field.selectorHint, value, submit: options.submit === true }),
        { sessionId, timeoutMs: 8000 },
      );
      if (!result || result.ok !== true) {
        throw cdpError(ERROR_CODES.CDP_ERROR, `Could not fill iframe field: ${JSON.stringify(result?.reason ?? 'unknown')}`, {
          field,
        });
      }
      return {
        field,
        method: String(result.method ?? 'setter'),
        submitted: Boolean(result.submitted),
        valueLength: Number(result.valueLength ?? value.length),
      };
    }
    await this.fill({ selector: field.selectorHint, value, submit: options.submit === true });
    return { field, method: 'setter', submitted: options.submit === true, valueLength: value.length };
  }

  /**
   * Click a visible element by text or selector using real CDP mouse input.
   * @param {{text?: string, selector?: string, index?: number, button?: 'left'|'right'|'middle', clickCount?: number, match?: 'contains'|'exact'}} [options]
   * @returns {Promise<{match: object, x: number, y: number, button: string, clickCount: number}>}
   */
  async click(options = {}) {
    this.#assertOpen();
    const text = typeof options.text === 'string' ? options.text : '';
    const selector = typeof options.selector === 'string' ? options.selector : '';
    if (!text && !selector) throw cdpError(ERROR_CODES.CDP_ERROR, 'click requires text or selector');
    const match = options.match === 'exact' ? 'exact' : 'contains';
    const index = Number.isInteger(options.index) ? Math.max(0, options.index) : 0;
    const button = ['left', 'right', 'middle'].includes(options.button) ? options.button : 'left';
    const clickCount = clamp(Number.isInteger(options.clickCount) ? options.clickCount : 1, 1, 3);
    const frame = options.frameId !== undefined || Number.isInteger(options.frameIndex)
      ? await this.#resolveFrame(options)
      : null;
    const expression = clickExpression({
      text,
      selector,
      match,
      index,
      max: clamp(index + 1, 20, 200),
      domClick: false,
    });
    const result = frame !== null
      ? await this.#evaluateInFrame(frame.frameId, expression, 8000)
      : await this.#evaluate(expression, { timeoutMs: 8000 });
    if (!result || typeof result !== 'object') {
      throw cdpError(ERROR_CODES.CDP_ERROR, 'click snippet returned an unexpected result');
    }
    if (result.reason === 'invalid_selector') {
      throw cdpError(ERROR_CODES.CDP_ERROR, `Invalid CSS selector: ${result.message}`, { selector });
    }
    if (result.reason === 'not_found') {
      throw cdpError(
        ERROR_CODES.TEXT_NOT_FOUND,
        text
          ? `No visible element contains text ${JSON.stringify(text)}`
          : `No visible element matches selector ${JSON.stringify(selector)}`,
        { text, selector, url: result.url, title: result.title },
      );
    }
    if (result.reason === 'index_out_of_range') {
      throw cdpError(ERROR_CODES.TEXT_NOT_FOUND, `Match index ${index} is out of range (${result.count} matches)`, {
        text,
        selector,
        index,
        count: result.count,
      });
    }
    if (result.reason === 'detached') {
      throw cdpError(ERROR_CODES.CDP_ERROR, 'Target element was detached before it could be clicked', { text, selector, index });
    }
    if (!result.ok) {
      throw cdpError(ERROR_CODES.CDP_ERROR, `Could not click target: ${JSON.stringify(result.reason ?? 'unknown')}`, {
        text,
        selector,
        index,
      });
    }
    if (frame !== null) {
      const offset = await this.#frameOffset(frame);
      if (offset !== null) {
        const parentX = offset.x + Number(result.x);
        const parentY = offset.y + Number(result.y);
        await this.#mouseClick(parentX, parentY, button, clickCount);
        return {
          match: result.target ?? null,
          x: parentX,
          y: parentY,
          button,
          clickCount,
          frame,
          frameChain: offset.chain.map((entry) => entry.frameId),
          mouse: true,
          followedTarget: null,
          url: String(result.url ?? frame.url),
          title: String(result.title ?? ''),
        };
      }
      // No parent iframe rect (detached/nested): fall back to DOM click inside the frame.
      const domResult = await this.#evaluateInFrame(
        frame.frameId,
        clickExpression({ text, selector, match, index, max: clamp(index + 1, 20, 200), domClick: true }),
        8000,
      );
      if (!domResult || domResult.ok !== true) {
        throw cdpError(ERROR_CODES.CDP_ERROR, `Could not click inside frame: ${JSON.stringify(domResult?.reason ?? 'unknown')}`);
      }
      return {
        match: domResult.target ?? null,
        x: domResult.x,
        y: domResult.y,
        button: 'dom',
        clickCount: 1,
        frame,
        mouse: false,
        followedTarget: null,
        url: String(domResult.url ?? frame.url),
        title: String(domResult.title ?? ''),
      };
    }
    const beforeUrl = String(result.url ?? '');
    const beforeIds = await this.#pageTargetIdSet();
    await this.#mouseClick(result.x, result.y, button, clickCount);
    const followedTarget = options.followPopup === false
      ? null
      : await this.#followNewTarget(beforeUrl, beforeIds, clamp(Number(options.followPopupTimeoutMs) || 2500, 300, 8000));
    return {
      match: result.target ?? null,
      x: result.x,
      y: result.y,
      button,
      clickCount,
      followedTarget,
      url: followedTarget?.url || (await this.url().catch(() => result.url)),
      title: followedTarget ? await this.title().catch(() => result.title) : result.title,
    };
  }

  /**
   * Fill a text field/textarea/contenteditable.
   * Uses the native value setter + input/change events, falling back to Input.insertText.
   * @param {{text?: string, selector?: string, value: string, submit?: boolean, index?: number}} options
   */
  async fill(options = {}) {
    this.#assertOpen();
    const text = typeof options.text === 'string' ? options.text : '';
    const selector = typeof options.selector === 'string' ? options.selector : '';
    if (!text && !selector) throw cdpError(ERROR_CODES.CDP_ERROR, 'fill requires text or selector');
    if (typeof options.value !== 'string') {
      throw cdpError(ERROR_CODES.CDP_ERROR, 'fill requires a string value');
    }
    const value = options.value;
    const index = Number.isInteger(options.index) ? options.index : null;
    const result = await this.#evaluate(
      fillExpression({ text, selector, value, index }),
      { timeoutMs: 8000 },
    );
    if (!result || typeof result !== 'object') {
      throw cdpError(ERROR_CODES.CDP_ERROR, 'fill snippet returned an unexpected result');
    }
    if (result.reason === 'invalid_selector') {
      throw cdpError(ERROR_CODES.CDP_ERROR, `Invalid CSS selector: ${result.message}`, { selector });
    }
    if (result.reason === 'not_found') {
      throw cdpError(
        ERROR_CODES.TEXT_NOT_FOUND,
        text
          ? `No visible editable element matches text ${JSON.stringify(text)}`
          : `No visible editable element matches selector ${JSON.stringify(selector)}`,
        { text, selector, url: result.url, title: result.title },
      );
    }
    if (result.reason === 'ambiguous') {
      throw cdpError(ERROR_CODES.AMBIGUOUS_TEXT, `Multiple editable elements match ${JSON.stringify(text)}`, {
        text,
        matches: result.matches,
      });
    }
    if (result.reason === 'index_out_of_range') {
      throw cdpError(ERROR_CODES.TEXT_NOT_FOUND, `Match index is out of range (${result.count} matches)`, {
        text,
        selector,
        count: result.count,
      });
    }
    if (result.reason === 'detached') {
      throw cdpError(ERROR_CODES.CDP_ERROR, 'Target element was detached before it could be filled', { text, selector });
    }

    let method = result.method === 'setter' && result.ok ? 'setter' : '';
    if (!method) {
      // Fallback: focus is already set; select existing content and insert the text as
      // real keyboard input so contenteditable/framework-controlled fields behave.
      try {
        await this.#evaluate(SELECT_ALL_EXPR, { timeoutMs: 3000 });
      } catch {
        /* best-effort */
      }
      await this.#send('Input.insertText', { text: value }, { timeoutMs: 5000 });
      try {
        await this.#evaluate(DISPATCH_CHANGE_EXPR, { timeoutMs: 3000 });
      } catch {
        /* best-effort */
      }
      method = 'insertText';
    }
    let submitMethod = '';
    let followedTarget = null;
    if (options.submit === true) {
      // Let the page observe input/change before Enter, then submit with a checked
      // fallback: synthetic Enter is not always delivered when the window is occluded.
      await sleep(80);
      const beforeSubmitUrl = await this.url().catch(() => '');
      const beforeSubmitIds = await this.#pageTargetIdSet();
      await this.press('Enter');
      const submitDeadline = Date.now() + 1500;
      let afterSubmitUrl = beforeSubmitUrl;
      while (Date.now() < submitDeadline) {
        afterSubmitUrl = await this.url().catch(() => '');
        if (afterSubmitUrl !== beforeSubmitUrl) break;
        await sleep(100);
      }
      submitMethod = 'enter';
      if (afterSubmitUrl === beforeSubmitUrl) {
        const fallback = await this.#evaluate(SUBMIT_FORM_EXPR, { timeoutMs: 3000 }).catch(() => null);
        submitMethod = `fallback:${String(fallback ?? 'unknown')}`;
        if (typeof fallback !== 'string' || fallback === 'no_form' || fallback === 'no_active_element') {
          // One more physical Enter after bringing the page forward.
          await sleep(120);
          await this.press('Enter');
          submitMethod = 'enter-retry';
        }
      }
      if (options.followPopup !== false) {
        followedTarget = await this.#followNewTarget(beforeSubmitUrl, beforeSubmitIds, 2500);
      }
    }
    return {
      match: result.target ?? null,
      method,
      valueLength: value.length,
      submitted: options.submit === true,
      submitMethod,
      followedTarget,
      url: followedTarget?.url || (await this.url().catch(() => result.url)),
      title: followedTarget ? await this.title().catch(() => result.title) : result.title,
    };
  }

  /**
   * Press a key or chord through Input.dispatchKeyEvent.
   * Supports Enter, Tab, Escape, arrows, Home/End/PageUp/PageDown, Space,
   * single letters/digits and ctrl/alt/shift/meta chords (e.g. ctrl+a, ctrl+l).
   * @param {string} key
   */
  async press(key) {
    this.#assertOpen();
    const { spec, modifiers } = parseChord(key);
    const includeText = typeof spec.text === 'string' && modifiers === 0;
    const base = {
      modifiers,
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.vk,
      nativeVirtualKeyCode: spec.vk,
    };
    const down = { type: includeText ? 'keyDown' : 'rawKeyDown', ...base };
    if (includeText) {
      down.text = spec.text;
      down.unmodifiedText = spec.text;
    }
    await this.#send('Input.dispatchKeyEvent', down, { timeoutMs: 5000 });
    await this.#send(
      'Input.dispatchKeyEvent',
      { type: 'keyUp', ...base },
      { timeoutMs: 5000 },
    );
    return { key: spec.key, code: spec.code, modifiers };
  }

  /**
   * Poll for a text/url/selector condition.
   * @param {{for: 'text'|'url'|'selector', value: string, timeoutMs?: number, intervalMs?: number}} options
   */
  async waitFor(options = {}) {
    this.#assertOpen();
    const kind = options.for;
    if (!['text', 'url', 'selector'].includes(kind)) {
      throw cdpError(ERROR_CODES.CDP_ERROR, `waitFor requires for=text|url|selector, got ${JSON.stringify(kind)}`);
    }
    const value = typeof options.value === 'string' ? options.value : '';
    if (!value) throw cdpError(ERROR_CODES.CDP_ERROR, 'waitFor requires a non-empty value');
    const timeoutMs = clamp(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, 100, 120_000);
    const intervalMs = clamp(Number(options.intervalMs) || 120, 50, 1000);
    const started = Date.now();
    const deadline = started + timeoutMs;
    let last = null;

    for (;;) {
      try {
        last = await this.#probeWait(kind, value);
      } catch {
        last = null;
      }
      if (last && last.found) {
        return { ...last, for: kind, value, matched: true, elapsedMs: Date.now() - started };
      }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    }

    const code =
      kind === 'text'
        ? ERROR_CODES.TEXT_NOT_FOUND
        : kind === 'url'
          ? ERROR_CODES.NAVIGATION_TIMEOUT
          : ERROR_CODES.TARGET_NOT_FOUND;
    throw cdpError(code, `Timed out after ${timeoutMs}ms waiting for ${kind} ${JSON.stringify(value)}`, {
      for: kind,
      value,
      last,
    });
  }

  /** SHA-256 (hex) of a fresh Page.captureScreenshot PNG. */
  async screenshotHash() {
    this.#assertOpen();
    const result = await this.#send('Page.captureScreenshot', { format: 'png', fromSurface: true }, { timeoutMs: 20_000 });
    if (!result || typeof result.data !== 'string' || result.data.length === 0) {
      throw cdpError(ERROR_CODES.CDP_ERROR, 'Page.captureScreenshot returned no PNG data');
    }
    return crypto.createHash('sha256').update(Buffer.from(result.data, 'base64')).digest('hex');
  }

  /**
   * Close the CDP session. Sessions created by `launch()` also kill their dedicated
   * Edge process tree and remove the temporary profile; attached sessions only detach.
   */
  async close(options = {}) {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = (async () => {
      try {
        await this.#client.detachSession(this.#sessionId);
      } catch {
        /* ignore */
      }
      try {
        await this.#client.close();
      } catch {
        /* ignore */
      }
      const killBrowser = options.killBrowser !== undefined ? options.killBrowser === true : this.#owned;
      if (killBrowser && this.#launcher) {
        try {
          await this.#launcher.close();
        } catch {
          /* ignore */
        }
      }
      this.#closed = true;
    })();
    return this.#closePromise;
  }

  /* ---------------------------------------------------------------- internal */

  #assertOpen() {
    if (this.closed) {
      throw cdpError(ERROR_CODES.BROWSER_NOT_LAUNCHED, 'Browser session is not available (Edge may have exited)', {
        port: this.#port,
        targetId: this.#targetId,
      });
    }
  }

  #send(method, params = {}, options = {}) {
    this.#assertOpen();
    return this.#client.send(method, params, this.#sessionId, options);
  }

  async #evaluate(expression, options = {}) {
    this.#assertOpen();
    const sessionId = options.sessionId ?? this.#sessionId;
    let response;
    try {
      response = await this.#client.send(
        'Runtime.evaluate',
        {
          expression,
          returnByValue: true,
          awaitPromise: true,
          userGesture: options.userGesture === true,
          ...(Number.isInteger(options.contextId) ? { contextId: options.contextId } : {}),
        },
        sessionId,
        { timeoutMs: options.timeoutMs ?? 8000 },
      );
    } catch (error) {
      if (this.#client.closed) {
        throw cdpError(ERROR_CODES.BROWSER_NOT_LAUNCHED, 'Browser connection was lost while evaluating a page command', {
          port: this.#port,
          cause: error,
        });
      }
      throw error;
    }
    if (response && response.exceptionDetails) {
      const details = response.exceptionDetails;
      const description = String(details.exception?.description ?? details.text ?? 'unknown page script error');
      throw cdpError(ERROR_CODES.CDP_ERROR, `Page script failed: ${description.slice(0, 800)}`, {
        exceptionDetails: details,
      });
    }
    return response?.result ? response.result.value : undefined;
  }

  #deadlinePromise(promise, deadline, code, message) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(cdpError(code, message));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(cdpError(code, message)), remaining);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async #waitForReadyState(expected, deadline, timeoutMs, targetHref) {
    const accepted = expected === 'complete' ? ['complete'] : ['interactive', 'complete'];
    for (;;) {
      try {
        const state = await this.#evaluate(READY_STATE_EXPR, { timeoutMs: 2000 });
        if (accepted.includes(String(state))) return String(state);
      } catch {
        /* execution context may be destroyed mid-navigation; retry */
      }
      if (Date.now() >= deadline) {
        throw cdpError(
          ERROR_CODES.NAVIGATION_TIMEOUT,
          `Navigation to ${targetHref} timed out after ${timeoutMs}ms waiting for document.readyState=${expected}`,
          { url: targetHref },
        );
      }
      await sleep(80);
    }
  }

  async #probeWait(kind, value) {
    if (kind === 'text') {
      return await this.#evaluate(hasTextExpression({ value }), { timeoutMs: 3000 });
    }
    if (kind === 'url') {
      return await this.#evaluate(urlWaitExpression({ value }), { timeoutMs: 3000 });
    }
    const result = await this.#evaluate(selectorWaitExpression({ selector: value, max: 1 }), {
      timeoutMs: 3000,
    });
    if (result?.invalidSelector) {
      throw cdpError(ERROR_CODES.CDP_ERROR, `Invalid CSS selector: ${result.invalidSelector}`, { selector: value });
    }
    return result;
  }

  async #pageTargetIdSet() {
    const ids = new Set([this.#targetId]);
    for (const info of this.#liveTargets.values()) {
      if (info.type === 'page') ids.add(info.targetId);
    }
    try {
      for (const target of await listTargets(this.#port, { timeoutMs: 2000 })) {
        if (target.type === 'page') ids.add(target.id);
      }
    } catch {
      /* event snapshot is enough */
    }
    return ids;
  }

  /**
   * After an interaction, follow a popup/new window when the original tab did not
   * navigate. Returns `{targetId, url}` for the adopted target, or null when the
   * click navigated in place / no popup appeared.
   */
  async #followNewTarget(beforeUrl, beforeIds, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(120);
      const currentUrl = await this.url().catch(() => '');
      if (currentUrl && beforeUrl && currentUrl !== beforeUrl && currentUrl !== 'about:blank' && !currentUrl.startsWith('edge://')) {
        return null; // same-tab navigation; do not steal focus from it
      }
      const candidates = [];
      for (const info of this.#liveTargets.values()) {
        if (info.type !== 'page' || !info.targetId) continue;
        if (beforeIds.has(info.targetId) || info.targetId === this.#targetId) continue;
        if (String(info.url || '').toLowerCase().startsWith('edge://')) continue;
        candidates.push(info);
      }
      if (candidates.length === 0) {
        const targets = await listTargets(this.#port, { timeoutMs: 1500 }).catch(() => []);
        for (const target of targets) {
          if (target.type !== 'page') continue;
          if (beforeIds.has(target.id) || target.id === this.#targetId) continue;
          if (target.url.toLowerCase().startsWith('edge://')) continue;
          candidates.push({ targetId: target.id, type: target.type, url: target.url });
        }
      }
      if (candidates.length > 0) {
        const candidate =
          candidates.find((entry) => /^https?:\/\//i.test(String(entry.url || ''))) ?? candidates[0];
        const switched = await this.#switchSession(candidate.targetId);
        if (switched) return switched;
      }
    }
    return null;
  }

  async #switchSession(targetId) {
    let sessionId;
    try {
      sessionId = await this.#client.attachToTarget(targetId, { flatten: true, timeoutMs: 8000 });
    } catch {
      return null;
    }
    try {
      await this.#client.send('Page.enable', {}, sessionId, { timeoutMs: 8000 });
      await this.#client.send('Runtime.enable', {}, sessionId, { timeoutMs: 8000 }).catch(() => {});
      await this.#client.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId, { timeoutMs: 3000 }).catch(() => {});
      await this.#client.send('Page.bringToFront', {}, sessionId, { timeoutMs: 2500 }).catch(() => {});
    } catch {
      await this.#client.detachSession(sessionId).catch(() => {});
      return null;
    }
    const previousSession = this.#sessionId;
    this.#targetId = targetId;
    this.#sessionId = sessionId;
    await this.#client.detachSession(previousSession).catch(() => {});
    return { targetId, url: await this.url().catch(() => '') };
  }

  async #mouseClick(x, y, button, clickCount) {
    const buttonMask = button === 'right' ? 2 : button === 'middle' ? 4 : 1;
    await this.#send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }, { timeoutMs: 12_000 });
    for (let count = 1; count <= clickCount; count += 1) {
      await this.#send(
        'Input.dispatchMouseEvent',
        { type: 'mousePressed', x, y, button, buttons: buttonMask, clickCount: count },
        { timeoutMs: 12_000 },
      );
      await this.#send(
        'Input.dispatchMouseEvent',
        { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: count },
        { timeoutMs: 12_000 },
      );
      if (count < clickCount) await sleep(35);
    }
  }

  async #settleInitialPage(url, timeoutMs) {
    const started = Date.now();
    const deadline = started + Math.max(2000, Math.min(timeoutMs, 15_000));
    const host = hostOf(url);
    // Redirects (cn.bing.com -> www.bing.com) are normal: after 1.5s any http(s)
    // document counts as the initial page, instead of waiting for the exact host.
    const acceptAfterMs = 1500;
    let current = '';
    while (Date.now() < deadline) {
      current = await this.url().catch(() => '');
      const lower = current.toLowerCase();
      if (/^https?:\/\//i.test(current)) {
        if (!host || lower.includes(host) || Date.now() - started >= acceptAfterMs) break;
      }
      await sleep(100);
    }
    if (!/^https?:\/\//i.test(current)) {
      if (/^https?:\/\//i.test(url)) {
        try {
          await this.navigate(url, {
            waitUntil: 'load',
            timeoutMs: Math.max(2000, Math.min(10_000, deadline - Date.now())),
          });
        } catch {
          /* launch is best-effort; the caller can navigate/wait explicitly */
        }
      }
    } else {
      try {
        await this.#waitForReadyState(
          'complete',
          Math.min(deadline, Date.now() + 6000),
          Math.max(1, Math.min(6000, deadline - Date.now())),
          url,
        );
      } catch {
        /* best-effort page settle */
      }
    }
    await sleep(100);
  }
}

/* ======================================================================== *
 * Internal attach helpers
 * ======================================================================== */

async function waitForPageTarget(port, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const host = hostOf(url);
  let pages = [];
  const started = Date.now();
  for (;;) {
    try {
      const targets = await listTargets(port, { timeoutMs: Math.min(3000, Math.max(500, deadline - Date.now())) });
      pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (pages.length > 0) {
        if (host) {
          const matching = pages.find((target) => target.url.toLowerCase().includes(host));
          if (matching) return matching;
          if (Date.now() - started > 8000) return pickPageTarget(pages, host);
        } else {
          return pickPageTarget(pages);
        }
      }
    } catch (error) {
      if (error && error.code !== ERROR_CODES.BROWSER_NOT_LAUNCHED) {
        /* transient during startup */
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(120);
  }
  if (pages.length > 0) return pickPageTarget(pages, host);
  throw cdpError(ERROR_CODES.TARGET_NOT_FOUND, 'The launched Edge instance did not expose a page target', { port });
}

async function attachToPort(port, targetId, launcher) {
  let version;
  try {
    version = await getVersion(port, { timeoutMs: 5000 });
  } catch (error) {
    if (error && error.code) throw error;
    throw cdpError(ERROR_CODES.BROWSER_NOT_LAUNCHED, `Cannot reach Edge DevTools on 127.0.0.1:${port}`, { port, cause: error });
  }

  let client;
  try {
    client = await CdpClient.connect(version.webSocketDebuggerUrl, { timeoutMs: 10_000 });
  } catch (error) {
    throw cdpError(ERROR_CODES.ATTACH_FAILED, `CDP connect failed: ${error.message}`, { port, targetId, cause: error });
  }

  let sessionId;
  try {
    sessionId = await client.attachToTarget(targetId, { flatten: true });
  } catch (error) {
    await client.close().catch(() => {});
    if (error && error.code === ERROR_CODES.TARGET_NOT_FOUND) throw error;
    if (/No target with given id|target.*not found|not found/i.test(error?.message ?? '')) {
      throw cdpError(ERROR_CODES.TARGET_NOT_FOUND, `Cannot attach to target ${targetId}: ${error.message}`, {
        port,
        targetId,
        cause: error,
      });
    }
    throw cdpError(ERROR_CODES.ATTACH_FAILED, `Target.attachToTarget failed: ${error.message}`, {
      port,
      targetId,
      cause: error,
    });
  }

  try {
    await client.send('Page.enable', {}, sessionId, { timeoutMs: 10_000 });
    await client.send('Runtime.enable', {}, sessionId, { timeoutMs: 10_000 }).catch(() => {});
    // Emulate page focus so CDP keyboard/mouse input is delivered reliably even when
    // the Edge window is behind the DSH window (no OS-level focus required).
    await client.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId, { timeoutMs: 3000 }).catch(() => {});
    // Bring the controlled tab to the foreground: this keeps rendering (and rAF,
    // timers, media) unthrottled and makes real mouse/keyboard input sane. Best-effort.
    await client.send('Page.bringToFront', {}, sessionId, { timeoutMs: 3000 }).catch(() => {});
  } catch (error) {
    await client.detachSession(sessionId).catch(() => {});
    await client.close().catch(() => {});
    throw cdpError(ERROR_CODES.ATTACH_FAILED, `Failed to enable Page/Runtime domains: ${error.message}`, {
      port,
      targetId,
      cause: error,
    });
  }

  const session = new BrowserSession({
    port,
    targetId,
    client,
    sessionId,
    launcher: launcher ?? null,
  });
  // Needed for Target.targetCreated/targetInfoChanged-based popup following.
  await client.send('Target.setDiscoverTargets', { discover: true }, undefined, { timeoutMs: 3000 }).catch(() => {});
  return session;
}

export default BrowserSession;

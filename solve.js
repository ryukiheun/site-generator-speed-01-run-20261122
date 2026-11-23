// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01).
// Same answers byte for byte, reimplemented from the dialect spec:
// front matter, template dialect, Markdown subset, slug rule, report.
// Optimisations: templates compiled once per run() to JS functions;
// Markdown rendered in a single pass; inline rendering uses a native
// regex fast path plus indexOf-based strong/em/link closers (exact
// escape semantics: a closer is skipped only after an odd run of
// backslashes); esc finds its first special natively; wordsOf counts
// with a 64K whitespace table; slugify/longDate memoised per run.
// No state is kept between run() calls: every cache lives inside run().

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WS_RE = /\s/;
const CR_RE = /\r\n?/g;
const TRAIL_RE = /\/+$/;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const NFKD_MARKS_RE = /\p{M}/gu;
const RESERVED = ['posts', 'tags', 'page'];
const KEYS_SET = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = (o, k) => Object.hasOwn(o, k);

const ESCSPEC = new Uint8Array(128);
for (const c of [38, 60, 62, 34, 39]) ESCSPEC[c] = 1;

/** HTML escape: manual scan, plain runs sliced in bulk, no regex, no callbacks. */
const ESC_RE = /[&<>"']/;
/** HTML escape: first special found natively; plain strings return untouched. */
function esc(s) {
  const n = s.length;
  let i = s.search(ESC_RE);
  if (i === -1) return s;
  const out = [s.slice(0, i)];
  while (i < n) {
    const c = s.charCodeAt(i);
    out.push(c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;');
    i++;
    let j = i;
    while (j < n) {
      const c2 = s.charCodeAt(j);
      if (c2 < 128 && ESCSPEC[c2]) break;
      j++;
    }
    if (j > i) out.push(s.slice(i, j));
    i = j;
  }
  return out.join('');
}

/** A template value as text (string itself, JS digits, true/false, array joined by ", ", else ""). */
function txt(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(txt).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** First segment of a path in the scope stack (innermost frame first). */
function g1(S, a) {
  for (let k = S.length - 1; k >= 0; k--) {
    const f = S[k];
    if (hasOwn(f, a)) return f[a];
  }
  return undefined;
}

/** One more path segment: an own property of an object, else undefined. */
function w(v, k) {
  return v !== null && typeof v === 'object' && hasOwn(v, k) ? v[k] : undefined;
}

function g2(S, a, b) {
  return w(g1(S, a), b);
}

function g3(S, a, b, c) {
  return w(g2(S, a, b), c);
}

function w1(v, b) {
  return w(v, b);
}

function w2(v, b, c) {
  return w(w1(v, b), c);
}

/** A template value as text, HTML-escaped (numbers/booleans need no escaping). */
function ev(v) {
  if (typeof v === 'string') return esc(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return esc(v.map(txt).join(', '));
  return '';
}

/** The slug of `text`, memoised in `cache` (per run). */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(NFKD_MARKS_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) { out += '-'; gap = false; }
    out += String.fromCharCode(keep);
  }
  if (out.length > 64) out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  out = out.slice(0, e);
  const r = out === '' ? 'untitled' : out;
  cache.set(text, r);
  return r;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = 2;
  let out;
  do { out = `${slug}-${n++}`; } while (taken.has(out));
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, memoised in `cache` (per run). */
function longDate(date, cache) {
  let r = cache.get(date);
  if (r === undefined) {
    r = `${+date.slice(8, 10)} ${MONTHS[+date.slice(5, 7) - 1]} ${date.slice(0, 4)}`;
    cache.set(date, r);
  }
  return r;
}

/** The words of a body: runs of characters other than whitespace (no allocation). */
const WS64K = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279]) WS64K[c] = 1;
for (let c = 8192; c <= 8202; c++) WS64K[c] = 1;
/** The words of a body: runs of characters other than whitespace (no allocation). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS64K[text.charCodeAt(i)]) inWord = false;
    else if (!inWord) {
      n++;
      inWord = true;
    }
  }
  return n;
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** `rel` from directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isDigits(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

function isName(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

function isSlug(raw) {
  if (raw.length === 0 || raw.length > 64) return false;
  let i = 0;
  for (;;) {
    if (i >= raw.length) return false;
    let c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) return false;
    while (i < raw.length) {
      c = raw.charCodeAt(i);
      if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) i++;
      else break;
    }
    if (i >= raw.length) return true;
    if (raw.charCodeAt(i) !== 45) return false;
    i++;
    if (i >= raw.length) return false;
  }
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45
        && isDigits(raw, 0, 4) && isDigits(raw, 5, 7) && isDigits(raw, 8, 10);
      let y = 0, mo = 0, d = 0;
      if (ok) {
        y = +raw.slice(0, 4); mo = +raw.slice(5, 7); d = +raw.slice(8, 10);
        ok = y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlug(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** One front-matter line (line number `n`, 1-based from the opening `---`): error string or null. */
function fmLine(line, n, data) {
  let k = 0;
  while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
  if (k === line.length) return null;
  if (line.charCodeAt(0) === 35) return null;
  let e = 0;
  while (e < line.length) {
    const c = line.charCodeAt(e);
    if ((c >= 97 && c <= 122) || c === 95) e++;
    else break;
  }
  if (e === 0 || e >= line.length || line.charCodeAt(e) !== 58) return `line ${n} is not "key: value"`;
  const key = line.slice(0, e);
  let raw;
  if (e + 1 === line.length) raw = '';
  else if (line.charCodeAt(e + 1) !== 32) return `line ${n} is not "key: value"`;
  else raw = line.slice(e + 2);
  let rl = raw.length;
  while (rl > 0 && (raw.charCodeAt(rl - 1) === 32 || raw.charCodeAt(rl - 1) === 9)) rl--;
  raw = raw.slice(0, rl);
  if (!KEYS_SET.has(key)) return `unknown key "${key}"`;
  if (hasOwn(data, key)) return `key "${key}" is given twice`;
  if (raw === '') return `key "${key}" has no value`;
  const v = valueOf(key, raw);
  if ('error' in v) return v.error;
  data[key] = v.value;
  return null;
}

/** { data, body } or { error }: the first reason the source is refused. */
function parseFrontMatter(text) {
  if (text !== '---' && (text.length < 4 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45 || text.charCodeAt(3) !== 10)) {
    return { error: 'no front matter' };
  }
  let i = 4;
  let closeStart = -1;
  let closeEnd = -1;
  while (i <= text.length) {
    const nl = text.indexOf('\n', i);
    const lineEnd = nl === -1 ? text.length : nl;
    if (lineEnd - i === 3 && text.charCodeAt(i) === 45 && text.charCodeAt(i + 1) === 45 && text.charCodeAt(i + 2) === 45) {
      closeStart = i;
      closeEnd = lineEnd;
      break;
    }
    if (nl === -1) break;
    i = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 1;
  let j = 4;
  while (j < closeStart) {
    const nl = text.indexOf('\n', j);
    const lineEnd = nl === -1 ? closeStart : nl;
    lineNo++;
    const err = fmLine(text.slice(j, lineEnd), lineNo, data);
    if (err !== null) return { error: err };
    j = lineEnd + 1;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- Markdown

function isBlank(l) {
  for (let k = 0; k < l.length; k++) {
    const c = l.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(l) {
  let a = 0;
  let b = l.length;
  while (a < b && (l.charCodeAt(a) === 32 || l.charCodeAt(a) === 9)) a++;
  while (b > a && (l.charCodeAt(b - 1) === 32 || l.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === l.length ? l : l.slice(a, b);
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** Fence-open language, or null when the line is not a fence open. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  const lang = line.slice(3, j);
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length ? lang : null;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 35) k++;
  if (k === 0 || k > 6 || k >= line.length) return null;
  const c = line.charCodeAt(k);
  if (c !== 32 && c !== 9) return null;
  let s = k;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === s) return null;
  return { depth: k, text: line.slice(s, e) };
}

function isHR(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  const p = c0 === 45 ? 45 : 42;
  if (line.charCodeAt(1) !== p || line.charCodeAt(2) !== p) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph. */
function endsParagraph(l) {
  if (l === '') return true;
  const c = l.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(l);
  if (c === 96) return fenceOpen(l) !== null;
  if (c === 35) return headingOf(l) !== null;
  if (c === 45 || c === 42) return isHR(l);
  return false;
}

/** A bullet item's text (after "- " / "* "), or null. */
function bulletOf(l) {
  const c = l.charCodeAt(0);
  if ((c === 45 || c === 42) && l.charCodeAt(1) === 32) return l.slice(2);
  return null;
}

/** An ordered item: { start, text }, or null. */
function orderedOf(l) {
  let j = 0;
  while (j < l.length) {
    const c = l.charCodeAt(j);
    if (c >= 48 && c <= 57) j++;
    else break;
  }
  if (j < 1 || j > 9) return null;
  if (l.charCodeAt(j) !== 46 || l.charCodeAt(j + 1) !== 32) return null;
  return { start: +l.slice(0, j), text: l.slice(j + 2) };
}

/** A list continuation line (two or more spaces, then a non-space). */
function isContinued(l) {
  let k = 0;
  while (k < l.length && l.charCodeAt(k) === 32) k++;
  if (k < 2 || k >= l.length) return false;
  return !WS_RE.test(l[k]);
}

function isEscCode(c) {
  return c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 || c === 40 || c === 41
    || c === 35 || c === 43 || c === 45 || c === 46 || c === 33 || c === 62;
}

/** First index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let k = s.indexOf(what, from);
  while (k !== -1) {
    let b = k - 1;
    let cnt = 0;
    while (b >= from && s.charCodeAt(b) === 92) { cnt++; b--; }
    if (cnt % 2 === 0) return k;
    k = s.indexOf(what, k + 1);
  }
  return -1;
}

/** First single `*` from `from` (one whose run is not `**`), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf('*', j);
    if (k === -1) return -1;
    let b = k - 1;
    let cnt = 0;
    while (b >= from && s.charCodeAt(b) === 92) { cnt++; b--; }
    if (cnt % 2 === 1) { j = k + 1; continue; }
    if (s.charCodeAt(k + 1) === 42) { j = k + 2; continue; }
    return k;
  }
}

const INLINE_TEST_RE = /[\\`*\[&<>"']/;
const INLINE_NEXT_RE = /[\\`*\[&<>"']/;
/** `s` rendered inline; `link(target)` is a link's href. */
function inline(s, link) {
  if (!INLINE_TEST_RE.test(s)) return s;
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const rel = s.slice(i).search(INLINE_NEXT_RE);
    const j = rel === -1 ? n : i + rel;
    if (j > i) out.push(s.slice(i, j));
    if (j >= n) break;
    i = j;
    const c = s.charCodeAt(i);
    if (c === 38) { out.push('&amp;'); i++; }
    else if (c === 60) { out.push('&lt;'); i++; }
    else if (c === 62) { out.push('&gt;'); i++; }
    else if (c === 34) { out.push('&quot;'); i++; }
    else if (c === 39) { out.push('&#39;'); i++; }
    else if (c === 92) {
      if (i + 1 < n && isEscCode(s.charCodeAt(i + 1))) {
        const nc = s.charCodeAt(i + 1);
        out.push(nc === 62 ? '&gt;' : s[i + 1]);
        i += 2;
      } else { out.push('\\'); i++; }
    } else if (c === 96) {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) { out.push('<code>', esc(s.slice(i + 1, k)), '</code>'); i = k + 1; }
      else { out.push('`'); i++; }
    } else if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) { out.push('<strong>', inline(s.slice(i + 2, k), link), '</strong>'); i = k + 2; }
        else { out.push('**'); i += 2; }
      } else {
        const k = findSingleStar(s, i + 1);
        if (k > i + 1) { out.push('<em>', inline(s.slice(i + 1, k), link), '</em>'); i = k + 1; }
        else { out.push('*'); i++; }
      }
    } else { // '[' (91)
      const k = findUnescaped(s, ']', i + 1);
      let m = -1;
      if (k !== -1 && s.charCodeAt(k + 1) === 40) m = s.indexOf(')', k + 2);
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        out.push('<a href="', esc(link(target)), '">', inline(s.slice(i + 1, k), link), '</a>');
        i = m + 1;
      } else { out.push('['); i++; }
    }
  }
  return out.join('');
}

/** `src` rendered: { html, toc, excerpt }. */
function renderMarkdown(src, link, slugCache) {
  const lines = src.split('\n');
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = '';
  let hasExcerpt = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        i++;
        const parts = [];
        while (i < n && !isFenceClose(lines[i])) { parts.push(esc(lines[i]), '\n'); i++; }
        i++;
        out.push('<pre><code', lang === '' ? '' : ` class="language-${esc(lang)}"`, '>', parts.join(''), '</code></pre>\n');
        continue;
      }
    }
    if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text, slugCache), ids);
        const html = inline(h.text, link);
        out.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>\n`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    }
    if ((c0 === 45 || c0 === 42) && isHR(line)) { out.push('<hr>\n'); i++; continue; }
    if (c0 === 62) {
      const q = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i].charCodeAt(1) === 32 ? lines[i].slice(2) : lines[i].slice(1);
        const t = trimLine(l);
        if (t !== '') q.push(t);
        i++;
      }
      out.push(q.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(q.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    }
    const b = bulletOf(line);
    const o = b === null ? orderedOf(line) : null;
    if (b !== null || o !== null) {
      const isOrdered = o !== null;
      const start = isOrdered ? o.start : 1;
      const items = [];
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          const m = orderedOf(l);
          if (m !== null) { items.push([trimLine(m.text)]); i++; continue; }
        } else {
          const m = bulletOf(l);
          if (m !== null) { items.push([trimLine(m)]); i++; continue; }
        }
        if (isContinued(l)) { items[items.length - 1].push(trimLine(l)); i++; continue; }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let s = `${open}\n`;
      for (const parts of items) s += `<li>${inline(parts.join('\n'), link)}</li>\n`;
      out.push(`${s}</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) { body.push(trimLine(lines[i])); i++; }
    const html = inline(body.join('\n'), link);
    if (!hasExcerpt) { excerpt = html; hasExcerpt = true; }
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt };
}

// ---------------------------------------------------------------- Templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * A parsed template compiled to a function(out, S, D): `out` collects strings,
 * `S` is the scope stack, `D` the include depth. Loop bindings are JS locals;
 * at an include, frames for the lexically enclosing loops are pushed so the
 * callee sees the caller's loop variables (and `loop`) through scope lookup.
 */
function compileTemplate(nodes, tplMap) {
  const code = [];
  let uid = 0;
  const loops = [];
  function expr(path) {
    const p0 = path[0];
    let e;
    let local = null;
    if (p0 === 'loop' && loops.length > 0) local = loops[loops.length - 1].l;
    else {
      for (let k = loops.length - 1; k >= 0; k--) {
        if (loops[k].name === p0) { local = loops[k].v; break; }
      }
    }
    if (local !== null) {
      e = local;
      if (path.length === 2) e = `w1(${e},${JSON.stringify(path[1])})`;
      else if (path.length === 3) e = `w2(${e},${JSON.stringify(path[1])},${JSON.stringify(path[2])})`;
      else for (let k = 1; k < path.length; k++) e = `w(${e},${JSON.stringify(path[k])})`;
      return e;
    }
    if (path.length === 1) return `g1(S,${JSON.stringify(p0)})`;
    if (path.length === 2) return `g2(S,${JSON.stringify(p0)},${JSON.stringify(path[1])})`;
    if (path.length === 3) return `g3(S,${JSON.stringify(p0)},${JSON.stringify(path[1])},${JSON.stringify(path[2])})`;
    e = `g3(S,${JSON.stringify(p0)},${JSON.stringify(path[1])},${JSON.stringify(path[2])})`;
    for (let k = 3; k < path.length; k++) e = `w(${e},${JSON.stringify(path[k])})`;
    return e;
  }
  function gen(ns) {
    for (const n of ns) {
      if (n.kind === 'text') code.push(`out.push(${JSON.stringify(n.text)});`);
      else if (n.kind === 'var') code.push(`out.push(ev(${expr(n.path)}));`);
      else if (n.kind === 'raw') code.push(`out.push(txt(${expr(n.path)}));`);
      else if (n.kind === 'if') {
        const cond = `truthy(${expr(n.path)})!==${n.not}`;
        if (n.else !== null) {
          code.push(`if(${cond}){`);
          gen(n.then);
          code.push('}else{');
          gen(n.else);
          code.push('}');
        } else {
          code.push(`if(${cond}){`);
          gen(n.then);
          code.push('}');
        }
      } else if (n.kind === 'for') {
        const id = uid++;
        const xs = `_x${id}`;
        const nn = `_n${id}`;
        const kk = `_k${id}`;
        const vv = `_v${id}`;
        const ll = `_l${id}`;
        code.push(`{const ${xs}=${expr(n.path)};if(Array.isArray(${xs})){const ${nn}=${xs}.length;for(let ${kk}=0;${kk}<${nn};${kk}++){const ${vv}=${xs}[${kk}];const ${ll}={index:${kk}+1,first:${kk}===0,last:${kk}===${nn}-1,length:${nn}};`);
        loops.push({ name: n.name, v: vv, l: ll });
        gen(n.body);
        loops.pop();
        code.push('}}}');
      } else { // include
        const fid = `_f${uid++}`;
        code.push(`if(D<${INCLUDE_DEPTH}){const ${fid}=TPL[${JSON.stringify(n.name)}];if(${fid}!==undefined){`);
        for (const lp of loops) code.push(`S.push({[${JSON.stringify(lp.name)}]:${lp.v},loop:${lp.l}});`);
        code.push(`${fid}(out,S,D+1);`);
        for (let k = loops.length - 1; k >= 0; k--) code.push('S.pop();');
        code.push('}}');
      }
    }
  }
  gen(nodes);
  const factory = new Function('ev', 'txt', 'truthy', 'g1', 'g2', 'g3', 'w1', 'w2', 'w', 'TPL', `"use strict";return function(out,S,D){\n${code.join('\n')}\n}`);
  return factory(ev, txt, truthy, g1, g2, g3, w1, w2, w, tplMap);
}

// ---------------------------------------------------------------- the build

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const dateCache = new Map();
  const report = [];
  const tpl = Object.create(null);
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      tpl[name] = compileTemplate(parseTemplate(name, input.templates[name]), tpl);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const site = input.site;
  const base = site.base_url.replace(TRAIL_RE, '');

  // 1. Sources, in code-unit order of their paths; line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const c = f.content;
      sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(CR_RE, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in order: refused, reserved dir, post without date, layout, draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (tpl[layout] === undefined) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: slug made unique in its directory, in source order.
  const takenByDir = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = new Set(dir === '' ? RESERVED : []);
      takenByDir.set(dir, taken);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), taken);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      const key = `${dir}\0${target}`;
      const hit = linkCache.get(key);
      if (hit !== undefined) {
        if (hit === false) broken.add(`broken-link ${s.path} -> ${target}`);
        return hit === false ? target : hit;
      }
      let href;
      if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) href = target;
      else {
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) href = `${bySource.get(path).url}${frag}`;
        else if (path !== null && staticPaths.has(path)) href = `${base}/${path}${frag}`;
        else {
          broken.add(`broken-link ${s.path} -> ${target}`);
          linkCache.set(key, false);
          return target;
        }
      }
      linkCache.set(key, href);
      return href;
    };
    const md = renderMarkdown(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, then by slug; newer/older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, slugCache);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards and pages (each computed once).
  const linkOf = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache),
  });
  for (const s of kept) {
    s.card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }
  for (const s of kept) {
    const c = s.card;
    s.page = {
      title: c.title,
      url: c.url,
      date: c.date,
      date_long: c.date_long,
      summary: c.summary,
      excerpt: c.excerpt,
      reading_minutes: c.reading_minutes,
      tags: c.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  }

  // 7. Layouts: every page, the index pages, the tag pages, then statics.
  const siteCtx = { title: site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, site.recent).map((p) => p.card);
  const output = {};
  // One root scope frame per run: the four per-render keys are set (or
  // cleared to undefined, which template lookup treats exactly like absent)
  // before each render, instead of building a fresh frame per render.
  const rootFrame = { site: siteCtx, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const render = (name, vars) => {
    const fn = tpl[name];
    if (fn === undefined) return null;
    rootFrame.page = vars.page;
    rootFrame.posts = vars.posts;
    rootFrame.pager = vars.pager;
    rootFrame.tag = vars.tag;
    const out = [];
    fn(out, [rootFrame], 0);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: s.page });
  const per = site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

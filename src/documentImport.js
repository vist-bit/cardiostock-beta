// documentImport.js
// Розбір документа (накладна / вимога) у список виробів і зіставлення з довідником.
//
// Підтримувані формати:
//   • PDF з текстовим шаром (експорт з Google Docs / Word)        — читається без OCR, найточніше
//   • DOCX (Word)                                                  — читаються таблиці документа
//   • JPG / PNG (фото, скан) та PDF без тексту (скан)              — OCR (tesseract.js, укр. + англ.)
//
// Важливо: результат розбору — це ЧЕРНЕТКА. Інтерфейс (DocumentImportModal в App.jsx) завжди показує її
// на перевірку, а всі поля можна виправити. OCR на фото може помилятись у цифрах і назвах.
//
// Файл навмисно розділений на дві частини:
//   1) чиста логіка (витяг таблиці з позиційного тексту / з таблиць Word / з рядків; зіставлення з довідником) —
//      не залежить від браузера й легко тестується;
//   2) адаптери до бібліотек (pdfjs-dist, mammoth, tesseract.js) — підвантажуються ЛИШЕ коли користувач
//      обрав файл відповідного типу, тож на звичайну роботу застосунку вони не впливають.

// =====================================================================================
// 0. Дрібні утиліти
// =====================================================================================

const norm = (s) => String(s === undefined || s === null ? '' : s).replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
const lc = (s) => norm(s).toLowerCase();

/** "38" / "1 200" / "2,5" → число; усе інше → null */
export const parseNumber = (s) => {
  const t = norm(s).replace(/\s/g, '').replace(',', '.');
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};

const median = (arr, fallback) => {
  const a = arr.filter((x) => Number.isFinite(x) && x > 0).sort((x, y) => x - y);
  if (a.length === 0) return fallback;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};

// Одиниці виміру, які зустрічаються у вимогах/накладних
const UNIT_RE = /^(шт|уп|упак|пач|од|компл|комплект|набір|фл|флак|амп|пар|рул|рулон|м|мл|л|кг|г|табл|капс|тюб)\.?$/i;

// Рядки, з яких починається підвал документа (підписи) — таблиця на цьому закінчується
const STOP_RE = /^(відпустив|отримав|погоджено|разом|всього|підсумок|затверджую|керівник|начальник|голова|завідувач)/i;

// =====================================================================================
// 1. Розпізнавання заголовка таблиці
// =====================================================================================

const HEADER_ROLES = [
  ['no', /^(№|no\.?|n°|з\/п|п\/п|№\s*з\/п)$/i],
  ['name', /найменув|назва|найм\.|товар|матеріал|виріб/i],
  ['unit', /^одиниц|^од\.?\s*вим|^од\.$/i],
  ['price', /^ціна/i],
  ['requested', /вимагає|замовл|потреб|заявл/i],
  ['issued', /відпущ|видан|отримано|прийнято/i],
  ['qty', /^кількість|^к-сть|^кіл-сть|^кільк|^використан|^списан|^витрач/i],
  ['stock', /наявн|залишок/i],
  ['avg', /середньо/i],
  ['code', /артикул|^код\b|каталож|^ref\b|^арт\./i]
];

const LAT_HEADER_FOLD = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', i: 'і', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' };
const foldHeaderWord = (t) => t.split('').map((ch) => LAT_HEADER_FOLD[ch] || ch).join('');

const roleOf = (text) => {
  const t = lc(text);
  if (!t) return null;
  // OCR нерідко плутає кириличні й латинські літери-двійники → перевіряємо і як є, і з поправкою
  const variants = [t, foldHeaderWord(t)];
  for (const [role, re] of HEADER_ROLES) if (variants.some((v) => re.test(v))) return role;
  return null;
};

// =====================================================================================
// 2. Витяг із ПОЗИЦІЙНОГО тексту (PDF з текстовим шаром і OCR).
//    items: [{ text, x, y, w, h }]  — y росте ВНИЗ (для pdf.js передавайте -transform[5]).
// =====================================================================================

function groupIntoLines(items, tol) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(it.y - last.y) <= tol) {
      last.items.push(it);
      last.y = (last.y * (last.items.length - 1) + it.y) / last.items.length;
    } else {
      lines.push({ y: it.y, items: [it] });
    }
  }
  lines.forEach((l) => l.items.sort((a, b) => a.x - b.x));
  return lines;
}

/**
 * OCR інколи розбиває одне число на частини ("77" → "7" + "7"). Склеюємо сусідні суто цифрові
 * фрагменти на одному рядку, якщо проміжок між ними менший за пів висоти символу.
 */
export function mergeDigitFragments(items, medianH) {
  const lines = groupIntoLines(items, Math.max(2, medianH * 0.5));
  const out = [];
  for (const line of lines) {
    let prev = null;
    for (const it of line.items) {
      const digits = /^\d+$/.test(norm(it.text));
      if (prev && digits && /^\d+$/.test(norm(prev.text)) && it.x - (prev.x + (prev.w || 0)) <= medianH * 0.6) {
        prev = { ...prev, text: norm(prev.text) + norm(it.text), w: it.x + (it.w || 0) - prev.x };
        out[out.length - 1] = prev;
      } else {
        prev = it; out.push(it);
      }
    }
  }
  return out;
}

/**
 * Відома вада OCR: повторювані однакові цифри губляться ("77" → "7", "11" → "1"), але рамка слова лишається
 * завширшки у дві цифри. Якщо слово складається з однакових цифр і значно ширше за типову цифру — повторюємо цифру.
 * Повертає { items, repaired } — кількість виправлених слів, щоб попередити користувача.
 */
export function repairRepeatedDigits(items) {
  const numeric = items.filter((i) => /^\d{2,}$/.test(norm(i.text)) && i.w > 0);
  if (numeric.length < 3) return { items, repaired: 0 };
  const perDigit = median(numeric.map((i) => i.w / norm(i.text).length), 0);
  if (!perDigit) return { items, repaired: 0 };
  let repaired = 0;
  const out = items.map((it) => {
    const t = norm(it.text);
    if (!/^(\d)\1*$/.test(t) || !(it.w > 0)) return it;
    const expected = Math.round(it.w / perDigit);
    if (expected > t.length && it.w / perDigit >= t.length + 0.6 && expected <= 4) {
      repaired++;
      return { ...it, text: t[0].repeat(expected) };
    }
    return it;
  });
  return { items: out, repaired };
}

function joinLines(lines) {
  // Переноси через дефіс наприкінці рядка ("наконеч-" + "ником") склеюємо без пробілу.
  let out = '';
  lines.forEach((l, i) => {
    const t = norm(l.items.map((it) => it.text).join(' '));
    if (!t) return;
    if (i === 0 || !out) out = t;
    else if (/[а-яіїєґa-z]-$/i.test(out) && /^[а-яіїєґa-z]/.test(t)) out = out.slice(0, -1) + t;
    else out += ' ' + t;
  });
  return norm(out);
}

function detectHeader(items, medianH) {
  const hits = [];
  for (const it of items) {
    const role = roleOf(it.text);
    if (role) hits.push({ role, it });
  }
  hits.sort((a, b) => a.it.y - b.it.y);
  let best = null;
  for (let i = 0; i < hits.length; i++) {
    const top = hits[i].it.y;
    const win = hits.filter((h) => h.it.y >= top - 1 && h.it.y <= top + medianH * 4.5);
    const roles = new Set(win.map((h) => h.role));
    const hasQty = roles.has('requested') || roles.has('issued') || roles.has('qty');
    if (!roles.has('name') || !hasQty) continue;
    const score = ['name', 'unit', 'requested', 'issued', 'qty', 'price', 'code'].filter((r) => roles.has(r)).length + (roles.has('no') ? 0.5 : 0);
    if (!best || score > best.score) best = { score, win };
  }
  if (!best) return null;

  const anchors = {};
  for (const h of best.win) {
    const cur = anchors[h.role];
    if (!cur || h.it.x < cur.x) anchors[h.role] = { x: h.it.x, w: h.it.w || 0, cx: h.it.x + (h.it.w || 0) / 2 };
  }
  // Усі "№ / з/п" (вони бувають у двох рядках) — для зони номерів рядків
  const noHits = best.win.filter((h) => h.role === 'no').map((h) => h.it);
  const bottom = Math.max(...best.win.map((h) => h.it.y));
  return { anchors, noHits, bottom };
}

/**
 * @param {Array<Array<{text,x,y,w,h}>>} pages — елементи по сторінках (для зображення — одна "сторінка")
 * @param {{ skipOcrRepairs?: boolean }} [opts] — skipOcrRepairs: не застосовувати виправлення вад tesseract
 *   (склеювання "7"+"7", відновлення "77" за шириною слова). Для слів від Google Vision їх вимикаємо:
 *   Vision не розбиває числа, а евристика за шириною могла б мовчки перетворити правильне "8" на "88".
 * @returns {{ rows: Array, warnings: string[], headerFound: boolean }}
 */
export function extractFromPositioned(pages, opts = {}) {
  const rows = [];
  const warnings = [];
  let carried = null; // колонки із заголовка попередньої сторінки (таблиця може тривати на наступних)
  let headerFound = false;

  pages.forEach((pageItemsRaw, pageIdx) => {
    // OCR часто перетворює межі клітинок на "|" / "¦" / "_": це не текст
    const cleaned = pageItemsRaw
      .map((it) => ({ ...it, text: String(it.text).replace(/[|¦_]+/g, ' ') }))
      .filter((it) => norm(it.text));
    if (cleaned.length === 0) return;
    const medianH = median(cleaned.map((i) => i.h), 10);
    const merged = opts.skipOcrRepairs ? cleaned : mergeDigitFragments(cleaned, medianH);
    const fixed = opts.skipOcrRepairs ? { items: merged, repaired: 0 } : repairRepeatedDigits(merged);
    const pageItems = fixed.items;
    if (fixed.repaired) warnings.push(`OCR пропустив повторювані цифри в ${fixed.repaired} числах — їх відновлено за шириною слова (перевірте кількості).`);

    let header = detectHeader(pageItems, medianH);
    if (header) { carried = header; headerFound = true; }
    else if (carried) header = { ...carried, bottom: -Infinity, continued: true };
    if (!header) return;

    const A = header.anchors;
    const lineTol = Math.max(2, medianH * 0.5);

    // --- зони колонок ---
    const noRight = header.noHits.length ? Math.max(...header.noHits.map((i) => i.x + (i.w || 0))) : null;
    const noLeft = header.noHits.length ? Math.min(...header.noHits.map((i) => i.x)) : null;
    const markerMinX = noLeft !== null ? noLeft - 15 : -Infinity;
    const markerMaxX = noRight !== null ? noRight + 4 : (A.name ? A.name.x - 6 : Infinity);

    const firstNumericAnchorX = ['price', 'requested', 'issued', 'qty', 'stock', 'avg']
      .map((r) => (A[r] ? A[r].x : Infinity)).reduce((a, b) => Math.min(a, b), Infinity);
    const nameRight = (A.unit ? A.unit.x : firstNumericAnchorX) - 4;

    const numericRoles = ['price', 'requested', 'issued', 'qty', 'stock', 'avg', 'code']
      .filter((r) => A[r] && r !== 'code')
      .filter((r) => !(r === 'qty' && (A.requested || A.issued)));

    const isMarker = (it) => /^\(?\d{1,3}[.,:;)]?$/.test(norm(it.text)) && it.x >= markerMinX && it.x <= markerMaxX;

    const body = pageItems.filter((it) => it.y > header.bottom + medianH * 0.5);

    // --- кінець таблиці: перший рядок підвалу з підписами ---
    let endY = Infinity;
    for (const line of groupIntoLines(body, lineTol)) {
      const first = line.items[0];
      if (first && first.x < nameRight && STOP_RE.test(lc(first.text))) { endY = line.y - lineTol; break; }
    }
    const tableItems = body.filter((it) => it.y < endY);

    const markers = tableItems.filter(isMarker).sort((a, b) => a.y - b.y);
    if (markers.length === 0) return;
    const tol = Math.max(3, medianH * 0.6);

    const buckets = markers.map((m) => ({ marker: m, name: [], unit: null, nums: {} }));
    for (const it of tableItems) {
      if (isMarker(it)) continue;
      // останній маркер, що знаходиться вище елемента (або не нижче ніж на tol)
      let idx = -1;
      for (let i = 0; i < markers.length; i++) { if (markers[i].y - tol <= it.y) idx = i; else break; }
      if (idx < 0) continue;
      const b = buckets[idx];
      const text = norm(it.text);

      if (it.x < nameRight) {
        if (noRight === null || it.x >= noRight - 2) b.name.push(it);
      } else if (UNIT_RE.test(text)) {
        if (!b.unit) b.unit = text;
      } else {
        const n = parseNumber(text);
        if (n !== null && numericRoles.length) {
          const cx = it.x + (it.w || 0) / 2;
          let bestRole = null; let bestD = Infinity;
          for (const r of numericRoles) { const d = Math.abs(cx - A[r].cx); if (d < bestD) { bestD = d; bestRole = r; } }
          if (bestRole && bestD <= Math.max(40, (A[bestRole].w || 0))) { if (b.nums[bestRole] === undefined) b.nums[bestRole] = n; }
        }
      }
    }

    for (const b of buckets) {
      const lines = groupIntoLines(b.name, lineTol);
      const name = joinLines(lines);
      rows.push({
        rowNo: parseInt(norm(b.marker.text).replace(/\D/g, ''), 10),
        name,
        unit: b.unit || '',
        requested: b.nums.requested !== undefined ? b.nums.requested : (b.nums.qty !== undefined ? b.nums.qty : null),
        issued: b.nums.issued !== undefined ? b.nums.issued : null,
        page: pageIdx + 1
      });
    }
  });

  return { rows, warnings, headerFound };
}

// =====================================================================================
// 3. Витяг із ТАБЛИЦЬ (Word): tables = [ [ [cell, cell, ...], ... ], ... ]
// =====================================================================================

export function extractFromTables(tables) {
  const rows = [];
  const warnings = [];

  for (const table of tables) {
    // --- рядок заголовка: ≥ 2 розпізнані ролі, серед них "назва" ---
    let headerIdx = -1; let cols = null;
    for (let r = 0; r < Math.min(table.length, 8); r++) {
      const map = {};
      table[r].forEach((cell, c) => { const role = roleOf(cell); if (role && map[role] === undefined) map[role] = c; });
      const roles = Object.keys(map);
      if (map.name !== undefined && roles.length >= 2) { headerIdx = r; cols = map; break; }
    }

    if (headerIdx >= 0) {
      // Заголовок може займати 2 рядки (напр. "Кількість" зверху, "Вимагається | Відпущено" знизу) — зливаємо
      const next = table[headerIdx + 1];
      let dataStart = headerIdx + 1;
      if (next) {
        const map2 = {};
        next.forEach((cell, c) => { const role = roleOf(cell); if (role && map2[role] === undefined) map2[role] = c; });
        if (map2.requested !== undefined || map2.issued !== undefined) {
          Object.assign(cols, map2);
          dataStart = headerIdx + 2;
        }
      }
      if (cols.requested === undefined && cols.issued === undefined && cols.qty === undefined) {
        warnings.push('У таблиці не знайдено стовпця з кількістю.');
      }
      for (let r = dataStart; r < table.length; r++) {
        const cells = table[r];
        const cell = (role) => (cols[role] !== undefined ? norm(cells[cols[role]]) : '');
        const name = cell('name');
        if (!name || !/[a-zа-яіїєґ]{3,}/i.test(name)) continue;
        if (STOP_RE.test(lc(name))) break;
        if (roleOf(name) === 'name' && /^найменув/i.test(lc(name))) continue; // повторений заголовок
        const requested = parseNumber(cell('requested'));
        const qtyOnly = parseNumber(cell('qty'));
        rows.push({
          rowNo: parseInt(cell('no'), 10) || null,
          name: cols.code !== undefined && cell('code') ? `${name} ${cell('code')}` : name,
          unit: cell('unit'),
          requested: requested !== null ? requested : qtyOnly,
          issued: parseNumber(cell('issued')),
          code: cell('code') || ''
        });
      }
    } else {
      // --- без заголовка: евристика ---
      let used = 0;
      for (const cells of table) {
        const texts = cells.map(norm);
        const nameCell = [...texts].filter((t) => /[a-zа-яіїєґ]{3,}/i.test(t)).sort((a, b) => b.length - a.length)[0];
        if (!nameCell) continue;
        if (STOP_RE.test(lc(nameCell))) break;
        const nameIdx = texts.indexOf(nameCell);
        const unitIdx = texts.findIndex((t, i) => i > nameIdx && UNIT_RE.test(t));
        const nums = texts.map((t, i) => ({ n: parseNumber(t), i })).filter((x) => x.n !== null && x.i > (unitIdx >= 0 ? unitIdx : nameIdx));
        if (nums.length === 0) continue;
        used++;
        rows.push({
          rowNo: parseNumber(texts[0]) !== null && nameIdx > 0 ? parseNumber(texts[0]) : null,
          name: nameCell,
          unit: unitIdx >= 0 ? texts[unitIdx] : '',
          requested: nums[0].n,
          issued: null
        });
      }
      if (used) warnings.push('Заголовок таблиці не розпізнано: кількість взято з першого числового стовпця — перевірте.');
    }
  }
  return { rows, warnings };
}

// =====================================================================================
// 4. Витяг із простих РЯДКІВ тексту (запасний варіант, коли заголовок таблиці не розпізнано)
// =====================================================================================

const ROW_START_RE = /^(\d{1,3})\s*[.)]?\s+(\S.*)$/;
const UNIT_QTY_RE = /^(.*?)\s+(шт|уп|упак|пач|од|компл|комплект|набір|фл|флак|амп|пар|рул|рулон|м|мл|л|кг|г|табл|капс|тюб)\.?\s+(\d+(?:[.,]\d+)?)(?:\s+(\d+(?:[.,]\d+)?))?(?=\s|$)/i;

export function extractFromLines(lines) {
  const rows = [];
  const warnings = [];
  let cur = null; let lastNo = null;

  const tryComplete = (row) => {
    const m = UNIT_QTY_RE.exec(norm(row.text));
    if (!m) return false;
    row.complete = true;
    row.nameText = norm(m[1]);
    row.unit = m[2];
    row.requested = parseNumber(m[3]);
    row.issued = null;
    row.tail = norm(row.text.slice(m[0].length));
    return true;
  };
  const flush = () => { if (cur) { if (!cur.complete) tryComplete(cur); if (cur.complete) rows.push(cur); cur = null; } };

  for (const raw of lines) {
    const line = norm(raw);
    if (!line) continue;
    if (STOP_RE.test(lc(line))) { flush(); break; }
    const m = ROW_START_RE.exec(line);
    const startsRow = !!m && (!cur || cur.complete || parseInt(m[1], 10) === lastNo + 1);
    if (startsRow) {
      flush();
      lastNo = parseInt(m[1], 10);
      cur = { rowNo: lastNo, text: m[2], complete: false };
      tryComplete(cur);
    } else if (cur) {
      if (cur.complete) { cur.extra = norm((cur.extra || '') + ' ' + line); }
      else { cur.text = norm(cur.text + ' ' + line); tryComplete(cur); }
    }
  }
  flush();

  const out = rows.map((r) => ({
    rowNo: r.rowNo,
    name: norm(r.nameText + (r.extra ? ' ' + r.extra : '')),
    unit: r.unit,
    requested: r.requested,
    issued: null
  }));
  if (out.length) warnings.push('Таблицю розпізнано за текстом рядків, без прив\'язки до стовпців: перевірте кількість.');
  return { rows: out, warnings };
}

// =====================================================================================
// 5. Підсумкова обробка рядків → позиції
// =====================================================================================

export function finalizeItems(rawRows, extraWarnings = []) {
  const warnings = [...extraWarnings];
  const items = [];
  let dropped = 0;
  for (const r of rawRows) {
    const name = norm(r.name);
    if (!/[a-zа-яіїєґ]{3,}/i.test(name)) { dropped++; continue; }
    const issued = r.issued !== null && r.issued !== undefined && r.issued > 0 ? r.issued : null;
    const requested = r.requested !== null && r.requested !== undefined && r.requested > 0 ? r.requested : null;
    // За замовчуванням у прихід йде "Відпущено", а якщо воно порожнє — "Вимагається" (користувач може змінити).
    const qty = issued !== null ? issued : requested;
    items.push({
      rowNo: r.rowNo || null,
      name,
      unit: norm(r.unit),
      code: norm(r.code || ''),
      requested,
      issued,
      qty,
      qtySource: issued !== null ? 'issued' : requested !== null ? 'requested' : null
    });
  }
  if (dropped) warnings.push(`Пропущено рядків без назви: ${dropped}.`);
  const noQty = items.filter((i) => i.qty === null).map((i) => i.rowNo || '?');
  if (noQty.length) warnings.push(`Не вдалося визначити кількість у рядках: ${noQty.join(', ')}.`);
  const seen = {}; const dup = [];
  items.forEach((i) => { if (i.rowNo) { if (seen[i.rowNo] && dup.indexOf(i.rowNo) === -1) dup.push(i.rowNo); seen[i.rowNo] = true; } });
  if (dup.length) warnings.push(`У документі повторюються номери рядків (${dup.join(', ')}) — можливо, друкарська помилка; перевірте позиції.`);
  return { items, warnings };
}

// =====================================================================================
// 6. ЗІСТАВЛЕННЯ З ДОВІДНИКОМ
// =====================================================================================

const CYR_LOOKALIKE = { 'А': 'A', 'В': 'B', 'С': 'C', 'Е': 'E', 'Н': 'H', 'К': 'K', 'М': 'M', 'О': 'O', 'Р': 'P', 'Т': 'T', 'Х': 'X', 'І': 'I', 'Ї': 'I', 'У': 'Y' };
const LAT_TO_CYR = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', i: 'і', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' };

/** Код для порівняння: великі літери, кириличні двійники → латиниця ("94215Т" == "94215T"), без пробілів/дефісів. */
export function normalizeCode(s) {
  return norm(s).toUpperCase().split('').map((ch) => CYR_LOOKALIKE[ch] || ch).join('').replace(/[^A-Z0-9]/g, '');
}

const UNIT_WORDS = new Set(['мл', 'мг', 'мм', 'см', 'г', 'кг', 'л', 'шт', 'мкг', 'ме', 'од', 'fr', 'ml', 'mg', 'mm', 'cm', 'kg', '%']);

/** Артикули/коди в тексті "як написано": токени з ≥ 4 цифр, або ≥ 3 цифр і літерами; числа з одиницями ("1000 мл") — не коди. */
export function extractCodeTokens(text) {
  const tokens = norm(text).split(/[\s,;()]+/).filter(Boolean);
  const out = [];
  tokens.forEach((tok, i) => {
    const clean = tok.replace(/^[^A-Za-zА-Яа-яІіЇїЄє0-9]+|[^A-Za-zА-Яа-яІіЇїЄє0-9]+$/g, '');
    const digits = (clean.match(/\d/g) || []).length;
    const hasLetters = /[A-Za-zА-Яа-яІіЇїЄє]/.test(clean);
    if (!(digits >= 4 || (digits >= 3 && hasLetters))) return;
    if (clean.length > 20) return;
    const next = (tokens[i + 1] || '').toLowerCase().replace(/[^a-zа-яіїє%]/g, '');
    if (!hasLetters && UNIT_WORDS.has(next)) return;
    if (/^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/.test(clean)) return; // дати
    out.push(clean);
  });
  return out;
}

/** Артикули/коди в тексті у нормалізованому вигляді (для порівняння). */
export function extractCodes(text) {
  const out = [];
  extractCodeTokens(text).forEach((t) => { const code = normalizeCode(t); if (code && out.indexOf(code) === -1) out.push(code); });
  return out;
}

const CYR_TO_LAT_CODE = { 'А': 'A', 'В': 'B', 'С': 'C', 'Е': 'E', 'Н': 'H', 'К': 'K', 'М': 'M', 'О': 'O', 'Р': 'P', 'Т': 'T', 'Х': 'X', 'І': 'I', 'У': 'Y',
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'і': 'i', 'у': 'y' };

/** "94215Т" (кирилична Т) → "94215T": у коді матеріалу літери-двійники записуємо латиницею. */
export function latinizeCode(code) {
  return String(code === undefined || code === null ? '' : code).split('').map((ch) => CYR_TO_LAT_CODE[ch] || ch).join('');
}

/** Код для НОВОГО матеріалу довідника: стовпець "Артикул" документа, а якщо його немає — останній артикул у назві. */
export function suggestCode(item) {
  if (item && norm(item.code)) return latinizeCode(norm(item.code));
  const tokens = extractCodeTokens(item ? item.name : '');
  return tokens.length ? latinizeCode(tokens[tokens.length - 1]) : '';
}

const STOPWORDS = new Set(['та', 'і', 'й', 'з', 'із', 'для', 'на', 'в', 'у', 'до', 'по', 'або', 'від', 'про', 'шт', 'the', 'and']);

/** Токени назви для порівняння: нижній регістр, латинські двійники → кирилиця, "основа" слова = перші 5 літер. */
export function nameTokens(text) {
  return lc(text).replace(/[^a-zа-яіїєґ0-9]+/g, ' ').split(' ').filter(Boolean)
    .map((t) => (/\d/.test(t) ? t : t.split('').map((ch) => LAT_TO_CYR[ch] || ch).join('').slice(0, 5)))
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

const toSet = (arr) => new Set(arr);

function diceSets(A, B) {
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0; A.forEach((t) => { if (B.has(t)) inter++; });
  return (2 * inter) / (A.size + B.size);
}

const isBarcodeLike = (code) => /^\d{12,}$/.test(code); // GTIN/EAN — це не "артикул виробника"

function materialCodes(mat) {
  const own = normalizeCode(mat.code);
  const fromName = extractCodes(mat.name);
  const all = []; const article = [];
  if (own.length >= 4 && /\d/.test(own)) {
    all.push(own);
    if (!isBarcodeLike(own)) article.push(own);
  }
  fromName.forEach((c) => { if (all.indexOf(c) === -1) all.push(c); article.push(c); });
  return { all, article };
}

const stripZeros = (c) => (/^\d+$/.test(c) ? c.replace(/^0+/, '') : c);

function codesIntersect(docCodes, matCodes) {
  for (const d of docCodes) {
    for (const m of matCodes) {
      if (stripZeros(d) === stripZeros(m)) return true;
      const [short, long] = d.length <= m.length ? [d, m] : [m, d];
      if (short.length >= 5 && long.includes(short)) return true; // "DLP66236" ⊃ "66236"
    }
  }
  return false;
}

// Усе, що можна порахувати наперед (один раз на матеріал / на позицію), щоб зіставлення було швидким навіть для великих довідників.
const prepareMaterial = (mat) => ({ id: mat.id, ...materialCodes(mat), tokens: toSet(nameTokens(mat.name)) });
const prepareItem = (item) => ({ codes: extractCodes(item.name + ' ' + (item.code || '')), tokens: toSet(nameTokens(item.name)) });

function scorePrepared(di, pm) {
  const sim = diceSets(di.tokens, pm.tokens);
  if (di.codes.length && pm.all.length && codesIntersect(di.codes, pm.all)) {
    return { score: 0.9 + 0.1 * sim, kind: 'code' };
  }
  // Захист від підміни: якщо в документа і в матеріалу є артикули, але РІЗНІ — це різні вироби
  // (наприклад, ДЛП 66236 і ДЛП 66132): за схожою назвою вони не вибираються автоматично.
  if (di.codes.length && pm.article.length) {
    return { score: Math.min(sim, 0.5), kind: 'conflict' };
  }
  return { score: sim, kind: sim >= 0.85 ? 'name' : sim >= 0.6 ? 'similar' : 'weak' };
}

/** Оцінка збігу позиції документа з одним матеріалом довідника. */
export function scoreMaterial(item, mat) {
  return scorePrepared(prepareItem(item), prepareMaterial(mat));
}

/**
 * @returns {{ materialId: string|null, kind: 'code'|'name'|'similar'|'none', score: number, ambiguous: boolean,
 *             candidates: Array<{id: string, score: number, kind: string}> }}
 */
export function matchItem(item, materials, prepared) {
  const P = prepared || materials.map(prepareMaterial);
  const di = prepareItem(item);
  const scored = P
    .map((pm) => ({ id: pm.id, ...scorePrepared(di, pm) }))
    .filter((s) => s.score >= 0.4)
    .sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, 5);
  const best = scored[0];
  if (!best || best.kind === 'conflict' || best.kind === 'weak') {
    return { materialId: null, kind: 'none', score: best ? best.score : 0, ambiguous: false, candidates };
  }
  const second = scored[1];
  const ambiguous = !!second && second.kind !== 'conflict' && second.kind !== 'weak' && best.score - second.score < 0.03;
  return { materialId: best.id, kind: best.kind, score: best.score, ambiguous, candidates };
}

export function matchItems(items, materials) {
  const prepared = materials.map(prepareMaterial);
  return items.map((item) => ({ item, match: matchItem(item, materials, prepared) }));
}

// =====================================================================================
// 6b. СПИСАННЯ З ПАРТІЙ: з яких партій і скільки списувати за позицією документа
// =====================================================================================

/** Партії матеріалу, що є в наявності, у порядку "спершу ті, що швидше спливають"; прострочені — в кінці й позначені. */
export function availableBatches(stock, materialId, todayStr) {
  return stock
    .filter((b) => b.material_id === materialId && Number(b.quantity) > 0)
    .map((b) => ({ ...b, expired: !!b.expiration_date && String(b.expiration_date) < todayStr }))
    .sort((a, b) => (Number(a.expired) - Number(b.expired)) || String(a.expiration_date || '9999-99-99').localeCompare(String(b.expiration_date || '9999-99-99')));
}

/**
 * Автоматично (за терміном) можна списувати лише матеріали без розмірів і серійних номерів.
 * Імплант чи виріб із розміром підбирати "навмання" не можна — користувач обирає конкретну партію сам.
 */
export function isAutoAllocatable(batches) {
  return batches.length > 0 && batches.every((b) => !norm(b.serial_number) && !norm(b.size));
}

/**
 * План списання для відмічених рядків. Рядки опрацьовуються по черзі й "з'їдають" залишок один в одного,
 * тож два рядки з одним матеріалом не спишуть більше, ніж є; враховується і те, що вже лежить у кошику.
 * Прострочені партії автоматично НЕ використовуються — лише якщо користувач обрав таку партію вручну.
 * rows: [{ key, selected, added, materialId, qty, batchChoice ('auto' | id партії) }]
 * Повертає { [key]: { status, lines:[{batch, qty}], usesExpired, shortage?, available?, expiredOnly? } }
 * status: ok | no_material | bad_qty | no_stock | manual_required | batch_gone | shortage
 */
export function planWriteoffRows(rows, stock, cart, todayStr) {
  const used = {};
  (cart || []).forEach((e) => { used[e.stock_batch_id] = (used[e.stock_batch_id] || 0) + Number(e.quantity || 0); });
  const remaining = (b) => Math.max(0, Number(b.quantity) - (used[b.id] || 0));
  const plans = {};

  for (const r of rows) {
    if (!r.selected || r.added) continue;
    const qty = Number(r.qty);
    if (!r.materialId) { plans[r.key] = { status: 'no_material', lines: [] }; continue; }
    if (!(qty > 0)) { plans[r.key] = { status: 'bad_qty', lines: [] }; continue; }
    const all = availableBatches(stock, r.materialId, todayStr);
    if (all.length === 0) { plans[r.key] = { status: 'no_stock', lines: [] }; continue; }

    if (r.batchChoice && r.batchChoice !== 'auto') {
      const b = all.find((x) => x.id === r.batchChoice);
      if (!b) { plans[r.key] = { status: 'batch_gone', lines: [] }; continue; }
      const rem = remaining(b);
      if (qty > rem) { plans[r.key] = { status: 'shortage', lines: [], shortage: qty - rem, available: rem, manual: true }; continue; }
      used[b.id] = (used[b.id] || 0) + qty;
      plans[r.key] = { status: 'ok', lines: [{ batch: b, qty }], usesExpired: !!b.expired, manual: true };
      continue;
    }

    if (!isAutoAllocatable(all)) { plans[r.key] = { status: 'manual_required', lines: [] }; continue; }
    let need = qty; const lines = [];
    for (const b of all) {
      if (b.expired) continue;
      const rem = remaining(b);
      if (rem <= 0) continue;
      const take = Math.min(rem, need);
      lines.push({ batch: b, qty: take });
      need -= take;
      if (need <= 0) break;
    }
    if (need > 0) {
      const expiredOnly = lines.length === 0 && all.every((b) => b.expired);
      plans[r.key] = { status: 'shortage', lines, shortage: need, available: qty - need, expiredOnly };
      continue;
    }
    lines.forEach((l) => { used[l.batch.id] = (used[l.batch.id] || 0) + l.qty; });
    plans[r.key] = { status: 'ok', lines, usesExpired: false, manual: false };
  }
  return plans;
}

// =====================================================================================
// 7. Парсинг файлів (адаптери бібліотек)
// =====================================================================================

const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function detectKind(file) {
  const name = (file && file.name ? file.name : '').toLowerCase();
  const type = (file && file.type ? file.type : '').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';
  if (ext === 'pdf' || type === 'application/pdf') return 'pdf';
  if (ext === 'docx' || type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (ext === 'doc' || type === 'application/msword') return 'doc';
  if (type.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'bmp'].includes(ext)) return 'image';
  return 'unknown';
}

/** Мінімальний розбір HTML від mammoth: таблиці → масив рядків/клітинок; абзаци → рядки тексту. */
export function htmlToStructure(html) {
  const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
  const text = (s) => norm(decode(s.replace(/<br\s*\/?>/gi, ' ').replace(/<\/p>/gi, ' ').replace(/<[^>]+>/g, ' ')));
  const span = (attrs, name) => { const m = new RegExp(name + '\\s*=\\s*"?(\\d+)', 'i').exec(attrs || ''); return m ? Math.max(1, parseInt(m[1], 10)) : 1; };

  const tables = [];
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let m;
  while ((m = tableRe.exec(html))) {
    const grid = [];
    const pending = []; // pending[col] = скільки ще рядків займає об'єднана (rowspan) клітинка
    const trRe = /<tr[\s\S]*?<\/tr>/gi; let tr;
    while ((tr = trRe.exec(m[0]))) {
      const row = []; let col = 0;
      const place = (value) => { row[col] = value; col++; };
      const skipOccupied = () => { while (pending[col] > 0) { pending[col]--; place(''); } };
      const tdRe = /<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi; let td;
      while ((td = tdRe.exec(tr[0]))) {
        skipOccupied();
        const cs = span(td[1], 'colspan'); const rs = span(td[1], 'rowspan');
        const value = text(td[2]);
        for (let k = 0; k < cs; k++) { if (rs > 1) pending[col] = rs - 1; place(k === 0 ? value : ''); }
      }
      skipOccupied();
      if (row.some((c) => c !== undefined && c !== '')) grid.push(row.map((c) => (c === undefined ? '' : c)));
    }
    if (grid.length) tables.push(grid);
  }
  const outsideTables = html.replace(tableRe, ' ');
  const paragraphs = [];
  const pRe = /<(p|h[1-6]|li)\b[^>]*>([\s\S]*?)<\/\1>/gi; let p;
  while ((p = pRe.exec(outsideTables))) { const t = text(p[2]); if (t) paragraphs.push(t); }
  return { tables, paragraphs };
}

const defaultLoaders = {
  async pdfjs() {
    const mod = await import('pdfjs-dist');
    const pdfjs = mod.default && mod.default.getDocument ? mod.default : mod;
    // Воркер pdf.js: підхоплюється і Vite, і webpack 5 (так рекомендує документація react-pdf).
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.js', import.meta.url).toString();
    return pdfjs;
  },
  async mammoth() {
    const mod = await import('mammoth');
    return mod.default && mod.default.convertToHtml ? mod.default : mod;
  },
  async tesseract() {
    return import('tesseract.js');
  }
};

/** Локальний (адаптивний) поріг: 1 = "чорнило", 0 = фон. Працює і при нерівному освітленні фото. */
function binarize(gray, width, height, withLoose = false) {
  const W = width + 1;
  const integral = new Float64Array(W * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x];
      integral[(y + 1) * W + (x + 1)] = integral[y * W + (x + 1)] + rowSum;
    }
  }
  const half = Math.max(8, Math.round(Math.min(width, height) / 80));
  const fg = new Uint8Array(width * height);
  const loose = withLoose ? new Uint8Array(width * height) : null;
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - half); const y1 = Math.min(height, y + half + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - half); const x1 = Math.min(width, x + half + 1);
      const mean = (integral[y1 * W + x1] - integral[y0 * W + x1] - integral[y1 * W + x0] + integral[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
      const g = gray[y * width + x];
      fg[y * width + x] = g < mean * 0.86 && g < 200 ? 1 : 0;
      // після повороту лінії бліднуть: для ПОШУКУ ліній беремо чутливіший поріг
      if (loose) loose[y * width + x] = g < mean * 0.94 && g < 228 ? 1 : 0;
    }
  }
  return withLoose ? { fg, loose } : fg;
}

/**
 * Лінії таблиці = довгі, майже суцільні відрізки (з крихітними розривами, які лишає інтерполяція при повороті).
 * Щільність ≥ 90% відрізняє лінію від рядка тексту: у тексті між літерами значно більше проміжків.
 */
function findLines(mask, width, height, minRun, gapTol = 3, minDensity = 0.9) {
  const kill = new Uint8Array(width * height);
  const scan = (len, at, put) => {
    let start = -1; let last = -1; let count = 0;
    const close = () => {
      if (start >= 0) {
        const span = last - start + 1;
        if (span >= minRun && count / span >= minDensity) for (let k = start; k <= last; k++) put(k);
      }
      start = -1; last = -1; count = 0;
    };
    for (let i = 0; i < len; i++) {
      if (at(i)) { if (start < 0) start = i; last = i; count++; }
      else if (start >= 0 && i - last > gapTol) close();
    }
    close();
  };
  for (let y = 0; y < height; y++) scan(width, (x) => mask[y * width + x], (x) => { kill[y * width + x] = 1; });
  for (let x = 0; x < width; x++) scan(height, (y) => mask[y * width + x], (y) => { kill[y * width + x] = 1; });
  return kill;
}

/**
 * Кут нахилу тексту в градусах (додатний = рядки йдуть вниз праворуч).
 * Метод профілю проекцій: при правильному куті рядки тексту й лінії таблиці дають різкі піки у вертикальній гістограмі.
 */
export function estimateSkew(gray, width, height) {
  const f = Math.max(1, Math.round(Math.max(width, height) / 900)); // працюємо на зменшеній копії — швидко
  const sw = Math.floor(width / f); const sh = Math.floor(height / f);
  const small = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let sum = 0;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) sum += gray[(y * f + dy) * width + (x * f + dx)];
      small[y * sw + x] = sum / (f * f);
    }
  }
  const fg = binarize(small, sw, sh);
  const xs = []; const ys = [];
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) if (fg[y * sw + x]) { xs.push(x); ys.push(y); }
  if (xs.length < 200) return 0;

  const score = (deg) => {
    const t = Math.tan((deg * Math.PI) / 180);
    const bins = new Float64Array(sh * 2 + 4);
    const off = sh + 2;
    for (let i = 0; i < xs.length; i++) { const yy = Math.round(ys[i] - xs[i] * t) + off; if (yy >= 0 && yy < bins.length) bins[yy]++; }
    let sq = 0; for (let k = 0; k < bins.length; k++) sq += bins[k] * bins[k];
    return sq;
  };
  let best = 0; let bestScore = -1;
  for (let d = -5; d <= 5.0001; d += 0.25) { const sc = score(d); if (sc > bestScore) { bestScore = sc; best = d; } }
  for (let d = best - 0.25; d <= best + 0.2501; d += 0.05) { const sc = score(d); if (sc > bestScore) { bestScore = sc; best = d; } }
  return Math.round(best * 100) / 100;
}

/** Повертає відтінки сірого на кут deg (білі поля), білінійна інтерполяція. */
function rotateGray(gray, width, height, deg) {
  const a = (deg * Math.PI) / 180; const cos = Math.cos(a); const sin = Math.sin(a);
  const cx = width / 2; const cy = height / 2;
  const out = new Uint8Array(width * height).fill(255);
  for (let Y = 0; Y < height; Y++) {
    for (let X = 0; X < width; X++) {
      const dx = X - cx; const dy = Y - cy;
      const xs = dx * cos - dy * sin + cx;
      const ys = dx * sin + dy * cos + cy;
      const x0 = Math.floor(xs); const y0 = Math.floor(ys);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= width || y0 + 1 >= height) continue;
      const fx = xs - x0; const fy = ys - y0;
      const i = y0 * width + x0;
      out[Y * width + X] = gray[i] * (1 - fx) * (1 - fy) + gray[i + 1] * fx * (1 - fy) + gray[i + width] * (1 - fx) * fy + gray[i + width + 1] * fx * fy;
    }
  }
  return out;
}

/**
 * Підготовка зображення до OCR (чиста функція над RGBA-пікселями, змінює масив на місці):
 *   1) вирівнювання нахилу знімка (до ±5°) — інакше стовпці таблиці "пливуть" і кількості губляться;
 *   2) вирівнювання освітлення — локальний (адаптивний) поріг замість одного на все фото;
 *   3) видалення ЛІНІЙ ТАБЛИЦІ — довгі горизонтальні й вертикальні суцільні відрізки.
 * Без цього ґратки таблиці ламають розпізнавання: цілі рядки випадають, а "|" склеюється зі словами.
 * Результат — чорний текст на білому тлі.
 */
export function prepareForOcr(rgba, width, height) {
  const n = width * height;
  let gray = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) gray[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000;

  const skew = estimateSkew(gray, width, height);
  if (Math.abs(skew) >= 0.15) gray = rotateGray(gray, width, height, skew);

  const { fg, loose } = binarize(gray, width, height, true);

  // лінії таблиці — шукаємо на чутливій масці, стираємо з обох; розширюємо на 1 піксель, щоб прибрати "хвости" згладжування
  const minRun = Math.max(40, Math.round(Math.min(width, height) / 28));
  const lines = findLines(loose, width, height, minRun);
  const kill = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!lines[y * width + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx >= 0 && xx < width) kill[yy * width + xx] = 1; }
      }
    }
  }
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const v = fg[i] && !kill[i] ? 0 : 255;
    rgba[j] = v; rgba[j + 1] = v; rgba[j + 2] = v; rgba[j + 3] = 255;
  }
  return rgba;
}

/** Фото → canvas з урахуванням орієнтації EXIF (телефон часто пише знімок "боком") і зменшенням до розумного розміру. */
async function imageToCanvas(file, maxSide = 2600) {
  const bitmap = await createImageBitmap(file); // за замовчуванням застосовує EXIF-орієнтацію
  // Дуже дрібний знімок збільшуємо (OCR гірше читає текст заввишки < ~20 px), завеликий — зменшуємо.
  const longSide = Math.max(bitmap.width, bitmap.height);
  const scale = longSide < 1800 ? Math.min(3, 2400 / longSide) : Math.min(1, maxSide / longSide);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  prepareCanvasForOcr(canvas);
  return canvas;
}

function prepareCanvasForOcr(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  prepareForOcr(img.data, canvas.width, canvas.height);
  ctx.putImageData(img, 0, 0);
}

/** OCR: зображення/canvas → слова з координатами у форматі позиційного витягу. */
async function ocrToItems(image, { loaders, onProgress }) {
  const T = await loaders.tesseract();
  const createWorker = T.createWorker || (T.default && T.default.createWorker);
  const worker = await createWorker('ukr+eng', 1, {
    logger: (m) => { if (m && m.status === 'recognizing text') onProgress({ label: 'Розпізнавання тексту…', pct: Math.round((m.progress || 0) * 100) }); }
  });
  try {
    // 6 = "один однорідний блок тексту": для таблиць дає помітно кращий результат, ніж автоматична сегментація
    await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    const { data } = await worker.recognize(image);
    return (data.words || [])
      .filter((w) => norm(w.text) && (w.confidence === undefined || w.confidence >= 15))
      .map((w) => ({ text: w.text, x: w.bbox.x0, y: (w.bbox.y0 + w.bbox.y1) / 2, w: w.bbox.x1 - w.bbox.x0, h: w.bbox.y1 - w.bbox.y0 }));
  } finally {
    await worker.terminate();
  }
}

function positionedToItems(pages, opts = {}) {
  const warnings = [];
  const res = extractFromPositioned(pages, opts);
  let rows = res.rows;
  if (rows.length === 0) {
    // Заголовок не розпізнано → запасний розбір за рядками тексту
    const lines = [];
    pages.forEach((p) => groupIntoLines(p.filter((i) => norm(i.text)), Math.max(2, median(p.map((i) => i.h), 10) * 0.5))
      .forEach((l) => lines.push(l.items.map((i) => i.text).join(' '))));
    const fb = extractFromLines(lines);
    rows = fb.rows; warnings.push(...fb.warnings);
  }
  return finalizeItems(rows, warnings);
}

/**
 * Головна функція: файл → { items, warnings, source }.
 * Кидає Error з готовим для користувача текстом (українською).
 */
export async function parseDocumentFile(file, { onProgress = () => {}, loaders = defaultLoaders } = {}) {
  if (!file) throw new Error('Файл не обрано.');
  if (file.size > MAX_FILE_BYTES) throw new Error('Файл завеликий (понад 25 МБ).');
  const kind = detectKind(file);
  if (kind === 'doc') throw new Error('Формат .doc (старий Word) не підтримується. Збережіть файл як .docx або PDF і завантажте знову.');
  if (kind === 'unknown') throw new Error('Невідомий формат. Підтримуються: PDF, Word (.docx), фото JPG/PNG.');

  let result; let source;

  if (kind === 'docx') {
    onProgress({ label: 'Читаю документ Word…', pct: null });
    const mammoth = await loaders.mammoth();
    const { value: html } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
    const { tables, paragraphs } = htmlToStructure(html);
    let ex = extractFromTables(tables);
    if (ex.rows.length === 0 && paragraphs.length) ex = extractFromLines(paragraphs);
    result = finalizeItems(ex.rows, ex.warnings);
    source = 'docx';
  } else if (kind === 'pdf') {
    onProgress({ label: 'Читаю PDF…', pct: null });
    const pdfjs = await loaders.pdfjs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = []; let totalChars = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const items = tc.items
        .filter((i) => norm(i.str))
        .map((i) => ({ text: i.str, x: i.transform[4], y: -i.transform[5], w: i.width, h: i.height || Math.abs(i.transform[3]) }));
      totalChars += items.reduce((n, i) => n + i.text.length, 0);
      pages.push(items);
    }
    if (totalChars >= 40) {
      result = positionedToItems(pages);
      source = 'pdf-text';
    } else {
      // Немає текстового шару (скан) → відтворюємо сторінки в картинки й розпізнаємо
      const ocrPages = [];
      for (let p = 1; p <= doc.numPages; p++) {
        onProgress({ label: `Розпізнавання сторінки ${p} з ${doc.numPages}…`, pct: null });
        const page = await doc.getPage(p);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d', { willReadFrequently: true }), viewport }).promise;
        prepareCanvasForOcr(canvas);
        ocrPages.push(await ocrToItems(canvas, { loaders, onProgress }));
      }
      result = positionedToItems(ocrPages);
      result.warnings.unshift('Документ розпізнано за допомогою OCR (скан): назви й цифри можуть містити помилки — уважно перевірте.');
      source = 'pdf-ocr';
    }
  } else {
    onProgress({ label: 'Готую зображення…', pct: null });
    const canvas = await imageToCanvas(file);
    const words = await ocrToItems(canvas, { loaders, onProgress });
    result = positionedToItems([words]);
    result.warnings.unshift('Фото розпізнано за допомогою OCR: назви й цифри можуть містити помилки — уважно перевірте.');
    source = 'image-ocr';
  }

  if (result.items.length === 0) {
    throw new Error('Не вдалося знайти в документі таблицю з виробами. Переконайтесь, що в ній є стовпці «Найменування» і «Кількість» (або «Вимагається»).');
  }
  return { items: result.items, warnings: result.warnings, source };
}

// =====================================================================================
// 8. «Зчитати з AI» — розпізнавання ФОТО через Google Cloud Vision (лише за кнопкою)
// =====================================================================================
// Звичайне читання (tesseract, parseDocumentFile) не змінюється і лишається типовим. Ця гілка запускається
// тільки коли користувач сам натиснув «Зчитати з AI» — наприклад, коли фото надто складне для tesseract.
// Фото надсилається на сервер застосунку (Apps Script, дія 'ocrImage'), а звідти — у Vision. Ключ API у браузері
// ніколи не з'являється. Відповідь Vision приведена на сервері до того самого формату слів {text,x,y,w,h},
// що й вихід tesseract, тож розбір таблиці, зіставлення з довідником і план списання працюють без змін.

const AI_MAX_SIDE = 2000;                 // найбільша сторона фото, що йде в Vision (більше не дає користі, лише розмір)
const AI_MAX_BYTES = 3 * 1024 * 1024;     // сервер приймає до 4 МБ; беремо запас

/**
 * Масштаб, до якого tesseract-гілка наводить фото (див. imageToCanvas). Розбір таблиці має пікселні допуски
 * (напр. 40 px для прив'язки числа до стовпця), підібрані саме під цей масштаб, тому координати слів від Vision
 * приводимо до нього.
 */
function parserScaleFor(longSide) {
  return longSide < 1800 ? Math.min(3, 2400 / longSide) : Math.min(1, 2600 / longSide);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Не вдалося прочитати фото.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Фото → JPEG для Vision. На відміну від підготовки для tesseract, тут НЕ робимо чорно-біле й не стираємо лінії:
 * Vision краще читає звичайне кольорове фото. Лише: орієнтація EXIF, зменшення до AI_MAX_SIDE, стискання JPEG.
 * Повертає { base64, bytes, factor } — factor переводить координати Vision у масштаб розбору таблиці.
 */
async function imageToJpegForAi(file) {
  const bitmap = await createImageBitmap(file); // застосовує EXIF-орієнтацію
  try {
    const longSide = Math.max(bitmap.width, bitmap.height);
    const parserScale = parserScaleFor(longSide);
    let sentScale = Math.min(1, AI_MAX_SIDE / longSide);
    let quality = 0.85;
    for (let attempt = 0; attempt < 4; attempt++) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * sentScale));
      canvas.height = Math.max(1, Math.round(bitmap.height * sentScale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); // прозорі PNG → білий фон
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
      if (!blob) throw new Error('Не вдалося підготувати фото для AI.');
      if (blob.size <= AI_MAX_BYTES) {
        return { base64: await blobToBase64(blob), bytes: blob.size, factor: parserScale / sentScale };
      }
      sentScale *= 0.8; quality = Math.max(0.6, quality - 0.1);
    }
    throw new Error('Фото завелике для AI-розпізнавання. Зробіть фото меншого розміру.');
  } finally {
    if (bitmap.close) bitmap.close();
  }
}

/** Слова від сервера → елементи позиційного розбору (чиста функція; factor — масштаб координат). */
export function aiWordsToItems(words, factor = 1) {
  const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
  return (Array.isArray(words) ? words : [])
    .filter((w) => w && norm(w.text) && [w.x, w.y, w.w, w.h].every((n) => Number.isFinite(Number(n))))
    .map((w) => ({ text: String(w.text), x: Number(w.x) * f, y: Number(w.y) * f, w: Number(w.w) * f, h: Number(w.h) * f }));
}

/**
 * Фото → { items, warnings, source: 'image-ocr-ai', text, cached } через Google Cloud Vision.
 * callOcr({ image, mode }) → Promise<{ success, data?, error? }> передає App (виклик 'ocrImage' з PIN сесії).
 * isCancelled() — користувач натиснув «Скасувати»: після кожного кроку перевіряємо й не платимо за зайве.
 * Кидає Error з готовим текстом українською.
 */
export async function parseImageWithAi(file, { callOcr, onProgress = () => {}, isCancelled = () => false, mode = 'document' } = {}) {
  if (!file) throw new Error('Файл не обрано.');
  if (typeof callOcr !== 'function') throw new Error('AI-розпізнавання недоступне.');
  if (file.size > MAX_FILE_BYTES) throw new Error('Файл завеликий (понад 25 МБ).');
  if (detectKind(file) !== 'image') throw new Error('Кнопка «Зчитати з AI» працює лише з фото (JPG, PNG). PDF і Word читаються звичайним способом.');
  const cancelled = () => { const e = new Error('Скасовано.'); e.cancelled = true; return e; };

  onProgress({ label: 'Готую фото для AI…', pct: null });
  const prep = await imageToJpegForAi(file);
  if (isCancelled()) throw cancelled();

  onProgress({ label: 'AI розпізнає текст… (зазвичай кілька секунд)', pct: null });
  const res = await callOcr({ image: prep.base64, mode });
  if (isCancelled()) throw cancelled();
  if (!res || !res.success) throw new Error((res && res.error) || 'AI-розпізнавання не вдалося.');

  const data = res.data || {};
  const words = aiWordsToItems(data.words, prep.factor);
  if (words.length === 0) throw new Error('AI не знайшов тексту на фото. Спробуйте зробити фото чіткіше, рівніше й при кращому освітленні.');

  const result = positionedToItems([words], { skipOcrRepairs: true });
  if (result.items.length === 0) {
    throw new Error(`AI розпізнав текст (слів: ${words.length}), але не знайшов у ньому таблиці з виробами. Переконайтесь, що на фото видно заголовки стовпців «Найменування» і «Кількість».`);
  }
  result.warnings.unshift('Фото розпізнано за допомогою AI (Google Cloud Vision): назви й цифри можуть містити помилки — уважно перевірте.');
  return { items: result.items, warnings: result.warnings, source: 'image-ocr-ai', text: String(data.text || ''), cached: !!data.cached };
}

// Для тестів
export const __internals = { aiWordsToItems, parserScaleFor, groupIntoLines, detectHeader, roleOf, positionedToItems, ocrToItems, estimateSkew, repairRepeatedDigits, mergeDigitFragments };

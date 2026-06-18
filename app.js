const APP_VERSION = '2026-06-18-structured';

const state = {
  manifest: [],
  source: null,
  rawPayload: null,
  entries: [],
  synonymIndex: { by_word: {}, by_stem: {} },
  lastSynonyms: [],
  synonymIndexLoaded: false,
  synonymIndexLoading: false,
  payloadCache: new Map(),
  loading: false,
};

const els = {
  sourceSelect: document.getElementById('sourceSelect'),
  queryInput: document.getElementById('queryInput'),
  regexToggle: document.getElementById('regexToggle'),
  alternationToggle: document.getElementById('alternationToggle'),
  synonymToggle: document.getElementById('synonymToggle'),
  limitSelect: document.getElementById('limitSelect'),
  alphabetStrip: document.getElementById('alphabetStrip'),
  status: document.getElementById('status'),
  synonymHint: document.getElementById('synonymHint'),
  results: document.getElementById('results'),
  bookCaption: document.getElementById('bookCaption'),
  bookSource: document.getElementById('bookSource'),
};

const RUSSIAN_STEM_SUFFIXES = [
  'иями', 'ями', 'ами', 'ого', 'ему', 'ыми', 'ими', 'ться', 'тись', 'ость', 'ости', 'остью',
  'ением', 'ание', 'ания', 'ешь', 'ишь', 'ает', 'яет', 'ует', 'ают', 'яют', 'уют', 'или', 'али',
  'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ый', 'ий', 'ой', 'ую', 'юю', 'ать', 'ять', 'ить', 'еть',
  'ти', 'ся', 'ах', 'ях', 'ам', 'ям', 'ом', 'ем', 'ою', 'ею', 'ия', 'ие', 'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю'
].sort((a, b) => b.length - a.length);

const ABBREVIATIONS = [
  'межд\\.', 'частица', 'союз', 'предлог', 'мест\\.', 'числит\\.', 'нареч\\.', 'вводн\\.',
  'разг\\.', 'уст\\.', 'книжн\\.', 'поэт\\.', 'спец\\.', 'диал\\.', 'перен\\.', 'бран\\.',
  'вопр\\.', 'усилит\\.', 'выделит\\.', 'против\\.', 'сравн\\.', 'собир\\.', 'безл\\.',
  'м\\.', 'ж\\.', 'ср\\.', 'нескл\\.', 'сов\\.', 'несов\\.', 'бот\\.', 'зоол\\.', 'анат\\.',
  'мед\\.', 'ист\\.', 'лингв\\.', 'этногр\\.', 'рел\\.', 'миф\\.', 'муз\\.', 'тех\\.',
  'физ\\.', 'мат\\.', 'юр\\.', 'воен\\.', 'спорт\\.', 'шахм\\.', 'охот\\.', 'рыб\\.', 'горн\\.'
];
const ABBR_RE = new RegExp(`(^|[\\s;(—–-])(${ABBREVIATIONS.join('|')})(?=\\s|;|,|\\)|$)`, 'giu');


function setText(el, value) {
  if (el) el.textContent = value;
}

function setHtml(el, value) {
  if (el) el.innerHTML = value;
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u00ad/g, '')
    .replace(/[öӧ]/gi, 'ӧ')
    .replace(/[üÿӱ]/gi, 'ӱ')
    .replace(/[јj]/gi, 'ј')
    .replace(/[Ӧ]/g, 'ӧ')
    .replace(/[Ӱ]/g, 'ӱ')
    .replace(/[ЈJ]/g, 'ј')
    .replace(/ё/g, 'е')
    .replace(/Ё/g, 'е')
    .toLocaleLowerCase('ru-RU')
    .replace(/\s+/g, ' ')
    .trim();
}


function russianStem(value) {
  const word = normalizeText(value).replace(/[^а-яе-]/g, '');
  if (word.length <= 4) return word;
  for (const suffix of RUSSIAN_STEM_SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function debounce(fn, wait = 80) {
  let timer = null;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

// Cyrillic letters used for word boundaries (Russian + Altai-specific glyphs).
const CYRILLIC_WORD = 'а-яёА-ЯЁӧӦӱӰҥҤјЈöÖüÜÿŸ';
const ALTAI_SPECIFIC = /[ӧӦӱӰҥҤјЈöÖüÜÿŸ]/;

// A query is "Russian-like" if it is Cyrillic and uses no Altai-only glyphs.
// Morphological (stem) expansion only makes sense for such queries.
function isRussianLike(word) {
  return /[а-яё]/i.test(word) && !ALTAI_SPECIFIC.test(word);
}

// Build a regex that matches any word whose start coincides with one of the
// given stems, e.g. stem «брос» matches «бросать», «бросил», «бросается».
function wordStemRegex(stems) {
  const list = [...new Set(stems)]
    .filter(stem => stem && stem.length >= 4)
    .sort((a, b) => b.length - a.length);
  if (!list.length) return null;
  const body = list.map(escapeRegExp).join('|');
  return new RegExp(`(?:^|[^${CYRILLIC_WORD}])(?:${body})`, 'iu');
}

// Run a replacement only on text that is not already inside a <mark> span,
// so highlighting passes never nest or double-wrap each other.
function replaceOutsideMarks(html, regex, replacement) {
  return html
    .split(/(<mark>.*?<\/mark>)/g)
    .map(part => (part.startsWith('<mark>') ? part : part.replace(regex, replacement)))
    .join('');
}

function getEntryKey(entry) {
  return entry.headword || entry.term || '';
}

function getEntryKeyNorm(entry) {
  return entry.headword_normalized || entry.term_normalized || normalizeText(getEntryKey(entry));
}

function getTranslationText(entry) {
  return entry.translation_text || entry.definition_text || '';
}

function getFieldText(entry, mode) {
  if (mode === 'word') return `${entry._keyNorm} ${entry._variantsNorm}`.trim();
  if (mode === 'translation') return entry._translationNorm;
  return `${entry._keyNorm} ${entry._translationNorm} ${entry._entryNorm} ${entry._variantsNorm}`.trim();
}

function getRawFieldText(entry, mode) {
  if (mode === 'word') return `${getEntryKey(entry)} ${(entry.variants || []).join(' ')}`.trim();
  if (mode === 'translation') return getTranslationText(entry);
  return `${getEntryKey(entry)} ${entry.entry_text || ''} ${(entry.variants || []).join(' ')}`.trim();
}

function prepareEntry(entry, index) {
  const variants = Array.isArray(entry.variants) ? entry.variants : [];
  const keyNorm = normalizeText(getEntryKeyNorm(entry));
  const translation = getTranslationText(entry);
  const full = entry.entry_text || translation || '';
  return {
    ...entry,
    _index: index,
    _keyNorm: keyNorm,
    _translationNorm: normalizeText(translation),
    _entryNorm: normalizeText(full),
    _variantsNorm: variants.map(normalizeText).join(' '),
  };
}

async function fetchJson(path) {
  // В разработке важно не видеть старый manifest/app из кеша: иначе новые словари не появляются в списке.
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetch(`${path}${separator}v=${encodeURIComponent(APP_VERSION)}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Не удалось загрузить ${path}: ${response.status}`);
  return response.json();
}

async function init() {
  try {
    // Важно: не грузим synonym_index.json на старте. Он большой, и некоторые браузеры
    // подвисают на его разборе до первой загрузки словаря. Словарь должен открываться сразу.
    const manifest = await fetchJson('data/manifest.json');
    state.manifest = ensureManifestSources(Array.isArray(manifest) ? manifest : manifest.sources || []);
    renderSourceOptions();
    const primary = state.manifest.find(item => item.primary) || state.manifest[0];
    els.sourceSelect.value = primary.id;
    bindEvents();
    await loadSource(primary.id);
    performSearch();
    els.queryInput.focus({ preventScroll: true });
  } catch (error) {
    showLoadError(error);
  }
}

async function loadSynonymIndex() {
  if (state.synonymIndexLoaded || state.synonymIndexLoading) return;
  state.synonymIndexLoading = true;
  const previousStatus = els.status.textContent;
  try {
    els.status.textContent = 'Подбираем синонимы…';
    state.synonymIndex = await fetchJson('data/synonym_index.json');
    state.synonymIndexLoaded = true;
  } catch (error) {
    console.warn('Synonym index was not loaded; manual groups only.', error);
  } finally {
    state.synonymIndexLoading = false;
    if (els.status.textContent === 'Подбираем синонимы…') {
      els.status.textContent = previousStatus;
    }
  }
}

async function fetchDictionaryPayload(item) {
  if (!item?.filename) throw new Error(`У источника «${item?.title || item?.id || 'без названия'}» не указан файл данных`);
  if (state.payloadCache.has(item.id)) return state.payloadCache.get(item.id);
  const payload = await fetchJson(`data/${item.filename}`);
  state.payloadCache.set(item.id, payload);
  return payload;
}

function bindEvents() {
  const debouncedSearch = debounce(performSearch, 90);
  els.queryInput.addEventListener('input', debouncedSearch);
  els.regexToggle.addEventListener('change', performSearch);
  els.alternationToggle.addEventListener('change', performSearch);
  els.synonymToggle.addEventListener('change', async () => {
    if (els.synonymToggle.checked) await loadSynonymIndex();
    performSearch();
  });
  els.limitSelect.addEventListener('change', performSearch);
  document.querySelectorAll('input[name="mode"]').forEach(input => {
    input.addEventListener('change', performSearch);
  });
  els.sourceSelect.addEventListener('change', async () => {
    await loadSource(els.sourceSelect.value);
    performSearch();
  });
}

function ensureManifestSources(manifest) {
  const required = [
    {
      id: 'all_available',
      title: 'Все доступные словари',
      kind: 'collection',
      direction: 'mixed',
      primary: false,
      sources: [
        'altai_russian_2018',
        'russian_altai_2015_tom1_a_o',
        'russian_altai_2016_tom2_p_ya',
        'altai_ethnographic_2023',
      ],
    },
    {
      id: 'russian_altai_2016_tom2_p_ya',
      title: 'Русско-алтайский словарь, Том II П–Я, 2016',
      filename: 'russian_altai_dictionary_2016_tom2_p_ya.json',
      kind: 'bilingual',
      direction: 'ru-altai',
      primary: false,
    },
  ];

  const byId = new Map(manifest.map(item => [item.id, item]));
  for (const item of required) {
    if (!byId.has(item.id)) manifest.push(item);
  }

  const order = [
    'all_available',
    'altai_russian_2018',
    'russian_altai_2015_tom1_a_o',
    'russian_altai_2016_tom2_p_ya',
    'altai_ethnographic_2023',
  ];
  manifest.sort((a, b) => {
    const ai = order.indexOf(a.id);
    const bi = order.indexOf(b.id);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  return manifest;
}

function renderSourceOptions() {
  els.sourceSelect.innerHTML = state.manifest.map(item => {
    return `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)}</option>`;
  }).join('');
}

async function loadSource(sourceId) {
  const source = state.manifest.find(item => item.id === sourceId);
  if (!source) return;
  state.loading = true;
  state.source = source;
  setText(els.bookSource, source.title);
  els.status.textContent = `Открываем «${source.title}»…`;
  els.results.innerHTML = '<div class="empty-card"><strong>Открываем словарь…</strong>Это займёт пару секунд.</div>';
  try {
    const sourcesToLoad = source.sources
      ? source.sources.map(id => state.manifest.find(item => item.id === id)).filter(Boolean)
      : [source];
    const results = await Promise.allSettled(sourcesToLoad.map(item => fetchDictionaryPayload(item)));
    const entries = [];
    const payloads = [];
    const failed = [];

    results.forEach((result, payloadIndex) => {
      const item = sourcesToLoad[payloadIndex];
      if (result.status !== 'fulfilled') {
        failed.push(`${item.title}: ${result.reason?.message || result.reason}`);
        return;
      }
      const payload = result.value;
      payloads.push(payload);
      const sourceEntries = Array.isArray(payload) ? payload : payload.entries || [];
      sourceEntries.forEach(entry => {
        entries.push({
          ...entry,
          _sourceListTitle: item.title,
          _sourceListId: item.id,
        });
      });
    });

    if (!entries.length) {
      throw new Error(failed.length ? failed.join('; ') : `В источнике «${source.title}» нет статей`);
    }

    state.rawPayload = source.sources ? payloads : payloads[0];
    state.entries = entries.map(prepareEntry);
    state.loading = false;
    renderAlphabetStrip();
    const failedText = failed.length ? `; не удалось открыть: ${failed.length}` : '';
    els.status.textContent = `${state.entries.length.toLocaleString('ru-RU')} статей${failedText}`;
    if (failed.length) console.warn('Some sources failed to load:', failed);
  } catch (error) {
    state.loading = false;
    showLoadError(error);
  }
}

function renderAlphabetStrip() {
  const letters = [];
  const seen = new Set();
  for (const entry of state.entries) {
    const letter = String(entry.letter || Array.from(getEntryKey(entry))[0] || '').trim();
    if (!letter || seen.has(letter)) continue;
    seen.add(letter);
    letters.push(letter);
  }

  if (!els.alphabetStrip) return;
  els.alphabetStrip.innerHTML = letters.map(letter => (
    `<button class="alphabet-button" type="button" data-letter="${escapeHtml(letter)}" title="Показать статьи на ${escapeHtml(letter)}">${escapeHtml(letter)}</button>`
  )).join('');

  els.alphabetStrip.querySelectorAll('button').forEach(button => {
    button.addEventListener('click', () => {
      const letter = button.dataset.letter || '';
      document.querySelector('input[name="mode"][value="word"]').checked = true;
      els.regexToggle.checked = true;
      els.alternationToggle.checked = false;
      els.queryInput.value = `^${letter}`;
      performSearch();
      els.queryInput.focus();
    });
  });
}

function getSearchMode() {
  return document.querySelector('input[name="mode"]:checked')?.value || 'word';
}

function collectSynonyms(queryNorm) {
  if (!els.synonymToggle.checked) return [];
  const tokens = queryNorm.split(/\s+/).filter(Boolean);
  if (tokens.length !== 1) return [];

  const found = new Set();
  const byWord = state.synonymIndex?.by_word?.[queryNorm] || [];
  byWord.forEach(word => found.add(normalizeText(word)));

  if (!byWord.length) {
    const stem = russianStem(queryNorm);
    const byStem = state.synonymIndex?.by_stem?.[stem] || [];
    byStem.forEach(word => found.add(normalizeText(word)));
  }

  found.delete(queryNorm);
  return [...found].filter(Boolean).slice(0, 12);
}

// A synonym in the query (a lemma, e.g. «бросать») should match any word form
// in the text (e.g. «бросает», «бросил»), so we match on the word-initial stem.
function synonymRegexFromList(synonyms) {
  return wordStemRegex(synonyms.map(russianStem));
}

function alternationRegexFromPlain(queryNorm) {
  const vowelGroups = [
    ['а', 'е', 'о', 'ӧ'],
    ['ы', 'и'],
    ['у', 'ӱ'],
  ];
  const consonantGroups = [
    ['л', 'н', 'д', 'т'],
    ['г', 'к'],
  ];

  const groups = [...vowelGroups, ...consonantGroups];
  const parts = [];
  const chars = Array.from(queryNorm);

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (/\s/.test(ch)) {
      parts.push('\\s+');
      continue;
    }
    const group = groups.find(g => g.includes(ch));
    const isConsonantGroup = consonantGroups.some(g => g.includes(ch));
    if (group && !(isConsonantGroup && i === 0)) {
      parts.push(`[${group.map(escapeRegExp).join('')}]`);
    } else {
      parts.push(escapeRegExp(ch));
    }
  }
  return new RegExp(parts.join(''), 'iu');
}

function makeMatcher(query, mode) {
  const regexMode = els.regexToggle.checked;
  const useAlternation = els.alternationToggle.checked && !regexMode;
  const queryNorm = normalizeText(query);

  if (!queryNorm) {
    return { ok: false, error: null, test: () => false, variants: [], highlight: { literals: [], stems: [] } };
  }

  if (regexMode) {
    try {
      const rawRegex = new RegExp(query, 'iu');
      const normRegex = new RegExp(queryNorm, 'iu');
      return {
        ok: true,
        error: null,
        variants: [queryNorm],
        synonyms: [],
        highlight: { literals: [queryNorm], stems: [] },
        test(entry) {
          return rawRegex.test(getRawFieldText(entry, mode)) || normRegex.test(getFieldText(entry, mode));
        },
      };
    } catch (error) {
      return { ok: false, error: error.message, test: () => false, variants: [], highlight: { literals: [], stems: [] } };
    }
  }

  const synonyms = collectSynonyms(queryNorm);
  const synonymRegex = synonyms.length ? synonymRegexFromList(synonyms) : null;
  const altRegex = useAlternation ? alternationRegexFromPlain(queryNorm) : null;

  // Feature 1 — morphology in the main query. In translation / full-text modes
  // the Russian side carries inflected forms, so a base query like «бросать»
  // should also match «бросает», «бросил». We expand by the query's own stem,
  // but only for Russian-like words (Altai morphology is handled by
  // alternations, not Russian suffix stripping).
  const queryStem = russianStem(queryNorm);
  const useMorphology = (mode === 'translation' || mode === 'full')
    && isRussianLike(queryNorm) && queryStem.length >= 4 && queryStem !== queryNorm;
  const morphRegex = useMorphology ? wordStemRegex([queryStem]) : null;

  const highlight = buildHighlightSpec({
    queryNorm,
    synonyms,
    morphStem: useMorphology ? queryStem : null,
  });

  return {
    ok: true,
    error: null,
    variants: [queryNorm, ...synonyms],
    synonyms,
    highlight,
    test(entry) {
      const target = getFieldText(entry, mode);
      if (target.includes(queryNorm)) return true;
      if (altRegex && altRegex.test(target)) return true;
      if (morphRegex && morphRegex.test(target)) return true;
      if (synonymRegex && synonymRegex.test(target)) return true;
      return false;
    },
  };
}

// A highlight spec separates verbatim substrings from stems: literals are
// highlighted as substrings (the typed query, exact synonym forms), stems
// highlight whole inflected word forms (synonyms and morphological matches).
function buildHighlightSpec({ queryNorm, synonyms = [], morphStem = null }) {
  const literals = [queryNorm, ...synonyms];
  const stems = synonyms.map(russianStem);
  if (morphStem) stems.push(morphStem);
  return { literals, stems };
}

function scoreEntry(entry, queryNorm, mode) {
  const target = getFieldText(entry, mode);
  const key = entry._keyNorm;
  const idx = target.indexOf(queryNorm);

  let score = 100000;
  if (key === queryNorm) score -= 80000;
  else if (key.startsWith(queryNorm)) score -= 60000;
  else if (key.includes(queryNorm)) score -= 40000;
  if (mode === 'translation' && entry._translationNorm.startsWith(queryNorm)) score -= 20000;
  if (idx >= 0) score += idx;
  score += Math.min((entry.entry_text || '').length, 2000) / 20;
  score += entry._index / 100000;
  return score;
}

function performSearch() {
  if (state.loading || !state.entries.length) return;
  const query = els.queryInput.value.trim();
  const mode = getSearchMode();
  const limit = Number(els.limitSelect.value) || 100;

  if (!query) {
    const sample = state.entries.slice(0, Math.min(limit, 80));
    setText(els.bookCaption, '');
    setText(els.bookSource, state.source?.title || '');
    setSynonymHint([]);
    els.status.textContent = `${state.entries.length.toLocaleString('ru-RU')} статей · начните вводить запрос`;
    renderResults(sample, { literals: [], stems: [] }, { showFirstLetter: true });
    return;
  }

  const matcher = makeMatcher(query, mode);
  if (!matcher.ok) {
    setText(els.bookCaption, 'Ошибка поиска');
    els.status.innerHTML = `<span class="error">Ошибка регулярного выражения: ${escapeHtml(matcher.error)}</span>`;
    els.results.innerHTML = `<div class="empty-card error"><strong>Регулярное выражение не распознано</strong>Проверьте синтаксис запроса.</div>`;
    return;
  }

  const queryNorm = normalizeText(query);
  const allMatches = [];
  for (const entry of state.entries) {
    if (matcher.test(entry)) allMatches.push(entry);
  }

  allMatches.sort((a, b) => scoreEntry(a, queryNorm, mode) - scoreEntry(b, queryNorm, mode));
  const visible = allMatches.slice(0, limit);

  const modeLabel = mode === 'word' ? 'по слову' : mode === 'translation' ? 'по переводу' : 'по всей статье';
  const extra = allMatches.length > visible.length ? `, показано ${visible.length}` : '';
  setText(els.bookCaption, '');
  setText(els.bookSource, state.source?.title || '');
  setSynonymHint(matcher.synonyms || []);
  const noun = pluralizeMatches(allMatches.length);
  els.status.textContent = `${allMatches.length.toLocaleString('ru-RU')} ${noun} ${modeLabel}${extra}`;
  renderResults(visible, matcher.highlight);
}

function pluralizeMatches(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'совпадение';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'совпадения';
  return 'совпадений';
}

function setSynonymHint(synonyms) {
  if (!els.synonymHint) return;
  if (!synonyms || !synonyms.length) {
    els.synonymHint.innerHTML = '';
    els.synonymHint.hidden = true;
    return;
  }
  const chips = synonyms
    .map(word => `<button type="button" class="syn-chip" data-word="${escapeHtml(word)}">${escapeHtml(word)}</button>`)
    .join('');
  els.synonymHint.innerHTML = `<span class="syn-hint__label">Также по синонимам</span>${chips}`;
  els.synonymHint.hidden = false;
  els.synonymHint.querySelectorAll('.syn-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      els.queryInput.value = btn.dataset.word || '';
      performSearch();
      els.queryInput.focus();
    });
  });
}

// Feature 2 — highlight matches. Literals are highlighted as substrings (the
// typed query and verbatim synonym forms); stems highlight whole inflected
// word forms (so synonym «бросать» also lights up «бросает» in the text).
function highlightEscapedHtml(escapedHtml, highlight = {}) {
  const literals = [...new Set((highlight.literals || []).map(v => String(v || '').trim()))]
    .filter(v => v.length >= 2 && !/[.*+?^${}()|[\]\\]/.test(v))
    .sort((a, b) => b.length - a.length)
    .slice(0, 16);
  const stems = [...new Set((highlight.stems || []).map(v => String(v || '').trim()))]
    .filter(v => v.length >= 4)
    .sort((a, b) => b.length - a.length)
    .slice(0, 16);
  if (!literals.length && !stems.length) return escapedHtml;

  let html = escapedHtml;
  if (stems.length) {
    const stemRe = new RegExp(
      `(^|[^${CYRILLIC_WORD}])((?:${stems.map(escapeRegExp).join('|')})[${CYRILLIC_WORD}]*)`,
      'giu',
    );
    html = html.replace(stemRe, '$1<mark>$2</mark>');
  }
  if (literals.length) {
    const litRe = new RegExp(`(${literals.map(escapeRegExp).join('|')})`, 'giu');
    html = replaceOutsideMarks(html, litRe, '<mark>$1</mark>');
  }
  return html;
}

function removeEntryLead(entry, text) {
  const raw = String(entry.headword_raw || entry.term || entry.headword || '').trim();
  const key = String(getEntryKey(entry) || '').trim();
  let body = String(text || '').trim();

  const candidates = [raw, key].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    if (body.startsWith(candidate)) {
      body = body.slice(candidate.length).trimStart();
      break;
    }
  }
  if (body.startsWith('–') || body.startsWith('-')) body = body.slice(1).trimStart();
  return body;
}

// Feature 4 — split a stitched article into structure. Altai dictionary entries
// use two levels of numbering: «1.» / «2.» mark grammatical or homonym blocks,
// «1)» / «2)» mark individual senses; «♦» introduces phraseology; «см.» / «ср.»
// are cross-references. Parsing is conservative — anything ambiguous falls back
// to a single plain block, so an entry is never garbled.
const SENSE_RE = /(?:^|[;\s])(\d{1,2})\)\s/;
const BLOCK_RE = /(?:^|[;\s])(\d{1,2})\.\s/;

function splitByMarker(text, makeRe) {
  // Split text on numbered markers, keeping only sequences that actually start
  // at 1 and stay consecutive (guards against stray numbers like dates).
  // Returns { lead, parts } where lead is the text before the first marker.
  const re = new RegExp(makeRe.source, 'g');
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    marks.push({ num: Number(m[1]), at: m.index + m[0].length, start: m.index });
  }
  if (marks.length < 2 || marks[0].num !== 1) return null;
  for (let i = 0; i < marks.length; i += 1) {
    if (marks[i].num !== i + 1) return null;
  }
  const parts = marks.map((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    return { num: mark.num, text: text.slice(mark.at, end).trim() };
  });
  return { lead: text.slice(0, marks[0].start).trim(), parts };
}

function parseArticle(entry) {
  const fullText = entry.entry_text || getTranslationText(entry) || '';
  let body = removeEntryLead(entry, fullText);

  let phrases = [];
  const diamond = body.indexOf('♦');
  if (diamond !== -1) {
    phrases = body
      .slice(diamond)
      .split('♦')
      .map(part => part.trim())
      .filter(Boolean);
    body = body.slice(0, diamond).trim();
  }

  const blockSplit = splitByMarker(body, BLOCK_RE);
  const rawBlocks = blockSplit ? blockSplit.parts : [{ num: null, text: body }];
  const blocks = rawBlocks.map(block => {
    const senseSplit = splitByMarker(block.text, SENSE_RE);
    if (senseSplit) {
      return { num: block.num, label: senseSplit.lead, senses: senseSplit.parts };
    }
    return { num: block.num, label: '', senses: [{ num: null, text: block.text }] };
  });

  return { blocks, phrases };
}

// Inline typographic decoration applied to already-escaped sense text.
function decorateSenseText(text, highlight) {
  let html = escapeHtml(text);
  html = highlightEscapedHtml(html, highlight);
  html = html.replace(/(^|[\s;(])(см\.|ср\.)(?=\s)/giu, '$1<span class="dict-see">$2</span>');
  html = html.replace(ABBR_RE, '$1<span class="dict-abbr">$2</span>');
  return html;
}

function renderArticleBody(article, highlight) {
  const multiBlock = article.blocks.length > 1;
  const blockHtml = article.blocks.map(block => {
    const senseChunks = block.senses.map(sense => {
      const num = sense.num
        ? `<span class="dict-number">${sense.num})</span> `
        : '';
      return `<span class="dict-sense">${num}${decorateSenseText(sense.text, highlight)}</span>`;
    });
    const blockNum = block.num
      ? `<span class="dict-block-num">${block.num}.</span> `
      : '';
    const labelHtml = block.label
      ? `<span class="dict-block-label">${decorateSenseText(block.label, highlight)}</span> `
      : '';
    const multiSense = block.senses.length > 1 ? ' dict-senses--multi' : '';
    const blockClass = multiBlock ? ' dict-block' : '';
    return `<span class="dict-senses${multiSense}${blockClass}">${blockNum}${labelHtml}${senseChunks.join('')}</span>`;
  });

  let html = blockHtml.join('');

  if (article.phrases.length) {
    const items = article.phrases
      .map(phrase => `<span class="dict-phrase">${decorateSenseText(phrase, highlight)}</span>`)
      .join('');
    html += `<span class="dict-phraseology"><span class="dict-diamond">♦</span>${items}</span>`;
  }
  return html;
}

function renderResults(entries, highlight, options = {}) {
  if (!entries.length) {
    els.results.innerHTML = `<div class="empty-card"><strong>Ничего не найдено</strong>Попробуйте другой режим поиска или включите поиск по всей статье.</div>`;
    return;
  }

  let currentLetter = null;
  const chunks = [];

  for (const entry of entries) {
    const letter = String(entry.letter || Array.from(getEntryKey(entry))[0] || '').trim();
    if (options.showFirstLetter && letter && letter !== currentLetter) {
      currentLetter = letter;
      chunks.push(`<div class="dict-section-letter">${escapeHtml(letter)}</div>`);
    }
    chunks.push(renderEntry(entry, highlight));
  }

  els.results.innerHTML = `<div class="dictionary-flow">${chunks.join('')}</div>`;
}

function renderEntry(entry, highlight) {
  const title = entry.headword_raw || entry.term || entry.headword || 'Без заголовка';
  const homonym = entry.homonym ? ` <span class="dict-homonym">${escapeHtml(entry.homonym)}</span>` : '';
  const titleClean = entry.homonym && title.endsWith(entry.homonym)
    ? title.slice(0, title.length - entry.homonym.length).trim()
    : title;
  const page = entry.page_start
    ? `с. ${entry.page_start}${entry.page_end && entry.page_end !== entry.page_start ? `–${entry.page_end}` : ''}`
    : '';
  const sourceTag = state.source?.sources ? (entry._sourceListTitle || entry.source_title || '') : '';

  const titleHtml = highlightEscapedHtml(escapeHtml(titleClean), highlight) + homonym;
  const article = parseArticle(entry);
  const bodyHtml = renderArticleBody(article, highlight);

  return `
    <article class="dictionary-entry">
      <p class="dictionary-entry__text">
        <span class="dict-headword">${titleHtml}</span>${bodyHtml ? ' ' : ''}<span class="dict-body">${bodyHtml}</span>${page ? `<span class="dict-page">${escapeHtml(page)}</span>` : ''}${sourceTag ? `<span class="dict-source-tag">${escapeHtml(sourceTag)}</span>` : ''}
      </p>
    </article>
  `;
}

function showLoadError(error) {
  console.error(error);
  setText(els.bookCaption, '');
  els.status.innerHTML = `<span class="error">Не удалось открыть словарь</span>`;
  els.results.innerHTML = `
    <div class="empty-card error">
      <strong>Словарь не загрузился</strong>
      <p>Попробуйте обновить страницу.</p>
    </div>
  `;
}

init();

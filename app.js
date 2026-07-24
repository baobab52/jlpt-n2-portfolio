(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const LOCAL_KEY = 'jlpt-gas-ui-v1';
  const TTS_LOCAL_KEY = 'jlpt-gas-tts-v1';
  const STATE_KEY = 'jlpt-static-state-v1';

  // 기기 TTS가 특정 단어를 학습자에게 불명확하게 들려주는 경우를 보정합니다.
  // natural: 자연 낭독, clear: 모라 단위 또렷한 낭독, repeat: 마지막 반복 낭독
  const JAPANESE_TTS_OVERRIDES = Object.freeze({
    '補う': Object.freeze({
      natural: '補う',
      clear: 'お、ぎ、な、う',
      repeat: 'おぎなう',
      example: '不足している人員を補う。'
    })
  });

  let DATA = null;
  let WORDS = [];
  let GRAMMAR = [];
  let WORD_MAP = new Map();
  let GRAMMAR_MAP = new Map();
  let progress = new Map();
  let mistakes = new Map();
  let currentView = 'home';
  let studyWeek = 1;
  let studyMode = 'words';
  let studyIndex = 0;
  let studyOrder = [];
  let mistakeFilter = 'all';
  let quiz = null;
  let pendingRatings = new Map();
  let flushTimer = null;
  let speechVoices = [];
  let speechRunToken = 0;
  let speechTimer = null;
  let activeUtterance = null;
  let speechRunning = false;
  const ttsState = loadTtsLocal();
  let statusSheetCloseTimer = null;
  const uiState = loadLocal();

  function loadStaticState() {
    try {
      const state = JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
      return {
        progress: Array.isArray(state.progress) ? state.progress : [],
        mistakes: Array.isArray(state.mistakes) ? state.mistakes : [],
        quiz: state.quiz && typeof state.quiz === 'object'
          ? { total: Number(state.quiz.total || 0), correct: Number(state.quiz.correct || 0) }
          : { total: 0, correct: 0 }
      };
    } catch (error) {
      return { progress: [], mistakes: [], quiz: { total: 0, correct: 0 } };
    }
  }

  function persistStaticState() {
    const state = {
      progress: [...progress.values()],
      mistakes: [...mistakes.values()],
      quiz: DATA?.quiz || { total: 0, correct: 0 }
    };
    safeSetLocalStorage(STATE_KEY, JSON.stringify(state));
    return state;
  }

  function getStaticAppData() {
    if (!window.JLPT_STATIC_DATA) {
      throw new Error('data.js의 학습 데이터를 찾지 못했습니다.');
    }
    const base = JSON.parse(JSON.stringify(window.JLPT_STATIC_DATA));
    const state = loadStaticState();
    base.progress = state.progress;
    base.mistakes = state.mistakes;
    base.quiz = state.quiz;
    return base;
  }

  function server(name, ...args) {
    return Promise.resolve().then(() => {
      switch (name) {
        case 'getAppData':
          return getStaticAppData();
        case 'saveRatingsBatch':
        case 'recordQuizAnswer':
        case 'resolveMistake':
        case 'clearMistakes':
        case 'resetProgress':
          persistStaticState();
          return { ok: true, saved: Array.isArray(args[0]) ? args[0].length : 1 };
        default:
          throw new Error(`지원하지 않는 로컬 작업입니다: ${name}`);
      }
    });
  }

  function loadLocal() {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}'); }
    catch (error) { return {}; }
  }

  function loadTtsLocal() {
    try { return JSON.parse(localStorage.getItem(TTS_LOCAL_KEY) || '{}'); }
    catch (error) { return {}; }
  }

  function safeSetLocalStorage(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      setSync('저장 제한');
      return false;
    }
  }

  function saveTtsLocal() {
    safeSetLocalStorage(TTS_LOCAL_KEY, JSON.stringify({
      jaVoice: $('#jaVoiceSelect')?.value || '',
      koVoice: $('#koVoiceSelect')?.value || ''
    }));
  }

  function saveLocal() {
    safeSetLocalStorage(LOCAL_KEY, JSON.stringify({ week: studyWeek, index: studyIndex, mode: studyMode }));
  }

  function toast(message) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('show');
    window.setTimeout(() => element.classList.remove('show'), 1700);
  }

  function setSync(text) {
    const element = $('#syncState');
    if (element) element.textContent = text;
  }

  function weekData(week = studyWeek) { return DATA.weeks[week - 1]; }

  function shuffle(array) {
    const result = [...array];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [result[index], result[randomIndex]] = [result[randomIndex], result[index]];
    }
    return result;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character]);
  }

  function katakanaToHiragana(value) {
    return String(value || '').replace(/[\u30A1-\u30F6]/g, character =>
      String.fromCharCode(character.charCodeAt(0) - 0x60)
    );
  }

  function isKanjiCharacter(character) {
    return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF々〆ヵヶ]/.test(character);
  }

  function isKanaCharacter(character) {
    return /[\u3040-\u309F\u30A0-\u30FFー]/.test(character);
  }

  function buildOkuriganaRubyHtml(surfaceValue, readingValue) {
    const surface = String(surfaceValue || '');
    const reading = String(readingValue || '');

    if (!surface) return '';
    if (!reading || ![...surface].some(isKanjiCharacter)) {
      return escapeHtml(surface);
    }

    const surfaceCharacters = [...surface];
    const runs = [];

    surfaceCharacters.forEach(character => {
      const type = isKanjiCharacter(character)
        ? 'kanji'
        : (isKanaCharacter(character) ? 'kana' : 'other');

      const previous = runs[runs.length - 1];
      if (previous && previous.type === type) {
        previous.text += character;
      } else {
        runs.push({ type, text: character });
      }
    });

    const normalizedReading = katakanaToHiragana(reading);
    let readingCursor = 0;
    let html = '';

    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index];

      if (run.type !== 'kanji') {
        html += escapeHtml(run.text);

        const normalizedRun = katakanaToHiragana(run.text);
        if (normalizedReading.startsWith(normalizedRun, readingCursor)) {
          readingCursor += normalizedRun.length;
        }
        continue;
      }

      let rubyReading = '';
      const nextFixedRun = runs
        .slice(index + 1)
        .find(candidate => candidate.type !== 'kanji' && candidate.text);

      if (nextFixedRun) {
        const normalizedFixed = katakanaToHiragana(nextFixedRun.text);
        const fixedPosition = normalizedReading.indexOf(normalizedFixed, readingCursor);

        if (fixedPosition >= readingCursor) {
          rubyReading = reading.slice(readingCursor, fixedPosition);
          readingCursor = fixedPosition;
        }
      } else {
        rubyReading = reading.slice(readingCursor);
        readingCursor = reading.length;
      }

      if (!rubyReading) {
        return `<ruby>${escapeHtml(surface)}<rt>${escapeHtml(reading)}</rt></ruby>`;
      }

      html += `<ruby>${escapeHtml(run.text)}<rt>${escapeHtml(rubyReading)}</rt></ruby>`;
    }

    return html;
  }

  function normalizeRubyOkuriganaHtml(value) {
    return String(value || '').replace(
      /<ruby>([^<]*)<rt>([^<]*)<\/rt><\/ruby>/gi,
      (_, surface, reading) => buildOkuriganaRubyHtml(surface, reading)
    );
  }

  function sanitizeRubyHtml(value, fallback = '') {
    const raw = String(value || '').trim();
    if (!raw) return escapeHtml(fallback);

    const sanitized = raw
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<(?!\/?(?:ruby|rt|rp|br)\b)[^>]*>/gi, '')
      .replace(/<\s*(ruby|rt|rp)\b[^>]*>/gi, '<$1>')
      .replace(/<\s*\/\s*(ruby|rt|rp)\s*>/gi, '</$1>');

    return normalizeRubyOkuriganaHtml(sanitized);
  }

  function wordRubyHtml(word) {
    return buildOkuriganaRubyHtml(word.word, word.reading);
  }

  function getExamCountdown() {
    const now = new Date();
    const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const examUtc = Date.UTC(2026, 11, 6);
    const difference = Math.ceil((examUtc - todayUtc) / 86400000);
    if (difference > 0) return { shortLabel: `D-${difference}`, topLabel: `시험 D-${difference}`, state: 'before' };
    if (difference === 0) return { shortLabel: 'D-DAY', topLabel: '시험 D-DAY', state: 'today' };
    return { shortLabel: '시험 종료', topLabel: '시험 종료', state: 'after' };
  }

  function renderExamCountdown() {
    const countdown = getExamCountdown();
    const home = $('#dDay');
    if (home) home.textContent = countdown.shortLabel;
    const badge = $('#topExamDday');
    if (!badge) return;
    badge.textContent = countdown.topLabel;
    badge.classList.toggle('today', countdown.state === 'today');
    badge.classList.toggle('ended', countdown.state === 'after');
  }

  async function init() {
    try {
      DATA = await server('getAppData');
      WORDS = DATA.weeks.flatMap(week => week.words);
      GRAMMAR = DATA.weeks.flatMap(week => week.grammar);
      WORD_MAP = new Map(WORDS.map(word => [word.id, word]));
      GRAMMAR_MAP = new Map(GRAMMAR.map(item => [item.id, item]));
      progress = new Map(DATA.progress.map(item => [`${item.type}|${item.id}`, item]));
      mistakes = new Map(DATA.mistakes.map(item => [item.wordId, item]));
      studyWeek = Math.min(16, Math.max(1, Number(uiState.week || 1)));
      studyMode = uiState.mode === 'grammar' ? 'grammar' : 'words';
      studyIndex = Number(uiState.index || 0);
      populateSelects();
      bindEvents();
      buildStudyOrder();
      renderAll();
      initSpeechVoices();
      $('#loading').classList.add('hidden');
      $('#app').classList.remove('hidden');
    } catch (error) {
      $('#loading').innerHTML = `<div class="error-box"><h2>앱을 열지 못했습니다.</h2><p>${escapeHtml(error.message)}</p><p>index.html, data.js, app.js가 같은 폴더에 있는지 확인해 주세요.</p></div>`;
    }
  }

  function populateSelects() {
    const studySelect = $('#studyWeek');
    const quizWeekSelect = $('#quizWeek');
    for (let week = 1; week <= 16; week += 1) {
      studySelect.insertAdjacentHTML('beforeend', `<option value="${week}">${week}주차</option>`);
      quizWeekSelect.insertAdjacentHTML('beforeend', `<option value="${week}">${week}주차</option>`);
    }
    studySelect.value = String(studyWeek);
  }


  function enableMouseDragScroll(container) {
    if (!container || container.dataset.mouseDragReady === 'true') return;

    container.dataset.mouseDragReady = 'true';

    let activePointerId = null;
    let startX = 0;
    let startScrollLeft = 0;
    let moved = false;
    let suppressNextClick = false;

    const finishDrag = event => {
      if (activePointerId === null) return;
      if (event?.pointerId !== undefined && event.pointerId !== activePointerId) return;

      if (moved) suppressNextClick = true;

      try {
        if (container.hasPointerCapture?.(activePointerId)) {
          container.releasePointerCapture(activePointerId);
        }
      } catch (error) {
        // 이미 포인터 캡처가 해제된 경우에는 무시합니다.
      }

      activePointerId = null;
      moved = false;
      container.classList.remove('is-dragging');
    };

    container.addEventListener('pointerdown', event => {
      // 터치 스와이프는 브라우저의 기본 동작을 그대로 사용합니다.
      // PC 마우스의 왼쪽 버튼만 직접 드래그 스크롤로 처리합니다.
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      if (container.scrollWidth <= container.clientWidth) return;

      activePointerId = event.pointerId;
      startX = event.clientX;
      startScrollLeft = container.scrollLeft;
      moved = false;

      container.classList.add('is-dragging');
      container.setPointerCapture?.(activePointerId);
    });

    container.addEventListener('pointermove', event => {
      if (activePointerId === null || event.pointerId !== activePointerId) return;

      const distance = event.clientX - startX;

      // 작은 움직임은 카드 클릭으로 취급합니다.
      if (!moved && Math.abs(distance) < 6) return;

      moved = true;
      event.preventDefault();
      container.scrollLeft = startScrollLeft - distance;
    });

    container.addEventListener('pointerup', finishDrag);
    container.addEventListener('pointercancel', finishDrag);
    container.addEventListener('lostpointercapture', finishDrag);

    container.addEventListener('click', event => {
      if (!suppressNextClick) return;

      // 드래그를 끝낸 직후 카드가 클릭되어 학습 화면으로 이동하는 것을 막습니다.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      suppressNextClick = false;
    }, true);

    container.addEventListener('dragstart', event => {
      event.preventDefault();
    });
  }

  function bindEvents() {
    enableMouseDragScroll($('#todayReview'));
    $$('.nav-item').forEach(button => button.addEventListener('click', () => go(button.dataset.view)));
    $$('[data-go]').forEach(button => button.addEventListener('click', () => go(button.dataset.go)));
    $$('[data-status-list]').forEach(button => button.addEventListener('click', () => openStatusSheet(button.dataset.statusList)));
    $('#closeStatusSheet').addEventListener('click', () => closeStatusSheet());
    $('#statusSheetBackdrop').addEventListener('click', () => closeStatusSheet());
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !$('#statusSheetLayer').classList.contains('hidden')) closeStatusSheet();
    });
    $('#continueBtn').addEventListener('click', () => go('study'));
    $('#studyWeek').addEventListener('change', event => {
      studyWeek = Number(event.target.value);
      studyIndex = 0;
      buildStudyOrder();
      stopSpeech(false);
      renderStudy();
      saveLocal();
    });
    $$('[data-study-mode]').forEach(button => button.addEventListener('click', () => {
      stopSpeech(false);
      studyMode = button.dataset.studyMode;
      studyIndex = 0;
      updateStudyModeButtons();
      buildStudyOrder();
      renderStudy();
      saveLocal();
    }));
    $('#revealBtn').addEventListener('click', revealWord);
    $('#grammarRevealBtn').addEventListener('click', () => $('#grammarAnswer').classList.remove('hidden'));
    $$('[data-rate]').forEach(button => button.addEventListener('click', () => rateWord(button.dataset.rate)));
    $$('[data-grammar-rate]').forEach(button => button.addEventListener('click', () => rateGrammar(button.dataset.grammarRate)));
    $('#prevCard').addEventListener('click', () => moveCard(-1));
    $('#nextCard').addEventListener('click', () => moveCard(1));
    $('#shuffleBtn').addEventListener('click', () => {
      stopSpeech(false);
      if (studyMode === 'words') studyOrder = shuffle(studyOrder);
      studyIndex = 0;
      renderStudy();
      toast(studyMode === 'words' ? '단어 순서를 섞었습니다.' : '문법은 주차 순서로 표시됩니다.');
    });
    $('#speakCurrent').addEventListener('click', startCurrentSpeech);
    $('#speakWeek').addEventListener('click', startWeekSpeech);
    $('#stopSpeech').addEventListener('click', () => stopSpeech(true));
    $('#jaVoiceSelect').addEventListener('change', () => { saveTtsLocal(); stopSpeech(false); updateSpeechIdleStatus(); });
    $('#koVoiceSelect').addEventListener('change', () => { saveTtsLocal(); stopSpeech(false); updateSpeechIdleStatus(); });
    $('#startQuiz').addEventListener('click', startQuiz);
    $('#nextQuiz').addEventListener('click', nextQuiz);
    $('#clearMistakes').addEventListener('click', clearMistakes);
    $('#resetBtn').addEventListener('click', resetAll);
    $$('[data-mistake-filter]').forEach(button => button.addEventListener('click', () => {
      mistakeFilter = button.dataset.mistakeFilter;
      $$('[data-mistake-filter]').forEach(item => item.classList.toggle('active', item === button));
      renderMistakes();
    }));
    window.addEventListener('beforeunload', () => { stopSpeech(false); flushRatings(); });
  }

  function go(view) {
    if (view !== 'study') stopSpeech(false);
    currentView = view;
    $$('.view').forEach(element => element.classList.toggle('active', element.id === `view-${view}`));
    $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === view));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (view === 'home') renderHome();
    if (view === 'study') { renderStudy(); updateSpeechIdleStatus(); }
    if (view === 'mistakes') renderMistakes();
  }

  function updateStudyModeButtons() {
    $$('[data-study-mode]').forEach(button => button.classList.toggle('active', button.dataset.studyMode === studyMode));
  }

  function renderAll() {
    renderExamCountdown();
    renderHome();
    renderStudy();
    renderMistakes();
    updateStudyModeButtons();
  }

  function statusCount(type, status) {
    return [...progress.values()].filter(item => item.type === type && item.status === status).length;
  }

  function renderHome() {
    renderExamCountdown();
    const knownWords = statusCount('word', 'known');
    const knownGrammar = statusCount('grammar', 'known');
    const confusedWords = [...progress.values()].filter(item => item.type === 'word' && (item.status === 'confused' || item.status === 'unknown')).length;
    const confusedGrammar = [...progress.values()].filter(item => item.type === 'grammar' && (item.status === 'confused' || item.status === 'unknown')).length;
    const unresolved = [...mistakes.values()].filter(item => !item.resolved);
    const total = DATA.quiz.total;
    const correct = DATA.quiz.correct;

    $('#knownCount').textContent = knownWords + knownGrammar;
    $('#knownWordCount').textContent = knownWords;
    $('#knownGrammarCount').textContent = knownGrammar;
    $('#confusedCount').textContent = confusedWords + confusedGrammar;
    $('#confusedWordCount').textContent = confusedWords;
    $('#confusedGrammarCount').textContent = confusedGrammar;
    $('#mistakeCount').textContent = unresolved.length;
    $('#accuracy').textContent = total ? `${Math.round(correct / total * 100)}%` : '-';
    $('#quizTotal').textContent = `${total}문제`;

    $('#weekGrid').innerHTML = DATA.weeks.map(week => {
      const wordRated = week.words.filter(word => progress.has(`word|${word.id}`)).length;
      const wordDone = week.words.filter(word => progress.get(`word|${word.id}`)?.status === 'known').length;
      const grammarRated = week.grammar.filter(item => progress.has(`grammar|${item.id}`)).length;
      const grammarDone = week.grammar.filter(item => progress.get(`grammar|${item.id}`)?.status === 'known').length;
      const percent = Math.round((wordDone + grammarDone) / (week.words.length + week.grammar.length) * 100);
      const hasNarration = speechSupported();
      return `<button class="week-tile" data-week="${week.week}" type="button"><strong>${week.week}주차 ${hasNarration ? '🔊' : ''}</strong><small>단어 ${wordDone}/${week.words.length} · 문법 ${grammarDone}/${week.grammar.length}</small><small class="week-rated">학습 기록 ${wordRated + grammarRated}개</small><div class="bar"><i style="width:${percent}%"></i></div></button>`;
    }).join('');
    $$('.week-tile').forEach(button => button.addEventListener('click', () => {
      studyWeek = Number(button.dataset.week);
      studyIndex = 0;
      $('#studyWeek').value = String(studyWeek);
      buildStudyOrder();
      go('study');
      saveLocal();
    }));

    const wordReview = WORDS.filter(word => {
      const status = progress.get(`word|${word.id}`)?.status;
      return status === 'confused' || status === 'unknown' || (!status && word.priority === 'A');
    }).slice(0, 8).map(word => ({ kind: 'word', id: word.id, week: word.week, html: wordRubyHtml(word), sub: word.meaning }));

    const grammarReview = GRAMMAR.filter(item => {
      const status = progress.get(`grammar|${item.id}`)?.status;
      return status === 'confused' || status === 'unknown';
    }).slice(0, 4).map(item => ({ kind: 'grammar', id: item.id, week: item.week, html: sanitizeRubyHtml(item.patternRuby, item.pattern), sub: item.meaning }));

    const reviewItems = [...grammarReview, ...wordReview].slice(0, 10);
    $('#todayReview').innerHTML = reviewItems.length
      ? reviewItems.map(item => `<button class="review-chip ${item.kind}" data-review-kind="${item.kind}" data-review-id="${escapeHtml(item.id)}" type="button"><span class="review-type">${item.kind === 'grammar' ? '문법' : `${item.week}주차`}</span><strong>${item.html}</strong><small>${escapeHtml(item.sub)}</small></button>`).join('')
      : '<div class="empty compact">현재 복습할 단어·문법이 없습니다.</div>';
    $$('[data-review-id]').forEach(button => button.addEventListener('click', () => {
      if (button.dataset.reviewKind === 'grammar') openGrammar(button.dataset.reviewId);
      else openWord(button.dataset.reviewId);
    }));
  }

  function openWord(id) {
    const word = WORD_MAP.get(id);
    if (!word) return;
    closeStatusSheet(true);
    studyWeek = word.week;
    studyMode = 'words';
    $('#studyWeek').value = String(studyWeek);
    updateStudyModeButtons();
    buildStudyOrder();
    studyIndex = Math.max(0, studyOrder.findIndex(item => item.id === id));
    go('study');
    saveLocal();
  }

  function openGrammar(id) {
    const item = GRAMMAR_MAP.get(id);
    if (!item) return;
    closeStatusSheet(true);
    studyWeek = item.week;
    studyMode = 'grammar';
    $('#studyWeek').value = String(studyWeek);
    updateStudyModeButtons();
    studyIndex = Math.max(0, weekData().grammar.findIndex(grammarItem => grammarItem.id === id));
    go('study');
    saveLocal();
  }

  function buildStudyOrder() {
    studyOrder = [...weekData().words];
    const length = studyMode === 'words' ? studyOrder.length : weekData().grammar.length;
    studyIndex = Math.min(studyIndex, Math.max(0, length - 1));
  }

  function renderStudy() {
    $('#studyWeek').value = String(studyWeek);
    updateStudyModeButtons();
    const isWordMode = studyMode === 'words';
    $('#wordCard').classList.toggle('hidden', !isWordMode);
    $('#grammarCard').classList.toggle('hidden', isWordMode);
    const items = isWordMode ? studyOrder : weekData().grammar;
    studyIndex = Math.min(studyIndex, Math.max(0, items.length - 1));
    $('#studyCounter').textContent = `${studyIndex + 1} / ${items.length}`;
    $('#studyProgress').style.width = `${(studyIndex + 1) / items.length * 100}%`;
    $('#audioTitle').textContent = `${studyWeek}주차 ${isWordMode ? '단어' : '문법'} · 예문 포함 낭독`;
    if (!speechRunning) updateSpeechIdleStatus();

    if (isWordMode) {
      const item = studyOrder[studyIndex];
      if (!item) return;
      $('#priorityBadge').textContent = item.priority;
      $('#cardWord').innerHTML = wordRubyHtml(item);
      $('#cardReading').textContent = item.reading;
      $('#cardMeaning').textContent = item.meaning;
      $('#cardExample').innerHTML = sanitizeRubyHtml(item.exampleRuby, item.example);
      $('#cardTranslation').textContent = item.translation || '';
      $('#cardTranslation').classList.toggle('hidden', !item.translation);
      $('#cardAnswer').classList.add('hidden');
    } else {
      const item = weekData().grammar[studyIndex];
      if (!item) return;
      $('#grammarPattern').innerHTML = sanitizeRubyHtml(item.patternRuby, item.pattern);
      $('#grammarMeaning').textContent = item.meaning;
      $('#grammarExample').innerHTML = sanitizeRubyHtml(item.exampleRuby, item.example);
      $('#grammarTranslation').textContent = item.translation || '';
      $('#grammarTranslation').classList.toggle('hidden', !item.translation);
      $('#grammarAnswer').classList.add('hidden');
    }
  }

  function revealWord() { $('#cardAnswer').classList.remove('hidden'); }

  function moveCard(delta) {
    stopSpeech(false);
    const length = studyMode === 'words' ? studyOrder.length : weekData().grammar.length;
    studyIndex = (studyIndex + delta + length) % length;
    renderStudy();
    saveLocal();
  }

  function rateWord(status) {
    const item = studyOrder[studyIndex];
    queueRating({ type: 'word', id: item.id, week: item.week, status });
    progress.set(`word|${item.id}`, { type: 'word', id: item.id, week: item.week, status });
    if (status !== 'known') {
      const previous = mistakes.get(item.id) || { wordId: item.id, week: item.week, word: item.word, reading: item.reading, meaning: item.meaning, readingWrong: 0, meaningWrong: 0, confused: 0, resolved: false };
      previous.confused += 1;
      previous.resolved = false;
      mistakes.set(item.id, previous);
    }
    moveCard(1);
    renderHome();
  }

  function rateGrammar(status) {
    const item = weekData().grammar[studyIndex];
    queueRating({ type: 'grammar', id: item.id, week: item.week, status });
    progress.set(`grammar|${item.id}`, { type: 'grammar', id: item.id, week: item.week, status });
    moveCard(1);
    renderHome();
  }

  function queueRating(record) {
    pendingRatings.set(`${record.type}|${record.id}`, record);
    setSync('저장 대기');
    clearTimeout(flushTimer);
    flushTimer = window.setTimeout(flushRatings, 700);
  }

  async function flushRatings() {
    if (!pendingRatings.size) return;
    const records = [...pendingRatings.values()];
    pendingRatings.clear();
    setSync('저장 중');
    try {
      await server('saveRatingsBatch', records);
      setSync('기기 저장');
    } catch (error) {
      records.forEach(record => pendingRatings.set(`${record.type}|${record.id}`, record));
      setSync('저장 실패');
      toast(error.message);
    }
  }


  function speechSupported() {
    return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  }

  function initSpeechVoices() {
    const badge = $('#ttsSupportBadge');
    if (!speechSupported()) {
      badge.textContent = '지원 안 됨';
      badge.classList.add('error');
      $('#audioStatus').textContent = '이 브라우저에서는 기기 음성 낭독을 사용할 수 없습니다.';
      setSpeechButtonsDisabled(true);
      return;
    }

    badge.textContent = '무료 · 기기 음성';
    badge.classList.remove('error');
    refreshSpeechVoices();
    if (typeof speechSynthesis.addEventListener === 'function') {
      speechSynthesis.addEventListener('voiceschanged', refreshSpeechVoices);
    } else {
      speechSynthesis.onvoiceschanged = refreshSpeechVoices;
    }
    window.setTimeout(refreshSpeechVoices, 250);
    window.setTimeout(refreshSpeechVoices, 1000);
  }

  function refreshSpeechVoices() {
    if (!speechSupported()) return;
    const voices = speechSynthesis.getVoices() || [];
    if (voices.length) speechVoices = voices;
    populateVoiceSelect('#jaVoiceSelect', 'ja', ttsState.jaVoice, '기기 기본 일본어 음성');
    populateVoiceSelect('#koVoiceSelect', 'ko', ttsState.koVoice, '기기 기본 한국어 음성');
    setSpeechButtonsDisabled(false);
    updateSpeechIdleStatus();
  }

  function populateVoiceSelect(selector, languagePrefix, savedName, fallbackLabel) {
    const select = $(selector);
    if (!select) return;
    const previousValue = select.value || savedName || '';
    const matches = speechVoices.filter(voice => String(voice.lang || '').toLowerCase().startsWith(languagePrefix));
    const options = [`<option value="">${escapeHtml(fallbackLabel)}</option>`];
    matches.forEach(voice => {
      const detail = [voice.name, voice.lang, voice.localService ? '기기 내장' : '온라인'].filter(Boolean).join(' · ');
      options.push(`<option value="${escapeHtml(voice.name)}">${escapeHtml(detail)}</option>`);
    });
    select.innerHTML = options.join('');
    if ([...select.options].some(option => option.value === previousValue)) select.value = previousValue;
    else if (matches.length) select.value = matches.find(voice => voice.default)?.name || matches[0].name;
  }

  function setSpeechButtonsDisabled(disabled) {
    $('#speakCurrent').disabled = disabled;
    $('#speakWeek').disabled = disabled;
    if (disabled) $('#stopSpeech').disabled = true;
  }

  function updateSpeechIdleStatus() {
    if (speechRunning) return;
    if (!speechSupported()) return;
    const jaCount = speechVoices.filter(voice => String(voice.lang || '').toLowerCase().startsWith('ja')).length;
    const koCount = speechVoices.filter(voice => String(voice.lang || '').toLowerCase().startsWith('ko')).length;
    if (!speechVoices.length) {
      $('#audioStatus').textContent = '기기 음성 목록을 기다리는 중입니다. 듣기 버튼을 한 번 누르면 목록이 나타날 수 있습니다.';
      return;
    }
    $('#audioStatus').textContent = `일본어 ${jaCount || '기본'}개 · 한국어 ${koCount || '기본'}개 음성 사용 가능`;
  }

  function selectedVoice(languagePrefix) {
    const select = languagePrefix === 'ja' ? $('#jaVoiceSelect') : $('#koVoiceSelect');
    const selectedName = select?.value || '';
    return speechVoices.find(voice => voice.name === selectedName)
      || speechVoices.find(voice => String(voice.lang || '').toLowerCase().startsWith(languagePrefix) && voice.default)
      || speechVoices.find(voice => String(voice.lang || '').toLowerCase().startsWith(languagePrefix))
      || null;
  }

  function currentNarrationItems() {
    return studyMode === 'words' ? studyOrder : weekData().grammar;
  }

  function currentNarrationItem() {
    return currentNarrationItems()[studyIndex] || null;
  }

  function rubyHtmlToReading(html, fallback = '') {
    const raw = String(html || '').trim();
    if (!raw) return String(fallback || '').trim();
    const container = document.createElement('div');
    container.innerHTML = sanitizeRubyHtml(raw, fallback);
    [...container.querySelectorAll('ruby')].forEach(ruby => {
      const rt = ruby.querySelector('rt');
      const reading = rt?.textContent?.trim();
      const base = [...ruby.childNodes]
        .filter(node => !(node.nodeType === 1 && ['RT', 'RP'].includes(node.nodeName)))
        .map(node => node.textContent || '')
        .join('')
        .trim();
      ruby.replaceWith(document.createTextNode(reading || base));
    });
    [...container.querySelectorAll('rt,rp')].forEach(node => node.remove());
    return container.textContent.replace(/\s+/g, ' ').trim() || String(fallback || '').trim();
  }

  function narrationData(item) {
    if (studyMode === 'words') {
      const reading = String(item.reading || item.word).trim();
      const override = JAPANESE_TTS_OVERRIDES[item.word] || null;

      return {
        label: item.word,
        reading,
        naturalReading: override?.natural || reading,
        clearReading: override?.clear || reading,
        repeatReading: override?.repeat || reading,
        meaning: String(item.meaning || '').trim(),
        example: override?.example || rubyHtmlToReading(item.exampleRuby, item.example),
        exampleTranslation: String(item.translation || '').trim(),
        pronunciationAdjusted: Boolean(override)
      };
    }

    const reading = rubyHtmlToReading(item.patternRuby, item.pattern);
    return {
      label: item.pattern,
      reading,
      naturalReading: reading,
      clearReading: reading,
      repeatReading: reading,
      meaning: String(item.meaning || '').trim(),
      example: rubyHtmlToReading(item.exampleRuby, item.example),
      exampleTranslation: String(item.translation || '').trim(),
      pronunciationAdjusted: false
    };
  }

  function countJapaneseMora(text) {
    const smallKana = new Set([... 'ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ']);
    let count = 0;
    [...String(text || '')].forEach(character => {
      if (/\s|[、。・，,！？!?（）()「」『』]/.test(character)) return;
      if (smallKana.has(character)) return;
      count += 1;
    });
    return Math.max(1, count);
  }

  function countKoreanSyllables(text) {
    const matches = String(text || '').match(/[가-힣0-9]/g);
    return Math.max(1, matches ? matches.length : String(text || '').replace(/\s+/g, '').length);
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function adaptiveSpeechPlan(reading, meaning, example, exampleTranslation) {
    const mora = countJapaneseMora(reading);
    const koreanLength = countKoreanSyllables(meaning);
    const exampleMora = example ? countJapaneseMora(example) : 0;
    const exampleKoreanLength = exampleTranslation
      ? countKoreanSyllables(exampleTranslation)
      : 0;

    return {
      mora,
      exampleMora,
      afterNatural: clamp(Math.round(620 + mora * 175), 950, 2900),
      afterSlow: clamp(Math.round(850 + mora * 360), 1600, 5200),
      afterMeaning: clamp(Math.round(900 + koreanLength * 165), 1500, 4300),

      // 단어 반복 뒤에는 예문으로 넘어갈 수 있을 정도의 짧은 가변 휴식을 둡니다.
      afterRepeatBeforeExample: clamp(Math.round(650 + mora * 150), 1100, 2800),

      // 예문이 길수록 듣고 따라갈 시간을 더 길게 둡니다.
      afterExample: clamp(Math.round(1000 + exampleMora * 190), 1900, 7600),

      // 예문 해석 뒤에는 다음 카드로 넘어가기 전 정리 시간을 둡니다.
      afterExampleTranslation: clamp(
        Math.round(1250 + exampleKoreanLength * 145),
        2300,
        6800
      ),

      naturalRate: mora <= 4 ? 0.98 : mora <= 7 ? 0.95 : 0.92,
      slowRate: mora <= 4 ? 0.90 : mora <= 7 ? 0.86 : 0.82,
      meaningRate: koreanLength >= 12 ? 0.90 : 0.94,
      exampleRate: exampleMora <= 12 ? 0.97 : exampleMora <= 24 ? 0.94 : 0.91,
      exampleTranslationRate: exampleKoreanLength >= 18 ? 0.90 : 0.94
    };
  }

  function waitForSpeechPause(milliseconds, token) {
    return new Promise(resolve => {
      if (token !== speechRunToken) { resolve(false); return; }
      speechTimer = window.setTimeout(() => {
        speechTimer = null;
        resolve(token === speechRunToken);
      }, milliseconds);
    });
  }

  function speakText(text, language, voice, rate, token) {
    return new Promise((resolve, reject) => {
      if (token !== speechRunToken) { resolve(false); return; }
      const utterance = new SpeechSynthesisUtterance(String(text || ''));
      activeUtterance = utterance;
      utterance.lang = language;
      utterance.rate = rate;
      utterance.pitch = 1;
      utterance.volume = 1;
      if (voice) utterance.voice = voice;
      utterance.onend = () => {
        if (activeUtterance === utterance) activeUtterance = null;
        resolve(token === speechRunToken);
      };
      utterance.onerror = event => {
        if (activeUtterance === utterance) activeUtterance = null;
        if (event.error === 'canceled' || event.error === 'interrupted') { resolve(false); return; }
        reject(new Error(`기기 음성 오류: ${event.error || '재생 실패'}`));
      };
      speechSynthesis.resume();
      speechSynthesis.speak(utterance);
    });
  }

  async function narrateOne(item, token, position, total) {
    const data = narrationData(item);
    const plan = adaptiveSpeechPlan(
      data.reading,
      data.meaning,
      data.example,
      data.exampleTranslation
    );

    const jaVoice = selectedVoice('ja');
    const koVoice = selectedVoice('ko');
    const typeLabel = studyMode === 'words' ? '단어' : '문법';

    $('#audioStatus').textContent =
      `${typeLabel} ${position}/${total} · ${data.label} · ${data.pronunciationAdjusted ? '발음 보정 낭독' : '단어 낭독'}`;

    if (!await speakText(data.naturalReading, 'ja-JP', jaVoice, plan.naturalRate, token)) return false;
    if (!await waitForSpeechPause(plan.afterNatural, token)) return false;

    if (!await speakText(data.clearReading, 'ja-JP', jaVoice, plan.slowRate, token)) return false;
    if (!await waitForSpeechPause(plan.afterSlow, token)) return false;

    if (!await speakText(data.meaning, 'ko-KR', koVoice, plan.meaningRate, token)) return false;
    if (!await waitForSpeechPause(plan.afterMeaning, token)) return false;

    if (!await speakText(data.repeatReading, 'ja-JP', jaVoice, plan.naturalRate, token)) return false;

    if (data.example) {
      if (!await waitForSpeechPause(plan.afterRepeatBeforeExample, token)) return false;

      $('#audioStatus').textContent =
        `${typeLabel} ${position}/${total} · ${data.label} · 예문 낭독`;

      if (!await speakText(
        data.example,
        'ja-JP',
        jaVoice,
        plan.exampleRate,
        token
      )) return false;

      if (!await waitForSpeechPause(plan.afterExample, token)) return false;

      if (data.exampleTranslation) {
        if (!await speakText(
          data.exampleTranslation,
          'ko-KR',
          koVoice,
          plan.exampleTranslationRate,
          token
        )) return false;

        if (!await waitForSpeechPause(plan.afterExampleTranslation, token)) return false;
      }
    } else {
      if (!await waitForSpeechPause(plan.afterExampleTranslation, token)) return false;
    }

    return true;
  }

  function setSpeechRunning(running) {
    speechRunning = running;
    $('#narrationCard').classList.toggle('running', running);
    $('#speakCurrent').disabled = running || !speechSupported();
    $('#speakWeek').disabled = running || !speechSupported();
    $('#stopSpeech').disabled = !running;
    $('#jaVoiceSelect').disabled = running;
    $('#koVoiceSelect').disabled = running;
  }

  async function startCurrentSpeech() {
    if (!speechSupported()) { toast('이 브라우저에서는 기기 음성을 사용할 수 없습니다.'); return; }
    refreshSpeechVoices();
    stopSpeech(false);
    const item = currentNarrationItem();
    if (!item) return;
    const token = ++speechRunToken;
    setSpeechRunning(true);
    try {
      await narrateOne(item, token, 1, 1);
      if (token === speechRunToken) $('#audioStatus').textContent = '현재 카드 낭독이 끝났습니다.';
    } catch (error) {
      if (token === speechRunToken) { $('#audioStatus').textContent = error.message; toast(error.message); }
    } finally {
      if (token === speechRunToken) setSpeechRunning(false);
    }
  }

  async function startWeekSpeech() {
    if (!speechSupported()) { toast('이 브라우저에서는 기기 음성을 사용할 수 없습니다.'); return; }
    refreshSpeechVoices();
    stopSpeech(false);
    const items = currentNarrationItems();
    if (!items.length) return;
    const startIndex = studyIndex;
    const token = ++speechRunToken;
    setSpeechRunning(true);
    try {
      for (let index = startIndex; index < items.length; index += 1) {
        if (token !== speechRunToken) return;
        studyIndex = index;
        renderStudy();
        saveLocal();
        const completed = await narrateOne(items[index], token, index + 1, items.length);
        if (!completed || token !== speechRunToken) return;
        if ((index + 1) % 10 === 0 && index < items.length - 1) {
          $('#audioStatus').textContent = `${index + 1}개 완료 · 긴 휴식 중`;
          if (!await waitForSpeechPause(4000, token)) return;
        }
      }
      if (token === speechRunToken) $('#audioStatus').textContent = `${studyWeek}주차 ${studyMode === 'words' ? '단어' : '문법'} 낭독이 끝났습니다.`;
    } catch (error) {
      if (token === speechRunToken) { $('#audioStatus').textContent = error.message; toast(error.message); }
    } finally {
      if (token === speechRunToken) setSpeechRunning(false);
    }
  }

  function stopSpeech(showToast = false) {
    speechRunToken += 1;
    if (speechTimer) { clearTimeout(speechTimer); speechTimer = null; }
    if (speechSupported()) speechSynthesis.cancel();
    activeUtterance = null;
    const wasRunning = speechRunning;
    setSpeechRunning(false);
    if (wasRunning) {
      $('#audioStatus').textContent = '낭독을 정지했습니다.';
      if (showToast) toast('낭독을 정지했습니다.');
    }
  }

  function containsKanji(text) {
    return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF々〆ヵヶ]/.test(String(text || ''));
  }

  function normalizeJapaneseText(text) {
    return String(text || '')
      .normalize('NFKC')
      .replace(/[\s、。・，,！？!?「」『』（）()［］\[\]【】]/g, '')
      .trim();
  }

  function canAskReadingQuestion(word) {
    const surface = normalizeJapaneseText(word?.word);
    const reading = normalizeJapaneseText(word?.reading);
    return Boolean(
      surface &&
      reading &&
      containsKanji(surface) &&
      surface !== reading
    );
  }

  function getQuizDistractors(word, field, count = 3) {
    const correct = String(word?.[field] || '').trim();
    const unique = new Set();

    let candidates = WORDS.filter(item => {
      if (!item || item.id === word.id) return false;
      if (field === 'reading' && !canAskReadingQuestion(item)) return false;

      const value = String(item[field] || '').trim();
      if (!value || value === correct || unique.has(value)) return false;

      unique.add(value);
      return true;
    });

    // 읽기 오답은 정답과 길이가 비슷한 후보를 먼저 사용해
    // 지나치게 티 나는 선택지를 줄입니다.
    if (field === 'reading') {
      const correctLength = [...correct].length;
      candidates = shuffle(candidates).sort((first, second) => {
        const firstDiff = Math.abs([...String(first.reading || '')].length - correctLength);
        const secondDiff = Math.abs([...String(second.reading || '')].length - correctLength);
        return firstDiff - secondDiff;
      });
    } else {
      candidates = shuffle(candidates);
    }

    return candidates
      .slice(0, count)
      .map(item => String(item[field] || '').trim());
  }

  function startQuiz() {
    const weekValue = $('#quizWeek').value;
    const type = $('#quizType').value;
    const count = Number($('#quizCount').value);
    const basePool = weekValue === 'all'
      ? WORDS
      : DATA.weeks[Number(weekValue) - 1].words;

    const pool = type === 'reading'
      ? basePool.filter(canAskReadingQuestion)
      : basePool;

    if (!pool.length) {
      toast('이 범위에는 읽기 문제로 낼 수 있는 한자 단어가 없습니다.');
      return;
    }

    const selected = shuffle(pool).slice(0, Math.min(count, pool.length));
    quiz = {
      items: selected.map(word => makeQuestion(word, type)),
      index: 0,
      correct: 0,
      answered: false
    };

    $('#quizSetup').classList.add('hidden');
    $('#quizResult').classList.add('hidden');
    $('#quizPlay').classList.remove('hidden');
    renderQuiz();
  }

  function makeQuestion(word, type) {
    let actualType = type;

    if (type === 'mixed') {
      actualType = canAskReadingQuestion(word) && Math.random() < 0.5
        ? 'reading'
        : 'meaning';
    }

    // 히라가나·가타카나만으로 된 단어는 읽기 문제가 성립하지 않으므로
    // 뜻 문제로 자동 전환합니다.
    if (actualType === 'reading' && !canAskReadingQuestion(word)) {
      actualType = 'meaning';
    }

    const field = actualType === 'reading' ? 'reading' : 'meaning';
    const correct = String(word[field] || '').trim();
    const candidates = getQuizDistractors(word, field, 3);

    return {
      word,
      type: actualType,
      correct,
      options: shuffle([correct, ...candidates])
    };
  }

  function renderQuiz() {
    const question = quiz.items[quiz.index];
    quiz.answered = false;
    $('#quizNumber').textContent = `${quiz.index + 1} / ${quiz.items.length}`;
    $('#quizScore').textContent = `정답 ${quiz.correct}`;
    $('#quizProgress').style.width = `${quiz.index / quiz.items.length * 100}%`;
    $('#quizPromptLabel').textContent = question.type === 'reading' ? '올바른 읽기를 고르세요' : '올바른 뜻을 고르세요';
    if (question.type === 'reading') $('#quizQuestion').textContent = question.word.word;
    else $('#quizQuestion').innerHTML = wordRubyHtml(question.word);
    $('#quizOptions').innerHTML = question.options.map((option, index) => `<button class="option" data-option-index="${index}" type="button">${escapeHtml(option)}</button>`).join('');
    $('#quizExplanation').classList.add('hidden');
    $('#nextQuiz').classList.add('hidden');
    $$('#quizOptions .option').forEach(button => button.addEventListener('click', () => answerQuiz(button, question.options[Number(button.dataset.optionIndex)])));
  }

  async function answerQuiz(button, selected) {
    if (quiz.answered) return;
    quiz.answered = true;
    const question = quiz.items[quiz.index];
    const isCorrect = selected === question.correct;
    if (isCorrect) quiz.correct += 1;
    $$('#quizOptions .option').forEach((optionButton, index) => {
      optionButton.disabled = true;
      if (question.options[index] === question.correct) optionButton.classList.add('correct');
    });
    if (!isCorrect) button.classList.add('wrong');
    $('#quizQuestion').innerHTML = wordRubyHtml(question.word);
    $('#quizExplanation').innerHTML = `<div class="quiz-answer-word"><b>${wordRubyHtml(question.word)}</b><span>${escapeHtml(question.word.meaning)}</span></div><div class="quiz-example">${sanitizeRubyHtml(question.word.exampleRuby, question.word.example)}${question.word.translation ? `<small class="quiz-example-translation">${escapeHtml(question.word.translation)}</small>` : ''}</div>`;
    $('#quizExplanation').classList.remove('hidden');
    $('#nextQuiz').classList.remove('hidden');
    DATA.quiz.total += 1;
    if (isCorrect) DATA.quiz.correct += 1;
    if (!isCorrect) {
      const previous = mistakes.get(question.word.id) || { wordId: question.word.id, week: question.word.week, word: question.word.word, reading: question.word.reading, meaning: question.word.meaning, readingWrong: 0, meaningWrong: 0, confused: 0, resolved: false };
      previous[question.type === 'reading' ? 'readingWrong' : 'meaningWrong'] += 1;
      previous.resolved = false;
      mistakes.set(question.word.id, previous);
    }
    server('recordQuizAnswer', { week: question.word.week, type: question.type, wordId: question.word.id, question: question.word.word, correctAnswer: question.correct, selectedAnswer: selected, isCorrect }).catch(error => toast(error.message));
  }

  function nextQuiz() {
    quiz.index += 1;
    if (quiz.index >= quiz.items.length) finishQuiz();
    else renderQuiz();
  }

  function finishQuiz() {
    $('#quizPlay').classList.add('hidden');
    const percent = Math.round(quiz.correct / quiz.items.length * 100);
    const result = $('#quizResult');
    result.innerHTML = `<p class="eyebrow">퀴즈 완료</p><strong>${percent}%</strong><h2>${quiz.correct} / ${quiz.items.length} 정답</h2><button id="quizAgain" class="primary-btn" type="button">다시 풀기</button>`;
    result.classList.remove('hidden');
    $('#quizAgain').addEventListener('click', () => { $('#quizSetup').classList.remove('hidden'); result.classList.add('hidden'); });
    renderHome();
  }

  function renderMistakes() {
    let list = [...mistakes.values()].filter(item => !item.resolved);
    if (mistakeFilter === 'reading') list = list.filter(item => item.readingWrong > 0);
    if (mistakeFilter === 'meaning') list = list.filter(item => item.meaningWrong > 0);
    if (mistakeFilter === 'confused') list = list.filter(item => item.confused > 0);
    list.sort((first, second) => (second.readingWrong + second.meaningWrong + second.confused) - (first.readingWrong + first.meaningWrong + first.confused));
    $('#mistakeList').innerHTML = list.length
      ? list.map(item => `<article class="mistake-item"><div class="top"><div><h3>${escapeHtml(item.word)}</h3><p>${escapeHtml(item.reading)} · ${escapeHtml(item.meaning)}</p></div><button class="text-btn" data-resolve="${escapeHtml(item.wordId)}" type="button">해결</button></div><div class="mistake-counts"><span>읽기 ${item.readingWrong}</span><span>뜻 ${item.meaningWrong}</span><span>헷갈림 ${item.confused}</span></div></article>`).join('')
      : '<div class="empty">현재 미해결 오답이 없습니다.</div>';
    $$('[data-resolve]').forEach(button => button.addEventListener('click', () => resolveOne(button.dataset.resolve)));
  }

  async function resolveOne(id) {
    const item = mistakes.get(id);
    if (item) item.resolved = true;
    renderMistakes();
    renderHome();
    try { await server('resolveMistake', id); toast('오답에서 해결 처리했습니다.'); }
    catch (error) { toast(error.message); }
  }

  async function clearMistakes() {
    if (!confirm('오답노트를 모두 삭제할까요?')) return;
    mistakes.clear();
    renderMistakes();
    renderHome();
    try { await server('clearMistakes'); toast('오답노트를 비웠습니다.'); }
    catch (error) { toast(error.message); }
  }

  async function resetAll() {
    if (!confirm('학습 상태, 오답, 퀴즈 기록을 모두 초기화할까요?')) return;
    progress.clear();
    mistakes.clear();
    DATA.quiz = { total: 0, correct: 0 };
    renderAll();
    try { await server('resetProgress'); toast('학습 기록을 초기화했습니다.'); }
    catch (error) { toast(error.message); }
  }

  function getStatusSheetConfig(type) {
    const configs = {
      known: { eyebrow: '암기 상태', title: '암기완료 항목', description: '알았음으로 저장한 단어와 문법을 함께 보여 줍니다.' },
      confused: { eyebrow: '복습 대상', title: '헷갈리는 항목', description: '헷갈림 또는 모름으로 저장한 단어와 문법입니다.' },
      mistakes: { eyebrow: '퀴즈 오답', title: '미해결 단어 오답', description: '단어 퀴즈에서 틀린 뒤 아직 해결하지 않은 항목입니다.' }
    };
    return configs[type] || configs.known;
  }

  function getStatusSheetItems(type) {
    if (type === 'mistakes') {
      return [...mistakes.values()].filter(item => !item.resolved).map(item => {
        const word = WORD_MAP.get(item.wordId) || { id: item.wordId, week: item.week, word: item.word, reading: item.reading, meaning: item.meaning };
        const total = Number(item.readingWrong || 0) + Number(item.meaningWrong || 0) + Number(item.confused || 0);
        return { kind: 'word', id: word.id, week: word.week, order: word.number || 0, titleHtml: wordRubyHtml(word), meaning: word.meaning, statusLabel: `오답 ${total}회`, statusClass: 'mistake', detail: [item.readingWrong ? `읽기 ${item.readingWrong}` : '', item.meaningWrong ? `뜻 ${item.meaningWrong}` : '', item.confused ? `헷갈림 ${item.confused}` : ''].filter(Boolean).join(' · ') };
      });
    }

    const accepted = type === 'known' ? ['known'] : ['confused', 'unknown'];
    const wordItems = WORDS.filter(word => accepted.includes(progress.get(`word|${word.id}`)?.status)).map(word => {
      const status = progress.get(`word|${word.id}`)?.status;
      return { kind: 'word', id: word.id, week: word.week, order: word.number, titleHtml: wordRubyHtml(word), meaning: word.meaning, statusLabel: type === 'known' ? '암기완료' : (status === 'unknown' ? '모름' : '읽기 헷갈림'), statusClass: type === 'known' ? 'known' : (status === 'unknown' ? 'unknown' : 'confused'), detail: `${word.week}주차 · 단어` };
    });
    const grammarItems = GRAMMAR.filter(item => accepted.includes(progress.get(`grammar|${item.id}`)?.status)).map(item => {
      const status = progress.get(`grammar|${item.id}`)?.status;
      return { kind: 'grammar', id: item.id, week: item.week, order: item.number, titleHtml: sanitizeRubyHtml(item.patternRuby, item.pattern), meaning: item.meaning, statusLabel: type === 'known' ? '암기완료' : (status === 'unknown' ? '모름' : '헷갈림'), statusClass: type === 'known' ? 'known' : (status === 'unknown' ? 'unknown' : 'confused'), detail: `${item.week}주차 · 문법` };
    });
    return [...wordItems, ...grammarItems];
  }

  function sortStatusItems(items) {
    return [...items].sort((first, second) => {
      if (first.week !== second.week) return first.week - second.week;
      if (first.kind !== second.kind) return first.kind === 'word' ? -1 : 1;
      return Number(first.order || 0) - Number(second.order || 0);
    });
  }

  function openStatusSheet(type) {
    clearTimeout(statusSheetCloseTimer);
    const config = getStatusSheetConfig(type);
    const items = sortStatusItems(getStatusSheetItems(type));
    const wordCount = items.filter(item => item.kind === 'word').length;
    const grammarCount = items.filter(item => item.kind === 'grammar').length;
    $('#statusSheetEyebrow').textContent = config.eyebrow;
    $('#statusSheetTitle').textContent = config.title;
    $('#statusSheetDescription').textContent = config.description;
    $('#statusSheetCount').textContent = type === 'mistakes' ? `${items.length}개` : `전체 ${items.length} · 단어 ${wordCount} · 문법 ${grammarCount}`;
    $('#statusSheetList').innerHTML = items.length
      ? items.map(item => `<button class="status-word-item" data-status-kind="${item.kind}" data-status-id="${escapeHtml(item.id)}" type="button"><div class="status-word-main"><div class="status-word-title">${item.titleHtml}</div><p>${escapeHtml(item.meaning)}</p></div><div class="status-word-meta"><span class="item-type ${item.kind}">${item.kind === 'grammar' ? '문법' : '단어'}</span><span class="status-badge ${escapeHtml(item.statusClass)}">${escapeHtml(item.statusLabel)}</span><small>${escapeHtml(item.detail)}</small><b>›</b></div></button>`).join('')
      : '<div class="sheet-empty"><div class="sheet-empty-icon">✓</div><strong>수집된 항목이 없습니다.</strong><p>단어와 문법을 학습하면 이곳에 자동으로 모입니다.</p></div>';
    $$('[data-status-id]').forEach(button => button.addEventListener('click', () => {
      if (button.dataset.statusKind === 'grammar') openGrammar(button.dataset.statusId);
      else openWord(button.dataset.statusId);
    }));
    const layer = $('#statusSheetLayer');
    layer.classList.remove('hidden');
    layer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('sheet-open');
    requestAnimationFrame(() => layer.classList.add('open'));
  }

  function closeStatusSheet(immediate = false) {
    const layer = $('#statusSheetLayer');
    if (!layer || layer.classList.contains('hidden')) return;
    clearTimeout(statusSheetCloseTimer);
    layer.classList.remove('open');
    document.body.classList.remove('sheet-open');
    layer.setAttribute('aria-hidden', 'true');
    if (immediate) { layer.classList.add('hidden'); return; }
    statusSheetCloseTimer = window.setTimeout(() => layer.classList.add('hidden'), 220);
  }

  init();
})();

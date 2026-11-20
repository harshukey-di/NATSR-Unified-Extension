/**
 * viewer/viewer.js - Survey photo viewer, in a window of its own.
 *
 * Opened by the side panel's "View photos" button (autopilot case types
 * only, see AUTOPILOT in common/forms.js):
 *
 *   viewer.html?case=<inspection GUID>&tab=<survey tab id>[&photo=<photoId>]
 *
 * Every photo of the survey in one grid (filter Changed / Correct, search,
 * S/M/L tiles); a click opens a zoom / pan viewer with a filmstrip and the
 * AI's notes beside the photo. The data is the survey's autopilot record in
 * chrome.storage.local, so the window shows the same run the panel does and
 * redraws when a new run lands.
 *
 * Read-only. "Show on page" opens the Order/Edit Photos panel on a tab of the
 * survey and scrolls it to the photo; it never navigates the survey tab
 * itself, which may hold unsaved form edits.
 *
 * Labels and descriptions are model output, so every node is built with
 * createElement / textContent - no innerHTML anywhere.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const RECORD_PREFIX = 'autopilot:';

  const V = {
    caseId: params.get('case') || '',
    tabId: Number(params.get('tab')) || null,
    record: null,
    items: [],          // see buildItems()
    filter: 'all',      // 'all' | 'changed' | 'correct'
    search: '',
    list: [],           // items currently in the grid / viewer
    idx: -1,
    blobUrls: new Map(), // image URL → data URL fetched through the survey tab
  };

  // ── Helpers ─────────────────────────────────────────────────────────

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function send(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        resolve(chrome.runtime.lastError ? null : resp);
      });
    });
  }

  let toastTimer = null;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-visible'), 3200);
  }

  /**
   * The inspection GUID in a NatsrUnified URL's path, lower-cased - the same
   * rule as NSR_FORMS.inspectionIdOf, which the side panel keys records on.
   */
  function inspectionIdOf(url) {
    const m = String(url || '').match(
      /\/Inspection\/(?:[A-Za-z]+\/)?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/
    );
    return m ? m[1].toLowerCase() : '';
  }

  // ── Images ──────────────────────────────────────────────────────────
  // The image URL is loaded straight into <img>, as the results page does.
  // If the browser withholds the LC360 session for that request, the bytes
  // are fetched once through the survey tab (FETCH_IMAGE_BLOB) instead.

  function setImage(img, url) {
    img.dataset.src = url || '';
    delete img.dataset.retried;
    img.src = V.blobUrls.get(url) || url || '';
  }

  document.addEventListener('error', async (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.src) return;
    const url = img.dataset.src;
    if (!img.dataset.retried && V.tabId) {
      img.dataset.retried = '1';
      const resp = await send({ action: 'FETCH_IMAGE_BLOB', imageUrl: url, targetTabId: V.tabId });
      if (resp && resp.dataUrl && img.dataset.src === url) {
        V.blobUrls.set(url, resp.dataUrl);
        img.src = resp.dataUrl;
        return;
      }
    }
    const holder = img.closest('.im');
    if (holder && !holder.querySelector('.ph')) {
      holder.appendChild(el('span', 'ph', 'Photo not available'));
      img.remove();
    }
  }, true);

  // ── Data ────────────────────────────────────────────────────────────

  /**
   * One item per photo, in on-page order:
   *   { photoId, order, label, aiLabel, status, description, thumb, full }
   * status is 'changed' when the AI disagrees with the label, 'correct' when
   * it agrees, '' when the photo has no result.
   */
  function buildItems(rec) {
    const photos = rec && rec.photos;
    if (!photos || !Array.isArray(photos.images)) return [];
    const byId = {};
    (photos.results || []).forEach((r) => { if (r && r.photoId) byId[r.photoId] = r; });
    return photos.images.map((img, i) => {
      const r = byId[img.photoId] || null;
      const aiLabel = r && r.verifiedLabel != null ? String(r.verifiedLabel) : '';
      let status = '';
      if (r) {
        if (r.isCorrect === true) status = 'correct';
        else if (r.isCorrect === false) status = 'changed';
        else status = aiLabel.trim().toLowerCase() === (img.label || '').trim().toLowerCase() ? 'correct' : 'changed';
      }
      return {
        photoId: img.photoId,
        order: i + 1,
        label: img.label || '',
        aiLabel,
        status,
        description: (r && r.modelDescription) || '',
        thumb: img.thumbnailUrl || img.fullResUrl || '',
        full: img.fullResUrl || img.thumbnailUrl || '',
      };
    });
  }

  async function load() {
    const key = RECORD_PREFIX + V.caseId;
    const got = await chrome.storage.local.get(key).catch(() => ({}));
    V.record = got[key] || null;
    V.items = buildItems(V.record);
    renderHeader();
    renderGrid();
  }

  // ── Header / toolbar / grid ─────────────────────────────────────────

  function renderHeader() {
    const rec = V.record;
    const meta = (rec && rec.photos && rec.photos.meta) || {};
    $('v-survey').textContent = meta.surveyNumber ? `Survey #${meta.surveyNumber}` : 'Survey photos';
    $('v-sub').textContent = [meta.insuredName, rec && rec.caseTypeName].filter(Boolean).join(' · ');
    $('v-when').textContent = rec && rec.finishedAt
      ? `Described ${new Date(rec.finishedAt).toLocaleString()}`
      : '';
    document.title = meta.surveyNumber ? `NATSR Unified - Photos #${meta.surveyNumber}` : 'NATSR Unified - Survey Photos';
  }

  const FILTERS = [
    ['all', 'All', () => true],
    ['changed', 'Changed', (it) => it.status === 'changed'],
    ['correct', 'Correct', (it) => it.status === 'correct'],
  ];

  function filtered() {
    const s = V.search.trim().toLowerCase();
    const test = (FILTERS.find((f) => f[0] === V.filter) || FILTERS[0])[2];
    return V.items.filter((it) => test(it) && (!s
      || `${it.label} ${it.aiLabel} ${it.description} ${it.photoId}`.toLowerCase().includes(s)));
  }

  /** Text with every occurrence of the search term wrapped in <mark>. */
  function highlighted(cls, text) {
    const n = el('span', cls);
    const s = V.search.trim().toLowerCase();
    if (!s) { n.textContent = text; return n; }
    const lower = text.toLowerCase();
    let pos = 0;
    for (let at = lower.indexOf(s); at !== -1; at = lower.indexOf(s, pos)) {
      n.append(text.slice(pos, at), el('mark', '', text.slice(at, at + s.length)));
      pos = at + s.length;
    }
    n.append(text.slice(pos));
    return n;
  }

  function statusTag(it) {
    if (!it.status) return null;
    return el('span', `tag is-${it.status}`, it.status === 'changed' ? 'Changed' : 'Correct');
  }

  function renderGrid() {
    const filters = $('v-filters');
    filters.textContent = '';
    FILTERS.forEach(([key, label, test]) => {
      const b = el('button', '', `${label} ${V.items.filter(test).length}`);
      b.type = 'button';
      b.dataset.f = key;
      b.setAttribute('aria-pressed', String(V.filter === key));
      filters.appendChild(b);
    });

    const grid = $('v-grid');
    grid.textContent = '';
    if (!V.items.length) {
      grid.appendChild(el('div', 'empty',
        'No photos for this survey yet. They appear here once autopilot\'s Order Photos step has finished.'));
      return;
    }
    V.list = filtered();
    if (!V.list.length) {
      grid.appendChild(el('div', 'empty', V.search ? 'No photo matches the search.' : 'No photos in this group.'));
      return;
    }
    V.list.forEach((it) => {
      const tile = el('button', 'vtile');
      tile.type = 'button';
      tile.dataset.photo = it.photoId;
      tile.title = it.label;
      const im = el('span', 'im');
      const img = el('img');
      img.loading = 'lazy';
      img.alt = it.label;
      setImage(img, it.thumb);
      im.append(img, el('span', 'num', String(it.order)));
      const tag = statusTag(it);
      if (tag) im.appendChild(tag);
      const meta = el('span', 'meta');
      meta.appendChild(highlighted('lbl', it.label || 'No label'));
      if (it.status === 'changed' && it.aiLabel) meta.appendChild(highlighted('ai', `AI: ${it.aiLabel}`));
      tile.append(im, meta);
      grid.appendChild(tile);
    });
  }

  // ── Photo viewer ────────────────────────────────────────────────────

  const PV = { scale: 1, tx: 0, ty: 0, drag: null };

  function pvApply() {
    $('pv-img').style.transform = `translate(${PV.tx}px, ${PV.ty}px) scale(${PV.scale})`;
    $('pv-zoom').textContent = `${Math.round(PV.scale * 100)}%`;
    $('pv-stage').classList.toggle('is-zoomed', PV.scale > 1);
  }
  function pvFit() { PV.scale = 1; PV.tx = 0; PV.ty = 0; pvApply(); }
  function pvZoom(delta, cx, cy) {
    const s = Math.min(6, Math.max(1, PV.scale + delta));
    if (s === PV.scale) return;
    if (cx != null) {
      const r = $('pv-stage').getBoundingClientRect();
      const ox = cx - r.left - r.width / 2;
      const oy = cy - r.top - r.height / 2;
      PV.tx = ox - (ox - PV.tx) * s / PV.scale;
      PV.ty = oy - (oy - PV.ty) * s / PV.scale;
    }
    PV.scale = s;
    if (s === 1) { PV.tx = 0; PV.ty = 0; }
    pvApply();
  }

  function openPhoto(photoId) {
    V.list = filtered();
    if (!V.list.some((it) => it.photoId === photoId)) V.list = V.items.slice();
    const i = V.list.findIndex((it) => it.photoId === photoId);
    if (i === -1) return;

    const strip = $('pv-strip');
    strip.textContent = '';
    V.list.forEach((it, n) => {
      const img = el('img');
      img.loading = 'lazy';
      img.alt = it.label;
      img.dataset.i = String(n);
      setImage(img, it.thumb);
      strip.appendChild(img);
    });
    $('pv').hidden = false;
    showAt(i);
  }

  function closeViewer() { $('pv').hidden = true; }

  function showAt(i) {
    if (!V.list.length) return;
    V.idx = (i + V.list.length) % V.list.length;
    const it = V.list[V.idx];
    const img = $('pv-img');
    img.alt = it.label;
    setImage(img, it.full);
    $('pv-cap').textContent = it.label || 'No label';
    $('pv-pos').textContent = `${V.idx + 1} / ${V.list.length}`;
    pvFit();
    $('pv-strip').querySelectorAll('img').forEach((t) => {
      t.classList.toggle('is-on', Number(t.dataset.i) === V.idx);
    });
    const on = $('pv-strip').querySelector('img.is-on');
    if (on) on.scrollIntoView({ block: 'nearest', inline: 'center' });
    renderInfo(it);
  }

  function renderInfo(it) {
    const info = $('pv-info');
    info.textContent = '';
    info.appendChild(el('h2', '', it.label || 'No label'));
    info.appendChild(el('div', 'small muted', `Photo ${it.order} of ${V.items.length} · ID ${it.photoId}`));
    const tag = statusTag(it);
    if (tag) info.appendChild(tag);

    if (it.aiLabel) {
      info.appendChild(el('h3', '', 'AI label'));
      info.appendChild(el('p', '', it.aiLabel));
    }
    info.appendChild(el('h3', '', 'What the AI sees'));
    info.appendChild(el('p', it.description ? '' : 'muted',
      it.description || 'This photo was not described by the AI.'));

    const actions = el('div', 'pv-actions');
    const show = el('button', '', 'Show on page');
    show.type = 'button';
    show.dataset.act = 'show';
    actions.append(show);
    info.appendChild(actions);
  }

  // ── Show on page (read-only: scroll, never write) ──────────────────

  function waitForComplete(tabId) {
    return new Promise((resolve) => {
      const done = () => { chrome.tabs.onUpdated.removeListener(onUpdated); clearTimeout(timer); resolve(); };
      const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
      const timer = setTimeout(done, 30000);
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  }

  /**
   * Open the Order/Edit Photos panel on a tab of this survey, scroll it to the
   * photo and bring the tab forward.
   *
   * Order Photos is a dialog here, and every page of the survey has it, so
   * any tab already on the survey will do - the survey tab first. Opening the
   * dialog does not navigate, so a form with unsaved edits is safe. Only when
   * no tab of the survey is open is a new one opened (General Information,
   * the page the photos step used).
   */
  async function showOnPage(photoId) {
    const tabs = await chrome.tabs.query({}).catch(() => []);
    const ofSurvey = (t) => inspectionIdOf(t.url) === V.caseId;
    let tab = tabs.find((t) => t.id === V.tabId && ofSurvey(t)) || tabs.find(ofSurvey);
    if (!tab) {
      const pageUrl = V.record && V.record.pages && V.record.pages.photos;
      if (!pageUrl) return toast('No page of this survey is open');
      const survey = V.tabId ? await chrome.tabs.get(V.tabId).catch(() => null) : null;
      toast('Opening the survey…');
      tab = await chrome.tabs.create({
        url: pageUrl,
        active: false,
        windowId: survey ? survey.windowId : undefined,
        index: survey ? survey.index + 1 : undefined,
      });
      await waitForComplete(tab.id);
    }
    await chrome.tabs.update(tab.id, { active: true }).catch(() => { });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => { });
    const resp = await send({ action: 'FOCUS_IMAGE', photoId, openPanel: true, targetTabId: tab.id });
    if (!resp || !resp.ok) toast((resp && resp.error) || 'Could not find the photo in the Order/Edit Photos panel');
  }

  // ── Events ──────────────────────────────────────────────────────────

  function initEvents() {
    $('v-filters').addEventListener('click', (e) => {
      const b = e.target.closest('[data-f]');
      if (!b) return;
      V.filter = b.dataset.f;
      renderGrid();
    });
    $('v-search').addEventListener('input', (e) => {
      V.search = e.target.value;
      renderGrid();
    });
    document.querySelectorAll('.vsize [data-size]').forEach((b) => {
      b.addEventListener('click', () => setSize(b.dataset.size, true));
    });
    $('v-grid').addEventListener('click', (e) => {
      const t = e.target.closest('[data-photo]');
      if (t) openPhoto(t.dataset.photo);
    });

    $('pv').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pv]');
      const thumb = e.target.closest('#pv-strip img');
      const act = e.target.closest('[data-act]');
      if (btn) {
        ({
          prev: () => showAt(V.idx - 1),
          next: () => showAt(V.idx + 1),
          in: () => pvZoom(0.25),
          out: () => pvZoom(-0.25),
          fit: pvFit,
          info: () => $('pv').classList.toggle('no-info'),
          close: closeViewer,
        })[btn.dataset.pv]();
      } else if (thumb) {
        showAt(Number(thumb.dataset.i));
      } else if (act && act.dataset.act === 'show') {
        showOnPage(V.list[V.idx].photoId);
      }
    });

    const stage = $('pv-stage');
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      pvZoom(-e.deltaY * 0.0015 * Math.max(1, PV.scale), e.clientX, e.clientY);
    }, { passive: false });
    stage.addEventListener('dblclick', (e) => (PV.scale > 1 ? pvFit() : pvZoom(1.5, e.clientX, e.clientY)));
    stage.addEventListener('pointerdown', (e) => {
      if (PV.scale <= 1 || e.button !== 0) return;
      PV.drag = { x: e.clientX - PV.tx, y: e.clientY - PV.ty };
      stage.classList.add('is-dragging');
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', (e) => {
      if (!PV.drag) return;
      PV.tx = e.clientX - PV.drag.x;
      PV.ty = e.clientY - PV.drag.y;
      pvApply();
    });
    stage.addEventListener('pointerup', () => {
      PV.drag = null;
      stage.classList.remove('is-dragging');
    });

    addEventListener('keydown', (e) => {
      if ($('pv').hidden || (e.target.closest && e.target.closest('input'))) return;
      const k = {
        Escape: closeViewer,
        ArrowLeft: () => showAt(V.idx - 1),
        ArrowRight: () => showAt(V.idx + 1),
        '+': () => pvZoom(0.25),
        '=': () => pvZoom(0.25),
        '-': () => pvZoom(-0.25),
        0: pvFit,
        i: () => $('pv').classList.toggle('no-info'),
      }[e.key];
      if (k) { e.preventDefault(); k(); }
    });

    // A new run for this survey, or the panel's theme switch.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[RECORD_PREFIX + V.caseId]) {
        const open = !$('pv').hidden && V.list[V.idx] ? V.list[V.idx].photoId : null;
        load().then(() => { if (open) openPhoto(open); });
      }
      if (changes.sfTheme) applyTheme(changes.sfTheme.newValue);
    });

    // The panel re-points this window at another survey or photo.
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.action !== 'VIEWER_SHOW') return;
      if (msg.caseId && msg.caseId !== V.caseId) {
        const p = new URLSearchParams({ case: msg.caseId, tab: String(msg.tabId || '') });
        if (msg.photo) p.set('photo', msg.photo);
        location.search = p.toString();
        return;
      }
      if (msg.tabId) V.tabId = msg.tabId;
      if (msg.photo) openPhoto(msg.photo);
    });
  }

  function setSize(size, save) {
    $('v-grid').dataset.size = size;
    document.querySelectorAll('.vsize [data-size]').forEach((b) => {
      b.setAttribute('aria-checked', String(b.dataset.size === size));
    });
    if (save) chrome.storage.local.set({ viewerTile: size }).catch(() => { });
  }

  function applyTheme(theme) {
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  }

  (async function init() {
    initEvents();
    const st = await chrome.storage.local.get(['viewerTile', 'sfTheme']).catch(() => ({}));
    if (st.viewerTile) setSize(st.viewerTile, false);
    if (st.sfTheme) applyTheme(st.sfTheme);
    if (!V.caseId) {
      $('v-survey').textContent = 'No survey';
      return;
    }
    await load();
    const photo = params.get('photo');
    if (photo) openPhoto(photo);
  })();
})();

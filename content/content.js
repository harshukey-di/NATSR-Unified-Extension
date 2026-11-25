/**
 * content/content.js - message router for the side panel / service worker.
 *
 * Everything that touches the form goes through window.NSR_BRIDGE
 * (content/bridge.js → page/dynforms-agent.js). Nothing here reads or writes
 * form inputs directly; the DOM is only consulted for detection, General
 * Information, the left-hand page links and scrolling.
 *
 * Action names are NSR's, so the side panel (ported from NSR) talks to this
 * page exactly as it talks to an NSR page. The detection and scrape shapes are
 * NSR's too - see detectPage() and SCRAPE.
 */

(() => {
  if (window.__NATSR_CONTENT__) return;
  window.__NATSR_CONTENT__ = true;

  const FORMS = window.NSR_FORMS;
  const bridge = () => window.NSR_BRIDGE;

  // ── Detection ──────────────────────────────────────────────────────

  function unsupportedTypeReason(type) {
    return type
      ? `Survey type "${type}" is not supported. This build handles ${FORMS.SUPPORTED_SURVEY_LABEL} only.`
      : 'Survey type could not be read from this page.';
  }

  /**
   * What form is this, and is it supported? Same response shape as NSR's
   * DETECT_FORM: { supported, form, caseTypeName, detectedHeader, reason, … }.
   *
   * General Information is handled first and separately: it has no DynForms
   * engine, so the bridge would only report "no form open".
   */
  async function detectForm() {
    const GI = window.NSR_GENERALINFO;
    if (GI && GI.isGeneralInfoPage()) {
      const type = GI.surveyType();
      if (!FORMS.isSupportedSurveyType(type)) {
        return {
          supported: false,
          reason: unsupportedTypeReason(type),
          detectedHeader: 'General Information',
          caseTypeName: type,
          surveyTypeRejected: true,
        };
      }
      const entry = FORMS.generalInfoFor(type);
      if (!entry) {
        return {
          supported: false,
          reason: 'Unsupported form',
          detectedHeader: 'General Information',
          caseTypeName: type,
        };
      }
      return {
        supported: true,
        form: entry,
        formTitle: entry.name,
        detectedHeader: 'General Information',
        caseTypeName: type,
        surveyNumber: GI.surveyNumber() || GI.headerSurveyNumber(),
        mode: { editable: false, isGeneralInfo: true },
      };
    }

    const b = bridge();
    if (!b) return { supported: false, reason: 'Bridge not loaded' };

    let ctx;
    try {
      ctx = await b.context();
    } catch (err) {
      return { supported: false, reason: err.message };
    }

    // The type is read from the engine and only from the engine on a form
    // page - there is deliberately no DOM fallback, so page markup can never
    // stand in for formInfo.inspectionInfo.inspectionType.
    const surveyType = ctx.surveyType || '';

    if (!ctx.hasDynForms) {
      return { supported: false, reason: 'No form on this page', caseTypeName: surveyType, context: ctx };
    }
    if (!ctx.hasRootForm) {
      return { supported: false, reason: 'No form is open on this page', caseTypeName: surveyType, context: ctx };
    }

    const match = FORMS.matchForm(ctx.formTitle, ctx.mainSections, surveyType);

    if (!match) {
      return {
        supported: false,
        reason: 'Unsupported form',
        detectedHeader: ctx.formTitle || '',
        caseTypeName: surveyType,
        context: ctx,
      };
    }
    if (!match.matched) {
      return {
        supported: false,
        reason: match.reason,
        form: match.form,
        detectedHeader: ctx.formTitle || '',
        caseTypeName: surveyType,
        surveyTypeRejected: !!match.surveyTypeRejected,
        context: ctx,
      };
    }

    return {
      supported: true,
      form: match.form,
      formTitle: ctx.formTitle,
      detectedHeader: ctx.formTitle,
      caseTypeName: surveyType,
      surveyNumber: ctx.surveyNumber,
      inspectionID: ctx.inspectionID,
      inspectionFormID: ctx.inspectionFormID,
      inspection: ctx.inspection,
      mode: ctx.mode,
      context: ctx,
    };
  }

  /**
   * Survey type as shown on the page, for pages without an engine. Only
   * General Information carries it.
   */
  function surveyTypeFromDom() {
    const GI = window.NSR_GENERALINFO;
    return GI && GI.isGeneralInfoPage() ? GI.surveyType() : '';
  }

  /** Survey number off the page: the GI grid first, then the banner every page has. */
  function surveyNumberFromDom() {
    const GI = window.NSR_GENERALINFO;
    if (!GI) return '';
    if (GI.isGeneralInfoPage()) {
      const fromGrid = GI.surveyNumber();
      if (fromGrid) return fromGrid;
    }
    return GI.headerSurveyNumber();
  }

  /**
   * Fill survey number / type onto an EXTRACT_IMAGES response.
   *
   * The photo agent reads both off the engine, but the ORDER button also
   * exists on General Information, where getLoadedFormInstance() throws and
   * the agent degrades to ''. The image upload would then POST
   * survey_number=''. The DOM has both, and this isolated script can read it.
   */
  function withSurveyIdentity(resp) {
    if (!resp || !resp.meta) return resp;
    const meta = { ...resp.meta };
    if (!meta.surveyNumber) meta.surveyNumber = surveyNumberFromDom();
    if (!meta.surveyType) meta.surveyType = surveyTypeFromDom();
    return { ...resp, meta };
  }

  /**
   * Capability snapshot for the side panel - NSR's DETECT_PAGE shape:
   * { url, title, hostname, caseTypeName, form, images, generalInfo }.
   *
   * The Order/Edit Photos dialog is modal: while it is open the form behind it
   * cannot be worked, so the two capabilities are made mutually exclusive.
   * Dialog open → images supported, form suppressed. Dialog closed → the form
   * is detected normally and images report "open the panel".
   */
  async function detectPage() {
    const form = await detectForm();
    const images = await detectImages(form.caseTypeName);

    const shadowed = images.supported
      ? {
          supported: false,
          reason: 'The Order/Edit Photos panel is open. Close it to work on the form.',
          shadowedByPhotoPanel: true,
          formTitle: form.formTitle || (form.form && form.form.name) || '',
          caseTypeName: form.caseTypeName || '',
        }
      : form;

    return {
      url: window.location.href,
      title: document.title,
      hostname: window.location.hostname,
      caseTypeName: form.caseTypeName || '',
      surveyNumber: form.surveyNumber || surveyNumberFromDom(),
      form: shadowed,
      images,
      generalInfo: generalInfoBlock(form),
    };
  }

  /**
   * The address block the side panel renders (Copy / Google / Maps).
   *
   *   form page → engine inspectionInfo.locationAddress, already structured,
   *               with formInfo.latitudeLongitude alongside
   *   GI page   → the "Address to be Surveyed" row, geocode trailer stripped,
   *               coordinates parsed from that trailer
   *
   * Shown on every page of a survey that has an address, supported or not, so
   * the inspector can reach Maps without going back to General Information.
   */
  function generalInfoBlock(form) {
    const GI = window.NSR_GENERALINFO;
    const isGeneralInfo = !!(GI && GI.isGeneralInfoPage());

    if (isGeneralInfo) {
      const fields = GI.extractFields(['Address to be Surveyed']);
      const geo = GI.addressGeocode();
      return {
        isGeneralInfo: true,
        address: fields.Address || '',
        latitude: geo ? geo.latitude : null,
        longitude: geo ? geo.longitude : null,
        source: 'general-info-page',
        quote: GI.priceInputs(),
      };
    }

    const inspection = (form && form.inspection)
      || (form && form.context && form.context.inspection)
      || null;
    const address = inspection && inspection.address;
    if (address && address.formatted) {
      return {
        isGeneralInfo: false,
        address: address.formatted,
        latitude: inspection.latitude,
        longitude: inspection.longitude,
        source: 'engine',
      };
    }
    return { isGeneralInfo: false, address: '' };
  }

  /**
   * Order Photos capability: the Order/Edit Photos dialog must be OPEN, not
   * merely present - closing it leaves #orderDialog in the DOM with every tile
   * intact. Gated on the survey type like everything else.
   */
  async function detectImages(surveyType) {
    const b = bridge();
    if (!b) return { supported: false, reason: 'Bridge not loaded' };

    if (!FORMS.isSupportedSurveyType(surveyType)) {
      return { supported: false, reason: unsupportedTypeReason(surveyType), surveyTypeRejected: true };
    }

    try {
      const state = await b.photoPanelState();
      if (!state.open) {
        return {
          supported: false,
          reason: 'Open the Order/Edit Photos panel (ORDER button above the photo rail).',
          panelOpen: false,
          hasOrderButton: !!document.getElementById('orderPhotos'),
        };
      }
      return state.count > 0
        ? { supported: true, count: state.count, panelOpen: true, useCollections: state.useCollections }
        : { supported: false, reason: 'No photos in the panel', panelOpen: true };
    } catch (err) {
      return { supported: false, reason: err.message };
    }
  }

  // ── Order/Edit Photos dialog ───────────────────────────────────────

  /**
   * Open the Order/Edit Photos dialog the way the inspector does - a click on
   * ORDER - and wait until its tiles are there. Opening it changes nothing on
   * the survey: only "Save Changes to Photos" writes, and nothing here clicks
   * that. The dialog is built on the first click, so it may take a moment.
   */
  async function openPhotoPanel(timeoutMs) {
    const b = bridge();
    let state = await b.photoPanelState();
    if (state.open && state.count > 0) return { ok: true, count: state.count, alreadyOpen: true };

    const btn = document.getElementById('orderPhotos');
    if (!btn) return { ok: false, error: 'This page has no ORDER button for photos.' };

    // One click opened it in testing (survey 2721, 6 photos). The click is
    // repeated every 3 s while the dialog stays shut, in case the page had not
    // bound its handler yet - a background tab can be asked straight after
    // its load event.
    let lastClick = 0;
    let openedAt = 0;
    const deadline = Date.now() + (timeoutMs || 20000);
    while (Date.now() < deadline) {
      if (!state.open && Date.now() - lastClick >= 3000) {
        btn.click();
        lastClick = Date.now();
      }
      await new Promise((r) => setTimeout(r, 250));
      state = await b.photoPanelState();
      if (state.open && state.count > 0) return { ok: true, count: state.count };
      if (state.open && !openedAt) openedAt = Date.now();
      // Open but still empty after 5 s: the survey has no photos.
      if (openedAt && Date.now() - openedAt > 5000) return { ok: true, count: 0 };
    }
    return state.open
      ? { ok: true, count: 0 }
      : { ok: false, error: 'The Order/Edit Photos panel did not open.' };
  }

  // ── Scrape helpers ─────────────────────────────────────────────────

  function cleanLabel(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/\s*:\s*$/, '').trim();
  }

  /** Normalise a coverFields entry to { match, key }. */
  function coverEntry(f) {
    if (typeof f === 'string') return { match: f, key: f };
    return { match: f.match, key: f.key || f.match };
  }

  /**
   * Does `label` match a cover entry? Case-insensitive prefix match with a
   * word boundary after it, so "Inspection comments" catches "Inspection
   * comments / Special instructions comments" but "Common Hazards" could
   * never catch "Common Hazards Extra".
   */
  function labelMatches(label, match) {
    const l = cleanLabel(label).toLowerCase();
    const m = cleanLabel(match).toLowerCase();
    if (!m || !l.startsWith(m)) return false;
    const next = l.charAt(m.length);
    return next === '' || /[\s:/(-]/.test(next);
  }

  function isCoverQuestion(q, coverFields) {
    return (coverFields || []).some((f) => labelMatches(q.questionText, coverEntry(f).match));
  }

  /**
   * The cover leg's knowledge-base dict: { [key]: text } for every cover
   * entry found on the page. An entry absent from the page is left out rather
   * than sent empty. A field that is present but blank is sent as "".
   */
  function toCoverDict(extracted, coverFields) {
    const questions = (extracted.sections || []).flatMap((s) => s.questions || []);
    const out = {};
    (coverFields || []).forEach((f) => {
      const { match, key } = coverEntry(f);
      const q = questions.find((x) => labelMatches(x.questionText, match));
      if (!q) return;
      out[key] = Array.isArray(q.answer) ? q.answer.join(', ') : (q.answer == null ? '' : String(q.answer));
    });
    return out;
  }

  /**
   * The verify leg's payload with the cover questions taken out. Those are the
   * inspector's own narrative and already go to the knowledge base, so the AI
   * is not asked to answer them. `items` (the flat list the backend gets) and
   * `sections` (what the queue renders) are filtered the same way, and the
   * question count is recomputed.
   */
  function withoutCoverQuestions(extracted, coverFields) {
    if (!coverFields || !coverFields.length) return extracted;
    const keep = (q) => !(q && q.type === 'question' && isCoverQuestion(q, coverFields));

    const items = (extracted.items || []).filter(keep);
    const sections = (extracted.sections || [])
      .map((s) => ({ ...s, questions: (s.questions || []).filter((q) => !isCoverQuestion(q, coverFields)) }));
    const questions = sections.reduce((n, s) => n + s.questions.length, 0);

    return {
      ...extracted,
      items,
      sections,
      stats: { ...(extracted.stats || {}), sections: sections.length, questions },
    };
  }

  // ── Message router ─────────────────────────────────────────────────
  //
  // Every handler may be async (the bridge is promise-based), so the
  // listener always returns true to keep the sendResponse channel open.

  const HANDLERS = {
    DETECT_PAGE: () => detectPage(),
    DETECT_FORM: () => detectForm(),
    GET_MODE: () => bridge().mode(),

    /**
     * Build the backend payload for whichever page we are on.
     *
     *   kind 'generic_fields'           → kbData {key: value} from the GI rows
     *   flow 'kb_then_verify' (form)    → kbData (cover dict) + coverStats,
     *                                     and items/sections/stats for verify
     *   flow 'verify' (form)            → items/sections/stats
     *
     * IMPORTANT - response shape: the service worker reads `items`,
     * `sections`, `stats`, `kbData` and `coverStats` at the TOP LEVEL of this
     * response. Nesting them under a `data` key made the verify POST go out
     * with no form data at all on NSR-Boost - so the extract is spread.
     */
    async SCRAPE() {
      const detection = await detectForm();
      if (!detection.supported) {
        return { success: false, error: detection.reason || 'Unsupported page' };
      }

      const form = detection.form;
      const kind = form.kind || 'form';
      const flow = form.flow || 'verify';
      const base = {
        success: true,
        // The engine's own survey number. NOT referenceID - that is a GUID.
        surveyNumber: detection.surveyNumber || surveyNumberFromDom() || null,
        surveyType: detection.caseTypeName || '',
        form,
        flow,
        kind,
        pageType: form.pageType || '',
        mode: detection.mode,
        extractedAt: new Date().toISOString(),
        sourceUrl: window.location.href,
      };

      if (kind === 'generic_fields') {
        const GI = window.NSR_GENERALINFO;
        if (!GI) return { success: false, error: 'General Information extractor not loaded' };
        const dict = GI.extractFields(form.genericFields);
        return { ...base, kbData: dict, stats: { fields: Object.keys(dict).length } };
      }

      const extracted = await bridge().extract();

      // A form with no registry entry becomes the chained flow when it has an
      // inspection-comments field; without one it stays plain verify.
      if (flow === 'verify' && form.generic) {
        const kbData = toCoverDict(extracted, form.coverFields);
        if (Object.keys(kbData).length) {
          return {
            ...base,
            flow: 'kb_then_verify',
            pageType: 'cover',
            ...withoutCoverQuestions(extracted, form.coverFields),
            kbData,
            coverStats: { fields: Object.keys(kbData).length },
          };
        }
      }

      if (flow === 'kb_then_verify') {
        const kbData = toCoverDict(extracted, form.coverFields);
        return {
          ...base,
          ...withoutCoverQuestions(extracted, form.coverFields),
          kbData,
          coverStats: { fields: Object.keys(kbData).length },
        };
      }

      return { ...base, ...extracted };
    },

    /**
     * The survey's page URLs, keyed by the exact link text the caller asks
     * for ("General Information", "Orarius Underwriting Exterior"). Read from
     * the left-hand Forms list, which every page of the survey carries.
     */
    GET_SURVEY_PAGES(msg) {
      const wanted = Array.isArray(msg.labels) ? msg.labels : [];
      const pages = {};
      const scope = document.getElementById('formScroll') || document;
      scope.querySelectorAll('a[href]').forEach((a) => {
        const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
        if (!wanted.includes(text) || pages[text]) return;
        let url;
        try { url = new URL(a.getAttribute('href'), window.location.href); } catch (_) { return; }
        // Same-origin http(s) only - never a javascript: or postback link.
        if (url.origin !== window.location.origin) return;
        pages[text] = url.href;
      });
      return { ok: true, pages };
    },

    async APPLY_ANSWER(msg) {
      const value = toEngineValue(msg.question, msg.aiItem);
      if (value === undefined) {
        return { ok: false, error: 'No AI answer to apply' };
      }
      const res = await bridge().setValues([
        { questionId: msg.question.questionId, value },
      ]);
      const first = res.results && res.results[0];
      if (!res.ok) return { ok: false, error: res.error, mode: res.mode };
      return first && first.ok
        ? { ok: true, applied: value, before: first.before }
        : { ok: false, error: (first && first.error) || 'setValue failed' };
    },

    async REVERT_ANSWER(msg) {
      // The captured original answer, in the shape the engine expects.
      const q = msg.question || {};
      const original = q.inputType === 'checkbox'
        ? (q.options || []).filter((o) => o.selected).map((o) => o.label)
        : (q.answer != null ? q.answer : '');
      const res = await bridge().setValues([{ questionId: q.questionId, value: original }]);
      const first = res.results && res.results[0];
      return first && first.ok ? { ok: true } : { ok: false, error: (first && first.error) || res.error };
    },

    /**
     * Photo list for the Order Photos flow, read from the OPEN Order/Edit
     * Photos dialog - the only place labels can be edited and order staged.
     * Returns NSR's NOT_ORDER_PHOTOS_PAGE code when it is closed.
     */
    async EXTRACT_IMAGES() {
      try {
        return withSurveyIdentity(await bridge().extractPanel());
      } catch (err) {
        return { error: err.message };
      }
    },

    async OPEN_PHOTO_PANEL(msg) {
      return openPhotoPanel(msg && msg.timeoutMs);
    },

    async PHOTO_PANEL_STATE() {
      return bridge().photoPanelState();
    },

    /** AI sort: `results` is the API response; order comes from its photoId sequence. */
    async APPLY_API_RESULTS(msg) {
      const order = (msg.results || []).map((r) => r.photoId).filter(Boolean);
      return bridge().applyApiResults(order, msg.labelMap);
    },

    async RESTORE_IMAGES(msg) {
      return bridge().restoreOriginal(msg && msg.labelMap);
    },

    async SET_IMAGE_LABEL(msg) {
      return bridge().setPhotoLabel(msg.photoId, msg.label);
    },

    async SET_IMAGE_LABELS_BULK(msg) {
      return bridge().applyLabelMap(msg.labelMap);
    },

    /**
     * Scroll the Order/Edit Photos dialog to a photo. `openPanel` opens the
     * dialog first when it is closed (the photo viewer's "Show on page").
     */
    async FOCUS_IMAGE(msg) {
      if (msg && msg.openPanel) {
        const opened = await openPhotoPanel();
        if (!opened.ok) return opened;
      }
      return bridge().focusPhoto(msg.photoId);
    },

    /** Open the full-resolution viewer on the page. */
    SHOW_IMAGE_MODAL(msg) {
      if (!window.NSR_IMAGE_MODAL) {
        return { ok: false, error: 'Image modal not loaded on this page' };
      }
      const gallery = Array.isArray(msg.images)
        ? msg.images
        : (msg.imageUrl ? [msg.imageUrl] : []);
      const ok = window.NSR_IMAGE_MODAL.show(gallery, msg.index || 0);
      return ok ? { ok: true } : { ok: false, error: 'No image URL' };
    },

    /** Warm the on-page image cache (fire-and-forget). */
    PREFETCH_IMAGES(msg) {
      if (!window.NSR_IMAGE_MODAL || typeof window.NSR_IMAGE_MODAL.prefetch !== 'function') {
        return { ok: false, error: 'Image modal not loaded on this page' };
      }
      window.NSR_IMAGE_MODAL.prefetch(msg.images || []);
      return { ok: true };
    },

    /**
     * Fetch an image as a data URL from the page context. The image endpoint
     * is session-authenticated and same-origin with the page, so the cookies
     * ride along here and would not from the side panel.
     */
    async FETCH_IMAGE_BLOB(msg) {
      const res = await fetch(msg.imageUrl, { credentials: 'include' });
      if (!res.ok) throw new Error(`Image fetch returned ${res.status}`);
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read image blob'));
        reader.readAsDataURL(blob);
      });
      return { ok: true, dataUrl, type: blob.type, size: blob.size };
    },

    FOCUS_QUESTION(msg) {
      // The control GUID is both the question id and the container's DOM id.
      const id = msg.questionUid || msg.questionId;
      const el = id ? document.getElementById(id) : null;
      if (!el) return { ok: false, error: 'Control not found' };
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (window.NSR_HIGHLIGHTER) window.NSR_HIGHLIGHTER.flash(el);
      return { ok: true };
    },
  };

  /**
   * Translate an AI response item into a value the engine accepts.
   *   radio/select  → the selected option label (string)
   *   checkbox      → array of selected option labels
   *   text/textarea → the answer string
   * Returns undefined when the AI produced nothing usable.
   */
  function toEngineValue(question, aiItem) {
    const ai = aiItem || {};
    const type = question && question.inputType;

    if (type === 'checkbox') {
      const opts = ai.options || question.options || [];
      return opts
        .filter((o) => (o.aiSelected !== undefined ? o.aiSelected : o.selected))
        .map((o) => o.label);
    }

    if (type === 'radio' || type === 'select') {
      const opts = ai.options || question.options || [];
      const target = opts.find((o) => o.aiSelected === true) || opts.find((o) => o.selected === true);
      return target ? target.label : undefined;
    }

    const v = ai.aiAnswer != null ? ai.aiAnswer : ai.answer;
    if (v == null || v === 'null') return undefined;
    return String(v);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const handler = HANDLERS[msg && msg.action];
    if (!handler) return false;

    Promise.resolve()
      .then(() => handler(msg))
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, success: false, error: err.message || String(err) }));

    return true; // async response
  });

  // ── Panel-open watcher ─────────────────────────────────────────────
  //
  // The Order/Edit Photos dialog is shown and hidden in place, so nothing
  // navigates and the worker's tabs.onUpdated broadcast never fires. Without
  // this the side panel would keep whatever capability state it saw first.

  let lastPanelOpen = null;

  function panelIsVisible() {
    const el = document.getElementById('orderDialog');
    return !!(el && el.offsetParent !== null);
  }

  function debounce(fn, ms) {
    let t = null;
    return () => {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  const notifyPanelChange = debounce(() => {
    const open = panelIsVisible();
    if (open === lastPanelOpen) return;
    lastPanelOpen = open;
    // Only the tab the inspector is looking at matters to the panel; a
    // background autopilot tab opening its dialog must not trigger a
    // detection broadcast of whatever tab is in front.
    if (document.visibilityState !== 'visible') return;
    chrome.runtime.sendMessage({ action: 'REQUEST_DETECTION' }).catch(() => {
      // No listener (side panel closed) - nothing to do.
    });
  }, 200);

  new MutationObserver(notifyPanelChange).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['style', 'class'],
  });

  console.log('[NATSR] Content script loaded');
})();

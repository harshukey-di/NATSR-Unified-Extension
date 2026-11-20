/**
 * background/background.js - Manifest V3 service worker.
 *
 * Responsibilities (same as NSR's worker):
 *   1. Open the side panel when the action icon is clicked.
 *   2. Track the active tab and broadcast page detection so the side panel
 *      knows which capabilities (form / images) the page has.
 *   3. Run the Sync pipeline: scrape the page, then call the knowledge-base
 *      and/or verify API depending on the form's flow.
 *   4. Forward per-tab actions to the content script, re-injecting it when
 *      needed - here in two worlds, see injectContentScripts().
 *   5. Deliver un-sent review feedback from a stored draft.
 *
 * The network calls are NSR's, unchanged: plain fetch, no sign-in, no token.
 *
 * Service workers can be restarted at any time - every handler must work
 * from a cold start. Nothing relies on in-memory state between messages.
 */

importScripts('/common/forms.js');
importScripts('/common/feedback.js');

// ── Endpoints ────────────────────────────────────────────────────────
// Same QA Agent and the same three endpoints NSR uses:
//
//   VERIFY_API    POST { survey_no, survey_type, data: <items[]> }
//                 → { result_id, answers: [...] }
//   KB_API        POST { survey_no, page_type: "cover" | "general", data: {} }
//                 → 200 { status: "saved", survey_no, page_type }
//                   400 / 404 { detail }
//   FEEDBACK_API  POST { result_id, feedback: [...] } → 200
//
// The image pipeline (/pipeline) is posted from the side panel, because a
// multipart FormData body cannot cross runtime.sendMessage.
//
// The paths are identical on every instance, so switching all three is this
// one line (keep sidepanel.js IMAGES_API in step):
//   staging     https://qagent.dhaninfo.ai/test
//   production  https://qagent.dhaninfo.ai
const API_BASE = 'https://qagent.dhaninfo.ai';

const VERIFY_API = `${API_BASE}/verify-direct`;
const FEEDBACK_API = `${API_BASE}/feedback`;
const KB_API = `${API_BASE}/knowledge`;

// ── Side panel ────────────────────────────────────────────────────────

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[NATSR] sidePanel setup failed:', err));

// ── Tab helpers ──────────────────────────────────────────────────────

/**
 * The active tab of the last-focused NORMAL window - the window the side
 * panel lives in. Not "currentWindow": the photo viewer is a popup window of
 * its own, and while it has focus currentWindow would be the viewer.
 */
async function getActiveTab() {
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  const [tab] = await chrome.tabs.query(
    win ? { active: true, windowId: win.id } : { active: true, currentWindow: true }
  );
  return tab;
}

// Two injections, because the two halves live in different worlds. The MAIN
// world agent must exist before the isolated bridge talks to it, so it goes
// first and is awaited. Order inside FILES_MAIN matters too: photos-agent
// registers into the dispatch table dynforms-agent creates.
const FILES_MAIN = ['page/dynforms-agent.js', 'page/photos-agent.js'];
const FILES_ISOLATED = [
  'common/forms.js',
  'content/bridge.js',
  'content/generalinfo.js',
  'content/highlighter.js',
  'content/imageModal.js',
  'content/content.js',
];

/**
 * Re-inject the content scripts. Recovery path for when sendMessage fails -
 * typically a tab that was open before the extension was installed or
 * reloaded. Every script guards against running twice.
 */
async function injectContentScripts(tabId, url) {
  const caps = self.NSR_FORMS.capabilitiesForUrl(url);
  if (!caps.form && !caps.images) throw new Error('Page is not a NatsrUnified inspection page');

  await chrome.scripting.executeScript({ target: { tabId }, files: FILES_MAIN, world: 'MAIN' });
  await chrome.scripting.executeScript({ target: { tabId }, files: FILES_ISOLATED });
  // Give the IIFEs a tick to register their window globals.
  await new Promise((r) => setTimeout(r, 150));
}

/** Send a message to a tab's content script, injecting first if needed. */
async function sendToTab(tabId, url, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    try {
      await injectContentScripts(tabId, url);
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (err2) {
      throw new Error(err2.message || err.message || 'Content script unreachable');
    }
  }
}

/**
 * Which tab a request acts on.
 *
 *   targetTabId    pins the tab, so tabbing away mid-run (to read email while
 *                  photos upload) cannot send the request to another tab. For
 *                  APPLY_ANSWER an unpinned send could write into the wrong
 *                  form.
 *   targetPageKey  the pinned tab may have moved to another page of the
 *                  survey (or another survey) without its id changing. A
 *                  different page's values are worse than none, so refuse.
 *
 * No pin means "whatever is in front right now" - still right for the
 * detection broadcast.
 */
async function resolveTargetTab(msg) {
  if (typeof msg.targetTabId !== 'number') {
    const active = await getActiveTab();
    if (!active?.id) throw new Error('No active tab');
    return active;
  }

  const tab = await chrome.tabs.get(msg.targetTabId).catch(() => null);
  if (!tab) throw new Error('The NatsrUnified tab this action belongs to is no longer open.');
  if (msg.targetPageKey && !self.NSR_FORMS.samePage(tab.url, msg.targetPageKey)) {
    throw new Error(
      'That tab has moved to a different page. Go back to the original form, or run it again from the page you are on.'
    );
  }
  return tab;
}

// ── Page-detection broadcast ─────────────────────────────────────────

/**
 * Ask the active tab for its capability snapshot and push PAGE_DETECTED to
 * the side panel. Called on tab change, on navigation complete, and when the
 * panel or the photo-dialog watcher asks.
 */
async function broadcastPageDetection() {
  const tab = await getActiveTab();
  if (!tab) return;

  const caps = self.NSR_FORMS.capabilitiesForUrl(tab.url);
  let detection;

  if (!caps.form && !caps.images) {
    detection = {
      url: tab.url,
      title: tab.title,
      hostname: caps.hostname,
      form: { supported: false, reason: 'Not a NatsrUnified inspection page', hostname: caps.hostname },
      images: { supported: false, reason: 'Not a NatsrUnified inspection page', hostname: caps.hostname },
    };
  } else {
    try {
      detection = await sendToTab(tab.id, tab.url, { action: 'DETECT_PAGE' });
    } catch (err) {
      detection = {
        url: tab.url,
        title: tab.title,
        hostname: caps.hostname,
        form: { supported: false, reason: 'Content script unreachable' },
        images: { supported: false, reason: 'Content script unreachable' },
      };
    }
  }

  chrome.runtime.sendMessage({
    action: 'PAGE_DETECTED',
    detection,
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
  }).catch(() => {
    // No side panel listening - fine.
  });
}

chrome.tabs.onActivated.addListener(broadcastPageDetection);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  // Only on navigation completion, not every title tick.
  if (changeInfo.status === 'complete') broadcastPageDetection();
});

// ── Verify API ───────────────────────────────────────────────────────

async function callVerifyApi(surveyNumber, formItems, surveyType) {
  const payload = { survey_no: surveyNumber, survey_type: surveyType || '', data: formItems };

  const res = await fetch(VERIFY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`API returned ${res.status}: ${text.substring(0, 300)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error('API response was not valid JSON');
  }

  // { result_id, answers: [...] }. Legacy shapes are tolerated.
  const answers = Array.isArray(data) ? data : (data.answers || data.data || []);
  if (!Array.isArray(answers)) {
    throw new Error('API response missing answers array');
  }

  const resultId =
    (data && typeof data === 'object' && !Array.isArray(data))
      ? (data.result_id || data.resultId || '')
      : '';

  return { resultId, answers, raw: data };
}

// ── Feedback API ─────────────────────────────────────────────────────

async function callFeedbackApi(payload) {
  let res;
  try {
    res = await fetch(FEEDBACK_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, status: 0, detail: err.message || 'Network request failed' };
  }

  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch (_) { body = { detail: text }; }
  }

  if (res.ok) return { ok: true, status: res.status, raw: body };
  return {
    ok: false,
    status: res.status,
    detail: (body && body.detail) || `HTTP ${res.status}`,
    raw: body,
  };
}

// ── Knowledge-base API (cover, General Information) ─────────────────
//
// Saves or rejects with a structured `detail`. Rejections are returned, not
// thrown, so the side panel can show the backend's own message.

async function callKnowledgeBaseApi(surveyNumber, pageType, data) {
  const payload = {
    survey_no: surveyNumber,
    page_type: pageType || '',
    data: data || {},
  };

  let res;
  try {
    res = await fetch(KB_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, status: 0, kind: 'network', detail: err.message || 'Network request failed' };
  }

  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch (_) { body = { detail: text }; }
  }

  if (res.ok) {
    return {
      ok: true,
      status: res.status,
      kind: 'saved',
      saved: (body && body.status) || 'saved',
      survey_no: (body && body.survey_no) || surveyNumber,
      page_type: (body && body.page_type) || pageType,
      raw: body,
    };
  }

  return {
    ok: false,
    status: res.status,
    kind: res.status === 404 ? 'not_found' : (res.status === 400 ? 'invalid' : 'error'),
    detail: (body && body.detail) || `HTTP ${res.status}`,
    raw: body,
  };
}

// ── Feedback delivery alarm ──────────────────────────────────────────
//
// One minute is MV3's floor for a packed extension. The draft lives in
// chrome.storage.local, so the worker dying between alarms is fine.

const FEEDBACK_ALARM = 'feedback-flush';

function ensureFeedbackAlarm() {
  try {
    chrome.alarms.get(FEEDBACK_ALARM, (existing) => {
      if (!existing) {
        chrome.alarms.create(FEEDBACK_ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
      }
    });
  } catch (err) {
    console.warn('[NATSR] Could not schedule feedback alarm:', err);
  }
}

ensureFeedbackAlarm();
chrome.runtime.onStartup.addListener(ensureFeedbackAlarm);
chrome.runtime.onInstalled.addListener(ensureFeedbackAlarm);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== FEEDBACK_ALARM) return;
  flushFeedbackDraft('auto_alarm').catch((err) => {
    console.warn('[NATSR] Feedback draft flush failed:', err);
  });
});

// ── Feedback safety net ──────────────────────────────────────────────
//
// Same design as NSR (CONTEXT.md §11): the review is saved as a draft on
// every decision and delivered here even if Send Feedback is never clicked,
// enriched by re-reading the live form for ground truth.

let feedbackFlushing = false;

/**
 * Re-scrape the form the draft belongs to. Null when the tab is gone or has
 * moved to another page - the payload then says so instead of guessing.
 * Compared by page key, not raw URL: contextID changes between visits.
 */
async function scrapeForGroundTruth(draft) {
  if (typeof draft.tabId !== 'number') return null;
  try {
    const tab = await chrome.tabs.get(draft.tabId).catch(() => null);
    if (!tab || !tab.url) return null;
    if (draft.pageKey && !self.NSR_FORMS.samePage(tab.url, draft.pageKey)) return null;

    const scraped = await sendToTab(tab.id, tab.url, { action: 'SCRAPE' });
    if (!scraped?.success || !Array.isArray(scraped.items)) return null;
    return scraped.items;
  } catch (_) {
    return null;
  }
}

async function flushFeedbackDraft(trigger) {
  if (feedbackFlushing) return { skipped: 'in-flight' };

  const draft = await self.NSR_FEEDBACK.getDraft();
  if (!draft || !draft.payload || !Array.isArray(draft.payload.feedback) || !draft.payload.feedback.length) {
    return { skipped: 'empty' };
  }

  feedbackFlushing = true;
  try {
    const items = await scrapeForGroundTruth(draft);
    let payload = self.NSR_FEEDBACK.enrichWithGroundTruth(draft.payload, items);
    payload = self.NSR_FEEDBACK.stampProvenance(payload, {
      trigger: trigger || draft.trigger || 'auto',
      reviewedCount: draft.reviewedCount,
      totalCount: draft.totalCount,
    });

    const result = await callFeedbackApi(payload);
    if (result.ok) {
      await self.NSR_FEEDBACK.clearDraft();
    }
    // On failure the draft stays for the next alarm. A late review beats a
    // lost one.
    return result;
  } finally {
    feedbackFlushing = false;
  }
}

// ── Message router ──────────────────────────────────────────────────

function progress(msg, fields) {
  chrome.runtime.sendMessage({
    action: 'PIPELINE_PROGRESS',
    autopilot: !!msg.autopilot,
    ...fields,
  }).catch(() => { });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── Feedback draft / safety net ──────────────────────────────────
  if (msg.action === 'FEEDBACK_DRAFT') {
    self.NSR_FEEDBACK.saveDraft(msg.draft || {})
      .then((ok) => sendResponse({ ok }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.action === 'FEEDBACK_FLUSH') {
    flushFeedbackDraft(msg.trigger || 'auto')
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.action === 'FEEDBACK_CLEAR') {
    self.NSR_FEEDBACK.clearDraft()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // ── Page-detection request ───────────────────────────────────────
  if (msg.action === 'REQUEST_DETECTION') {
    broadcastPageDetection();
    sendResponse({ ok: true });
    return false;
  }

  // ── Sync pipeline ────────────────────────────────────────────────
  // The Sync button pins the tab it was pressed on; autopilot pins the
  // background tab it opened and tags its progress (`autopilot`) so the panel
  // keeps it off the Sync ring.
  if (msg.action === 'SCRAPE_AND_VERIFY') {
    (async () => {
      try {
        const tab = await resolveTargetTab(msg);

        const detection = await sendToTab(tab.id, tab.url, { action: 'DETECT_FORM' });
        if (!detection?.supported) {
          throw new Error(`Unsupported page: ${detection?.reason || 'unknown'}`);
        }

        progress(msg, { stage: 'scraping', progress: 15, message: 'Reading form…' });

        const scraped = await sendToTab(tab.id, tab.url, { action: 'SCRAPE' });
        if (!scraped?.success) throw new Error(scraped?.error || 'Scrape failed');

        const flow = scraped.flow || (detection.form && detection.form.flow) || 'verify';

        // ── Knowledge base only (General Information) ─────────────
        if (flow === 'knowledge_base') {
          const pageType = scraped.pageType || (detection.form && detection.form.pageType) || '';

          progress(msg, { stage: 'uploading', progress: 55, message: 'Processing...', stats: scraped.stats });

          const kbResult = await callKnowledgeBaseApi(scraped.surveyNumber, pageType, scraped.kbData || {});

          sendResponse({
            success: true,
            form: detection.form,
            flow,
            kind: scraped.kind,
            pageType,
            surveyNumber: scraped.surveyNumber,
            stats: scraped.stats,
            kbResult,
          });
          return;
        }

        // ── Cover to the knowledge base, THEN verify ──────────────
        //   Orarius Underwriting Exterior: the inspection comments are
        //   saved as the cover, then the questions are verified. If the
        //   cover save fails the verify call never runs, exactly as NSR's
        //   chained flow does.
        if (flow === 'kb_then_verify') {
          const pageType = scraped.pageType || (detection.form && detection.form.pageType) || 'cover';

          progress(msg, {
            stage: 'uploading',
            progress: 40,
            message: 'Saving inspection comments to SmartFill…',
            stats: scraped.coverStats,
          });

          const kbResult = await callKnowledgeBaseApi(scraped.surveyNumber, pageType, scraped.kbData || {});

          if (!kbResult.ok) {
            sendResponse({
              success: true,
              form: detection.form,
              flow,
              kind: scraped.kind,
              pageType,
              surveyNumber: scraped.surveyNumber,
              stats: scraped.coverStats,
              coverFailed: true,
              kbResult,
            });
            return;
          }

          progress(msg, {
            stage: 'uploading',
            progress: 70,
            message: 'Comments saved · verifying form…',
            stats: scraped.stats,
          });

          const verifyResult = await callVerifyApi(scraped.surveyNumber, scraped.items, scraped.surveyType);

          progress(msg, { stage: 'analyzing', progress: 90, message: 'Matching AI answers to questions…' });

          sendResponse({
            success: true,
            form: detection.form,
            flow,
            kind: scraped.kind,
            surveyNumber: scraped.surveyNumber,
            surveyType: scraped.surveyType,
            pageType,
            kbResult,
            extracted: { sections: scraped.sections, stats: scraped.stats },
            aiAnswers: verifyResult.answers,
            resultId: verifyResult.resultId,
          });
          return;
        }

        // ── Verify only ───────────────────────────────────────────
        progress(msg, { stage: 'uploading', progress: 55, message: 'Processing...', stats: scraped.stats });

        const verifyResult = await callVerifyApi(scraped.surveyNumber, scraped.items, scraped.surveyType);

        progress(msg, { stage: 'analyzing', progress: 90, message: 'Matching AI answers to questions…' });

        sendResponse({
          success: true,
          form: detection.form,
          flow,
          kind: scraped.kind,
          surveyNumber: scraped.surveyNumber,
          surveyType: scraped.surveyType,
          extracted: { sections: scraped.sections, stats: scraped.stats },
          aiAnswers: verifyResult.answers,
          resultId: verifyResult.resultId,
        });
      } catch (err) {
        console.error('[NATSR] Sync pipeline failed:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // async
  }

  // ── Send feedback ────────────────────────────────────────────────
  if (msg.action === 'SEND_FEEDBACK') {
    (async () => {
      try {
        sendResponse(await callFeedbackApi(msg.payload || {}));
      } catch (err) {
        sendResponse({ ok: false, status: 0, detail: err.message || 'Unknown error' });
      }
    })();
    return true; // async
  }

  // ── Per-tab pass-through actions ─────────────────────────────────
  const PASS_THROUGH = [
    // Form
    'APPLY_ANSWER',
    'REVERT_ANSWER',
    'FOCUS_QUESTION',
    'SCRAPE',
    'GET_MODE',
    'DETECT_FORM',
    'DETECT_PAGE',
    // Autopilot: the survey's page URLs from the left-hand Forms list
    'GET_SURVEY_PAGES',
    // Order/Edit Photos dialog
    'OPEN_PHOTO_PANEL',
    'PHOTO_PANEL_STATE',
    'EXTRACT_IMAGES',
    'APPLY_API_RESULTS',
    'RESTORE_IMAGES',
    'FETCH_IMAGE_BLOB',
    'FOCUS_IMAGE',
    'SET_IMAGE_LABEL',
    'SET_IMAGE_LABELS_BULK',
    // On-page image modal
    'SHOW_IMAGE_MODAL',
    'PREFETCH_IMAGES',
  ];
  if (PASS_THROUGH.includes(msg.action)) {
    (async () => {
      try {
        const tab = await resolveTargetTab(msg);
        sendResponse(await sendToTab(tab.id, tab.url, msg));
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  return false;
});

console.log('[NATSR] Service worker loaded');

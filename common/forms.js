/**
 * common/forms.js - page capability registry for NatsrUnified.
 *
 * NatsrUnified (natsrunified.losscontrol360.com) is the same LossControl360 v2
 * platform as BoostUSA: ASP.NET MVC with the client-side DynForms engine. So
 * this registry follows the NSR-Boost model, not the old NSR one:
 *
 *   - `inspectionFormID` in the URL is per-inspection, not per-form-definition,
 *     so a form is identified by its title plus a signature of its main
 *     section headings, never by a hard-coded GUID.
 *   - the survey type is read off the engine
 *     (formInfo.inspectionInfo.inspectionType), or from the "Survey Type" row
 *     on General Information, which has no engine.
 *
 * Entries use the NSR field name `caseTypes` (not NSR-Boost's `surveyTypes`)
 * because the side panel came from NSR and groups its supported-forms list by
 * `caseTypes`. Everything here reads the same key, so there is only one.
 *
 * Loaded in the content script (window.NSR_FORMS), the service worker
 * (self.NSR_FORMS) and the side panel.
 */

(function () {
  'use strict';

  // Exact strings the platform reports. Verified live on 2026-11-09:
  //   survey 2741 - "Exterior Homeowner New Business"
  //   survey 2721 - "Renewal Request"
  // Both belong to the Orarius Underwriting division and both carry the same
  // single form, "Orarius Underwriting Exterior".
  const CASE_TYPES = {
    EXTERIOR_HOMEOWNER_NEW_BUSINESS: 'Exterior Homeowner New Business',
    RENEWAL_REQUEST: 'Renewal Request',
  };

  const ORARIUS_CASE_TYPES = [
    CASE_TYPES.EXTERIOR_HOMEOWNER_NEW_BUSINESS,
    CASE_TYPES.RENEWAL_REQUEST,
  ];

  // Every supported type, as one readable string for the "not supported" copy.
  const SUPPORTED_SURVEY_LABEL = Object.values(CASE_TYPES).join(' / ');

  /**
   * SUPPORTED_FORMS entry shape (same meaning as NSR's registry):
   *
   *   formId           stable id
   *   name             display name
   *   titleHint        substring matched against the form title
   *   flow             verify | knowledge_base | kb_then_verify
   *   pageType         cover | general, for the knowledge-base call
   *   kind             form | generic_fields
   *   caseTypes        survey types the entry applies to
   *   sectionSignature main-section headings that must all be present
   *   coverFields      (kb_then_verify) cover questions sent to the knowledge
   *                    base. Plain string, or { match, key } when the backend
   *                    key differs from the on-page label. These questions are
   *                    taken OUT of the verify leg - they are the inspector's
   *                    own narrative, not something the AI should answer.
   *   genericFields    (generic_fields) General Information rows to send
   */
  // Cover field used for forms the registry has no entry for. If a form has a
  // question labelled "Inspection comments...", it is saved to the knowledge
  // base first (same as Orarius); if it has none, the form is plain verify.
  // To use another label for other forms, add it here.
  const DEFAULT_COVER_FIELDS = [
    { match: 'Inspection comments', key: 'Inspection Comments' },
  ];

  const SUPPORTED_FORMS = [
    {
      // The one form these survey types carry. It holds the cover narrative
      // and the questions on a single page:
      //
      //   Survey comments              Inspection comments / Special
      //                                instructions comments (textarea),
      //                                Opinion of Risk (radio)
      //   Dwelling Information         construction, roof, finish, garages...
      //   Overall Premise Observations access, housekeeping, nuisances,
      //                                animals, protection, water, perils
      //
      // So it runs the chained flow NSR uses for the Condos Dual form: the
      // inspection comments are saved to the knowledge base as the cover, then
      // the remaining questions go to /verify-direct. One button does both.
      formId: 'orarius-underwriting-exterior',
      name: 'Orarius Underwriting Exterior',
      shortName: 'Orarius Exterior',
      titleHint: 'Orarius Underwriting Exterior',
      flow: 'kb_then_verify',
      pageType: 'cover',
      kind: 'form',
      // On-page label: "Inspection comments / Special instructions comments:".
      // Emitted under "Inspection Comments", the key NSR already sends for the
      // Brownstone cover's inspection comments.
      coverFields: [
        { match: 'Inspection comments', key: 'Inspection Comments' },
      ],
    },

    {
      // Not a DynForms page - a plain server-rendered detail view, read by
      // content/generalinfo.js. Its "Extra Info" panel is empty for this
      // division, so the knowledge-base payload is the address only (the same
      // address-only shape NSR sends for Brownstone, Condos and Abbreviated).
      // The row is labelled "Address to be Surveyed"; generalinfo.js emits it
      // under the backend key "Address".
      formId: 'orarius-general-information',
      name: 'General Information',
      shortName: 'General Information',
      titleHint: 'General Information',
      flow: 'knowledge_base',
      pageType: 'general',
      kind: 'generic_fields',
      isGeneralInfo: true,
      genericFields: ['Address to be Surveyed'],
    },
  ];

  // ── Autopilot ──────────────────────────────────────────────────────
  //
  // Survey types listed here run without a click: the first time the side
  // panel sees any page of such a survey it works through these steps, each in
  // a background tab beside the survey tab. See sidepanel.js section 6b.
  //
  //   nav   exact text of the survey's left-hand link to open for the step
  //   step  'photos' (describe the photos) or 'sync' (SCRAPE_AND_VERIFY)
  //
  // Order Photos is not a page on this platform - it is the Order/Edit Photos
  // dialog, which exists on every page of the survey. The photos step opens
  // General Information (the lightest page, no form engine), opens that dialog
  // there, reads it, and closes the tab without saving anything.
  //
  // Order follows NSR: photos, general, then the form, so the photo pass and
  // the knowledge-base saves are on the backend before questions are answered.
  // The form step is the chained flow, so it saves the inspection comments and
  // then fetches the AI answers in one go.
  const ORARIUS_AUTOPILOT = {
    steps: [
      { id: 'photos', label: 'Order Photos', nav: 'General Information', step: 'photos' },
      { id: 'general', label: 'General Information', nav: 'General Information', step: 'sync' },
      { id: 'verify', label: 'Orarius Underwriting Exterior', nav: 'Orarius Underwriting Exterior', step: 'sync' },
    ],
  };

  const AUTOPILOT = {
    [CASE_TYPES.EXTERIOR_HOMEOWNER_NEW_BUSINESS]: ORARIUS_AUTOPILOT,
    [CASE_TYPES.RENEWAL_REQUEST]: ORARIUS_AUTOPILOT,
  };

  // ── Helpers ────────────────────────────────────────────────────────

  function normalize(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  // Any survey type gets the same plan; the known types are only listed above
  // for reference.
  function autopilotFor(caseTypeName) {
    return AUTOPILOT[normalize(caseTypeName)] || ORARIUS_AUTOPILOT;
  }

  const NATSR_HOST = 'natsrunified.losscontrol360.com';

  /** Could this hostname host a NatsrUnified inspection page at all? */
  function isNatsrHost(hostname) {
    return hostname === NATSR_HOST;
  }

  /**
   * Every survey type is supported. The type is still read and sent to the
   * backend verbatim, but it no longer gates anything - a blank or unfamiliar
   * type is accepted.
   */
  function isSupportedSurveyType(_surveyType) {
    return true;
  }

  /** Registry entries are no longer tied to a survey type. */
  function appliesToCaseType(_form, _surveyType) {
    return true;
  }

  /**
   * A form the registry has no entry for. Runs the plain verify flow: every
   * visible question goes to /verify-direct, nothing is split off as a cover.
   */
  function genericFormEntry(title) {
    const name = normalize(title) || 'Form';
    return {
      formId: 'generic-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      name,
      shortName: name,
      titleHint: name,
      flow: 'verify',
      pageType: '',
      kind: 'form',
      coverFields: DEFAULT_COVER_FIELDS,
      generic: true,
    };
  }

  /**
   * Match a DynForms form. Any form the engine has open is accepted - there
   * is no survey-type, title or section-signature gate any more.
   *
   * A registry entry whose titleHint appears in the form title still wins, so
   * forms with special handling (the Orarius cover/comments split) keep it.
   * Anything else gets a generic verify-flow entry.
   *
   * Returns { form, matched: true }, or null when the page has no form title.
   */
  function matchForm(title, _mainSections, _surveyType) {
    const t = normalize(title).toLowerCase();
    if (!t) return null;

    for (const form of SUPPORTED_FORMS) {
      if (form.isGeneralInfo) continue; // GI has no engine; content.js handles it
      const hint = normalize(form.titleHint).toLowerCase();
      if (hint && t.includes(hint)) return { form, matched: true };
    }
    return { form: genericFormEntry(title), matched: true };
  }

  /** The General Information entry, whatever the survey type. */
  function generalInfoFor(_surveyType) {
    return SUPPORTED_FORMS.find((f) => f.isGeneralInfo) || null;
  }

  /**
   * Host-level capability check for the service worker. URL only - no DOM,
   * since this also runs in the worker. Form, General Information and the
   * Order/Edit Photos dialog all live under /Inspection/.
   */
  function capabilitiesForUrl(url) {
    let hostname = '';
    let pathname = '';
    try {
      const u = new URL(url);
      hostname = u.hostname;
      pathname = u.pathname;
    } catch (_) {
      return { hostname: '', form: false, images: false };
    }

    const onInspection = isNatsrHost(hostname) && /^\/Inspection(\/|$)/i.test(pathname);
    return { hostname, form: onInspection, images: onInspection };
  }

  /**
   * Stable identity for a page, for "is this still the page the operation
   * started on?" checks.
   *
   * A raw URL string will not do: `contextID` changes between visits to the
   * same form and query parameters do not come back in a stable order. What
   * identifies a page is the origin, the path (which carries the inspection
   * GUID) and `inspectionFormID` (the form open in it). GUIDs are lower-cased
   * because the platform's own links mix their casing.
   */
  function pageKeyOf(url) {
    try {
      const u = new URL(String(url));
      let formId = '';
      for (const [k, v] of u.searchParams) {
        if (k.toLowerCase() === 'inspectionformid') { formId = v.toLowerCase(); break; }
      }
      return `${u.origin}${u.pathname.replace(/\/+$/, '').toLowerCase()}${formId ? `#${formId}` : ''}`;
    } catch (_) {
      return String(url == null ? '' : url).trim();
    }
  }

  /** Do two URLs point at the same page? Empty input never matches. */
  function samePage(a, b) {
    if (!a || !b) return false;
    return pageKeyOf(a) === pageKeyOf(b);
  }

  /**
   * The inspection GUID out of a NatsrUnified URL. It sits in the path, not a
   * query parameter:
   *   /Inspection/<guid>                         General Information
   *   /Inspection/Form/<guid>?inspectionFormID=  a form
   *   /Inspection/AttachFiles/<guid>             Attach Files
   */
  function inspectionIdOf(url) {
    const m = String(url || '').match(
      /\/Inspection\/(?:[A-Za-z]+\/)?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/i
    );
    return m ? m[1].toLowerCase() : '';
  }

  const api = {
    CASE_TYPES,
    SUPPORTED_SURVEY_LABEL,
    SUPPORTED_FORMS,
    AUTOPILOT,
    autopilotFor,
    isNatsrHost,
    isSupportedSurveyType,
    appliesToCaseType,
    genericFormEntry,
    matchForm,
    generalInfoFor,
    normalize,
    capabilitiesForUrl,
    pageKeyOf,
    samePage,
    inspectionIdOf,
  };

  if (typeof window !== 'undefined') window.NSR_FORMS = api;
  else if (typeof self !== 'undefined') self.NSR_FORMS = api;
})();

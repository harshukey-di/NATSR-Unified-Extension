/**
 * content/generalinfo.js - General Information page extractor.
 *
 * The GI page is *not* a DynForms page - it is a plain server-rendered detail
 * view, so this runs entirely in the isolated world with no bridge involved.
 * `LC360Forms.getLoadedFormInstance()` throws on this page, so everything the
 * extension needs here comes off the DOM.
 *
 * Layout is a flat sequence of label/value siblings:
 *
 *   <div class="ri ri-l"><p><label>Survey Type</label></p></div>
 *   <div class="ri">Exterior Homeowner New Business</div>
 *
 * Taken from NSR-Boost. Re-checked on NatsrUnified survey 2741 (2026-11-09):
 * the .ri.ri-l grid carries Survey Type, Survey Number and "Address to be
 * Surveyed:"; the "Extra Info" panel (#genFieldSection) exists but is empty
 * for the Orarius Underwriting division.
 *
 * Public API: window.NSR_GENERALINFO
 *   isGeneralInfoPage()        → bool
 *   readPairs()                → { [label]: value }
 *   extractFields(whitelist)   → { [backendKey]: value } for the registry list
 *   surveyType()               → the "Survey Type" value ('' when absent)
 *   surveyNumber()             → the "Survey Number" value
 *   headerSurveyNumber()       → the survey number from the page banner,
 *                                which exists on every inspection page
 *   addressGeocode()           → { latitude, longitude } from the address
 *                                cell's geocode trailer, or null
 */

(() => {
  if (window.__NATSR_GI__) return;
  window.__NATSR_GI__ = true;

  /**
   * On-page labels whose backend key differs. NSR's "Address to be Inspected"
   * is "Address to be Surveyed" on LC360 v2; both go out as plain "Address".
   */
  const BACKEND_KEYS = {
    'Address to be Surveyed': 'Address',
    'Address to be Inspected': 'Address',
  };

  const GEOCODE_RE = /,?\s*(Latitude|Longitude|Match)\s*:\s*[^,]*/gi;

  function clean(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/\s*:\s*$/, '').trim();
  }

  /**
   * Multi-line values (addresses) are separated by <br>, which would collapse
   * into "24-28 South Lake DriveLong Branch, NJ" without this. Breaks become
   * line ends, lines are joined with ", ", and doubled commas from lines that
   * already end in one are folded.
   */
  function readLines(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    clone.querySelectorAll('p, div').forEach((blk) => blk.append('\n'));
    return clone.textContent
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim().replace(/^,\s*|\s*,$/g, ''))
      .filter(Boolean);
  }

  function readValue(el) {
    return stripGeocode(readLines(el).join(', '));
  }

  /**
   * The address row carries a geocoding trailer:
   *   "24-28 South Lake Drive, Long Branch, NJ, 07740, US, Monmouth,
   *    Latitude: 40.27596, Longitude: -73.98736, Match: Rooftop"
   * The backend and the address block want the postal address only.
   */
  function stripGeocode(value) {
    return value
      .replace(GEOCODE_RE, '')
      .replace(/\s*,\s*$/, '')
      .trim();
  }

  function isGeneralInfoPage() {
    return document.querySelectorAll('.ri.ri-l').length > 0
        && !document.querySelector('.dyn-mainform');
  }

  /** Every label cell of the survey grid, with its value cell. */
  function gridRows() {
    const rows = [];
    document.querySelectorAll('.ri.ri-l').forEach((labelEl) => {
      const valueEl = labelEl.nextElementSibling;
      if (!valueEl || !valueEl.classList.contains('ri')) return;
      rows.push({ label: clean(labelEl.textContent), valueEl });
    });
    return rows;
  }

  /**
   * All label → value pairs on the page. Earlier entries win, so the survey
   * grid beats Extra Info on any shared label.
   *
   *   .ri.ri-l  → .ri              the survey detail grid
   *   #genFieldSection
   *   .genFieldR.genFieldR-l
   *             → .genFieldR       the "Extra Info" panel (empty for Orarius
   *                                today, read anyway so a tenant change
   *                                flows through)
   */
  function readPairs() {
    const out = {};

    const add = (label, valueEl) => {
      if (!label || !valueEl) return;
      if (Object.prototype.hasOwnProperty.call(out, label)) return;
      out[label] = readValue(valueEl);
    };

    gridRows().forEach((r) => add(r.label, r.valueEl));

    // Extra Info. Section-header divs can sit between rows, so scan forward
    // for the value rather than trusting nextElementSibling - and stop at the
    // next label so a field with no value cell cannot borrow the next row's.
    document.querySelectorAll('#genFieldSection .genFieldR.genFieldR-l').forEach((labelEl) => {
      let el = labelEl.nextElementSibling;
      while (el && !el.classList.contains('genFieldR')) el = el.nextElementSibling;
      if (!el || el.classList.contains('genFieldR-l')) return;
      add(clean(labelEl.textContent), el);
    });

    return out;
  }

  /**
   * Project the page down to the whitelist a registry entry carries.
   * Case-insensitive prefix match, same rule as NSR.
   */
  function extractFields(whitelist) {
    const pairs = readPairs();
    if (!Array.isArray(whitelist) || !whitelist.length) return pairs;

    const out = {};
    for (const want of whitelist) {
      const wantLower = clean(want).toLowerCase();
      const hit = Object.keys(pairs).find((label) => label.toLowerCase().startsWith(wantLower));
      if (!hit) continue;
      out[BACKEND_KEYS[hit] || hit] = pairs[hit];
    }
    return out;
  }

  /**
   * The platform's own geocode for the risk, read from the address cell's
   * trailer ("Latitude: 40.27596 Longitude: -73.98736"). GI has no engine to
   * read `latitudeLongitude` from, and coordinates pin the building in Google
   * Maps where a text search can land on the wrong match.
   */
  function addressGeocode() {
    const row = gridRows().find((r) => /^address to be (surveyed|inspected)/i.test(r.label));
    if (!row) return null;
    const text = row.valueEl.textContent || '';
    const lat = text.match(/Latitude\s*:\s*(-?\d+(?:\.\d+)?)/i);
    const lng = text.match(/Longitude\s*:\s*(-?\d+(?:\.\d+)?)/i);
    if (!lat || !lng) return null;
    const latitude = Number(lat[1]);
    const longitude = Number(lng[1]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return { latitude, longitude };
  }

  /**
   * The survey number out of the page banner. `#mainFormTabHeader` is rendered
   * on every inspection page (General Information and each form) and carries
   * "Policy: <policy> Survey # :<number>". Sibling elements run together under
   * textContent, so the pattern anchors on its own label.
   */
  function headerSurveyNumber() {
    const header = document.querySelector('#mainFormTabHeader');
    if (!header) return '';
    const match = header.textContent.match(/Survey\s*#\s*:?\s*(\d+)/i);
    return match ? match[1] : '';
  }

  function lookup(label) {
    const pairs = readPairs();
    const wanted = clean(label).toLowerCase();
    const hit = Object.keys(pairs).find((k) => k.toLowerCase() === wanted);
    return hit ? pairs[hit] : '';
  }

  window.NSR_GENERALINFO = {
    isGeneralInfoPage,
    readPairs,
    extractFields,
    surveyType: () => lookup('Survey Type'),
    surveyNumber: () => lookup('Survey Number'),
    headerSurveyNumber,
    addressGeocode,
  };
})();

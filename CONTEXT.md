# NATSR Unified - engineering context

Handoff brief for anyone picking this up cold. Read it before touching code.

**Version 1.0.0** (`manifest.json`). Built 2026-11-09.

## 1. What it is

The NSR side panel (same UI, same backend calls, same autopilot) running on
**natsrunified.losscontrol360.com**, which is the LossControl360 v2 platform -
the same DynForms engine NSR-Boost was written for, not the old ASP.NET site NSR
targets. So the extension is two halves glued together:

| Half | Taken from | Why |
|---|---|---|
| Side panel, results page, photo viewer, feedback, service worker network calls | `NSR` | The UI and calls were asked to match NSR |
| Page layer (`page/`, `content/bridge.js`, `content/generalinfo.js`, `content/imageModal.js`, `content/highlighter.js`) | `NSR-Boost` | Same engine; NSR's DOM scrapers cannot work here |
| `content/content.js`, `common/forms.js`, `background/background.js` | Written for this build | Join the two, plus the chained flow and autopilot hooks |

No sign-in, no licence, no usage tracking - like NSR, unlike NSR-Boost.

Background on the platform (two worlds, engine API, Order/Edit Photos dialog,
traps): `../NSR-Boost/CONTEXT.md` and `../NSR-Boost/docs/PLATFORM-ANALYSIS.md`.
All of it applies here.

## 2. Scope

Survey types (verified live 2026-11-09, Orarius Underwriting division):

| Survey type | Survey checked |
|---|---|
| `Exterior Homeowner New Business` | 2741 |
| `Renewal Request` | 2721 |

Both carry one form, **Orarius Underwriting Exterior**, plus General
Information. Any other survey type is rejected before anything else runs, on
form pages, on General Information and for the photo tools.

### Orarius Underwriting Exterior

Three main sections, 32 controls (TextBox, RadioButtonList, CheckBoxList only):

```
Survey comments                Inspection comments / Special instructions comments (textarea)
                               Opinion of Risk (radio)
Dwelling Information           stories, construction, foundation, roof, finish, garages, ...
Overall Premise Observations   access, housekeeping, nuisances, animals, hydrant, water, perils
```

The page holds the cover narrative and the questions together, so it runs NSR's
**`kb_then_verify`** flow (the one Condos Dual uses): one Sync click

1. saves `{ "Inspection Comments": <text> }` to `/knowledge` with
   `page_type: "cover"`, then
2. only if that succeeded, posts the questions to `/verify-direct`.

The inspection comments question is **taken out of the verify payload**
(`withoutCoverQuestions()` in `content/content.js`). It is the inspector's own
narrative and already goes to the knowledge base, so the AI is not asked to
answer it. Opinion of Risk stays in verify. On survey 2741: 27 visible
questions, 26 sent to verify, 481 characters of comments sent as cover.

### General Information

`knowledge_base`, `page_type: "general"`, **address only** (`{ "Address": … }`) -
the "Extra Info" panel is empty for this division. Same shape NSR sends for
Brownstone / Condos / Abbreviated.

## 3. Backend

Unchanged from NSR, `https://qagent.dhaninfo.ai`, plain `fetch`:

| Endpoint | From | Payload |
|---|---|---|
| `/verify-direct` | worker | `{ survey_no, survey_type, data: items[] }` |
| `/knowledge` | worker | `{ survey_no, page_type, data: {} }` |
| `/feedback` | worker | `{ result_id, feedback: [] }` (+ NSR's ground-truth fields) |
| `/pipeline` | side panel | multipart `data`, `survey_number`, `survey_type`, `files[]` |

Switching to staging: `API_BASE` in `background/background.js` and
`IMAGES_API` in `sidepanel/sidepanel.js`.

`survey_type` goes out verbatim: `Exterior Homeowner New Business` or
`Renewal Request`.

## 4. Autopilot

Same design as NSR (`../NSR/CONTEXT.md` §13); code in `sidepanel.js` section 6b,
plan in `AUTOPILOT` in `common/forms.js`. First detection of any page of a
supported survey starts it; each step opens its page in an inactive tab beside
the survey tab, runs, and closes the tab.

| Step | Opens | Does |
|---|---|---|
| `photos` | General Information | `OPEN_PHOTO_PANEL`, `EXTRACT_IMAGES`, `uploadImagesForReview()` → `/pipeline` |
| `general` | General Information | `SCRAPE_AND_VERIFY` → `/knowledge` general |
| `verify` | Orarius Underwriting Exterior | `SCRAPE_AND_VERIFY` → `/knowledge` cover, then `/verify-direct` |

Results live in `chrome.storage.local['autopilot:<inspection guid>']`, last 3
surveys.

**What differs from NSR, and why:**

- **Order Photos is a dialog, not a page.** Every page of a survey has the ORDER
  button. The photos step clicks it in its background tab (verified: one click,
  6 photos, survey 2721), reads the dialog, and closes the tab. Nothing is
  saved - only "Save Changes to Photos" writes, and nothing clicks it.
- **The "Order Photos" jump button** opens the dialog on the page the survey
  tab is already showing instead of navigating. AI Sort is ready as soon as the
  photos load. "Answers" navigates to the form as in NSR.
- **The viewer's "Show on page"** opens the dialog on any tab of the survey
  (survey tab first) and scrolls to the photo.
- **Waiting for the form.** The engine draws the form after the load event, so
  a sync step polls `DETECT_FORM` (up to 45 s) before scraping. A survey-type
  rejection stops at once.
- **Page identity** is origin + path + `inspectionFormID`, lower-cased
  (`NSR_FORMS.pageKeyOf`). `contextID` changes between visits and GUID casing
  varies, so raw URL compares were wrong on NSR-Boost.
- The record key is the inspection GUID from the URL path
  (`NSR_FORMS.inspectionIdOf`), the counterpart of NSR's `caseID`.

## 5. Things carried over from NSR-Boost's lessons

- `SCRAPE` spreads the extract at the top level. Nesting it made the verify POST
  go out empty on NSR-Boost.
- `CheckBoxList.setValue()` adds ticks; multi-select writes clear first
  (`isMultiSelect()` in the agent).
- Every page-bound side-panel request is pinned to its tab and page
  (`sendPinned` / `sendToPage` / `sendToRunPage`); the worker refuses one whose
  tab has moved (`resolveTargetTab`). This is the main behavioural difference
  from NSR's side panel, which used the active tab.
- A Sync in flight cannot be restarted or have its status overwritten by a tab
  switch (`isPipelineBusy()`).
- The address block shows on form pages too (engine address), and Maps opens
  by the platform's own coordinates when it has them - the engine's
  `latitudeLongitude` on forms, the "Latitude: … Longitude: …" trailer of the GI
  address cell on General Information.

NSR's report review (PDF to `/analyze-pdf`) is **not** in this build; it was
gated on a case type this platform does not have.

## 6. Verified vs not

**Verified live, read-only (2026-11-09):** both survey types and numbers;
form title and the three section headings; `matchForm` → matched,
`kb_then_verify`; the extract (27 questions, hidden rules respected); the cover
dict and the verify payload without the comments; engine address and
coordinates; left-hand link lookup for both autopilot pages; General
Information type / number / address / coordinates; ORDER opening the dialog
with every tile, its photo ids and labels; full-size image fetch (200, JPEG).
The registry was also unit-tested under Node (page keys, ids, gates).

These checks ran the extension's own functions on the live pages from the
browser console. **The extension itself has not been loaded unpacked and
clicked through yet**, and no backend call has been made - nothing was posted
to the QA Agent.

**Not verified:**
- Whether the backend has a configuration for these two `survey_type` values
  on `/verify-direct` and `/pipeline`.
- Whether the backend wants the cover key `Inspection Comments` for these
  types (it is the key NSR sends for Brownstone).
- Writing answers (Accept) on this tenant. The agent's `setValue` path is
  NSR-Boost's, verified there on an editable form; survey 2741 rendered
  editable (105 inputs), but no write was attempted here.
- Autopilot end to end in background tabs.

## 7. Debugging

Logs are prefixed `[NATSR]`. On a survey page, in DevTools:

```js
// what the engine agent reads (page world)
copy(JSON.stringify(window.__NATSR_ACTIONS__.context(), null, 2))
```

Stored autopilot run: side panel DevTools →
`chrome.storage.local.get(null).then(console.log)`.

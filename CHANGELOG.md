# NATSR Unified Extension: change log

Major changes only.

---

## 1. Any form and any survey type

Before, only two survey types ("Exterior Homeowner New Business" and "Renewal
Request") and forms matching a known title and section headings were accepted.

- The survey-type check is gone: every survey type is accepted, including a blank
  one. The type is still read and sent to the backend.
- Form matching no longer needs a known title or section headings. Any open form
  runs the standard verify flow, where every visible question goes to
  `/verify-direct`.
- "Orarius Underwriting Exterior" keeps its special handling.
- General Information works for every survey type.
- "Unsupported page" now appears only when no form is open.
- Changed in `common/forms.js`, `sidepanel/sidepanel.js` and the README.

## 2. Autopilot fix for lowercase survey URLs

Autopilot stayed on "Waiting" because the survey URL is `/inspection/<id>` in
lowercase, and the code only matched `/Inspection/`. The survey ID came back
empty, so autopilot never started.

- The ID matching is now case-insensitive (`common/forms.js`, `viewer/viewer.js`).
- `manifest.json` now matches both `/Inspection/*` and `/inspection/*`.

## 3. Inspection comments saved first on any form

A form with a question labelled "Inspection comments…" now saves it to
`/knowledge` first and then verifies the remaining questions, the same as
Orarius. Forms without that question run plain verify. The label is set in
`DEFAULT_COVER_FIELDS` in `common/forms.js`.

## 4. Autopilot's form step only for the Orarius form

Autopilot's third step now appears only when the survey has an "Orarius
Underwriting Exterior" form, and is labelled with that name. Before a run it
shows only if the open page is an Orarius form. After a run it stays only if the
survey has the Orarius link. The Answers button is hidden when there is no such
step.

## 5. Autopilot on/off switch

- New switch on the Config tab: "Run autopilot automatically". It is on by
  default and the choice is saved.
- When off, autopilot does not start by itself. The card reads "Off. Press Run
  now to run it." and the button runs it once on request.
- Saved results and manual Sync still work, and a run already in progress is not
  stopped.

## 6. CrossCover price quote in the side panel

- General Information pages for CrossCover surveys show a "Price quote" block
  with a "Get quote" button. The quote is fetched on click, because each one runs
  a live address search (up to about a minute).
- The panel sends the Customer, Inspection Type Category, Survey Type and
  Address read from the page.
- A result with `status: ok` shows the total, base price, restaurants at $75 each,
  the $500 cap if applied, and the quote number. Any other result shows "Needs
  manual review" with the API's notes.
- The extension calls `/lms/pricing/price-quote` on the backend directly, with
  no key in the extension. This works once the backend owner removes the key
  requirement on that route, which they are doing.
- Changed in `content/generalinfo.js`, `content/content.js`, `background/background.js`,
  `sidepanel/sidepanel.html`, `sidepanel/sidepanel.css` and `sidepanel/sidepanel.js`.

---

## Notes

- Not changed: autopilot starting from pages with no form open, cleanup of old
  survey-type code, the hard-coded "v 4.2.0" footer, and `CONTEXT.md`, which
  still describes the old two-form scope.

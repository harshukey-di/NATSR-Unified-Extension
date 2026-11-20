# NATSR Unified

Chrome extension (Manifest V3) for **natsrunified.losscontrol360.com**. Same side
panel and workflows as the NSR extension: AI review of a survey's form with an
Accept / Reject queue, knowledge-base saves, AI photo descriptions with AI Sort,
and an autopilot that runs the whole survey on its own.

Engineering notes: [CONTEXT.md](CONTEXT.md).

## Install

1. `chrome://extensions` → turn on **Developer mode**.
2. **Load unpacked** → pick this `NATSRUnified` folder.
3. Reload any NatsrUnified tabs that were already open.
4. Click the toolbar icon to open the side panel.

## Supported surveys

Any survey type and any form works. There is no survey-type, form-name or
section check: a page with an open form runs the standard verify flow, and
General Information saves the address. "Orarius Underwriting Exterior" keeps
its special handling (inspection comments saved first, then the questions).
"Unsupported page" now only appears when a page has no form open.

| Page | Button | What it does |
|---|---|---|
| General Information | Save to SmartFill | Sends the survey address to the knowledge base |
| Orarius Underwriting Exterior | Sync & Verify with AI | Saves the inspection comments to the knowledge base, then sends the questions for AI review |
| Order/Edit Photos panel (ORDER button, any page) | Display Description | Sends the photos for AI descriptions; then AI Sort / Original |

## Autopilot

The first time the panel sees any page of a supported survey it runs, in
background tabs beside yours:

1. **Order Photos** - opens the Order/Edit Photos panel in a background tab,
   gets AI descriptions for every photo, closes the tab. Nothing is saved.
2. **General Information** - saves the address.
3. **Inspection comments + Answers** - saves the comments, then gets the AI
   answers for the questions.

The Autopilot block shows each step's progress. When it is done:

- **Answers** takes the survey tab to the form; the review queue appears at
  once.
- **Order Photos** opens the Order/Edit Photos panel on the page you are on;
  **AI Sort** is ready.
- **View photos ↗** opens every photo with the AI's notes in a separate window.
- **Run again** re-runs the survey.

Closing the side panel stops a run; it picks up again next time the panel
opens on that survey.

## Address

Every page of a survey with an address shows it with **Copy**, **Google** and
**Maps**. Maps opens the platform's own map coordinates when it has them.

## Nothing is written without a click

The extension never saves the survey. Answers reach the form only when you
press Accept, and photo labels / order only change in the open Order/Edit Photos
panel when you use AI Sort - you still press the platform's own save buttons.

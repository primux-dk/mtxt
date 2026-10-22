# Behaviour rules

How the app behaves, not how it looks. Source: Kristian's guide "Når AI bygger en app: Designfælder du skal fange" (kristianprimdal.dk/guides/ai-designfaelder, 2026-10-18). Each of its 13 traps is applied to mtxt below. An implementation packet is not done until the rules for its screen hold, and the packet reports which "Prøv selv" checks it ran.

## Protect the work first

**1. Autosave, never a Save button as the safety net.**
The recap editor saves a draft in the background 1.5 s after the last keystroke and writes a version per save. Typing continues during a save. A status word sits in the editor header: "Saving", "Saved", "Not saved". Offline, the editor keeps the text locally and says "Not saved" until the network is back; a reload restores unsaved text. Check: write, cut the network, keep writing, reconnect, reload. The app must not claim "Saved" for text the server never got.

**2. Small changes show at once, with a plan for failure.**
Renaming a speaker, changing visibility, setting the keep flag and ticking a decision are optimistic: the screen changes immediately, the server saves behind. If the server rejects, the screen reverts and says why. A retry must not create a duplicate. Check: make the change fail, confirm the end state is the server's.

**3. Archive is not delete.**
A meeting has "Archive" (leaves the library views, findable under "Archived", can be restored) and "Delete" (permanent). Delete states the consequence before the action: "Delete the meeting, 2 recordings and the recap permanently". Retention deletion is announced in the meeting header a week before ("Deleted on 2026-11-30 · Keep") and the keep flag stops it. A toast with Undo is never the only way back to content that matters; recap versions are, and the archive is.

**4. Two people do not overwrite each other.**
In v1 only the owner edits the recap, renames speakers and changes visibility; shared colleagues read. If the owner has the recap open in two windows, the later save wins and the earlier window shows "Changed elsewhere · Reload". No silent overwrite.

## Let the app remember where you are

**5. A link keeps the view.**
The library puts its state in the URL: `/meetings?view=shared&q=budget&status=ready&sort=date`. Direct links, refresh and Back/Forward all work. A transcript position is shareable: `/meetings/{id}?t=1834` opens the transcript at 30:34 and the player there. Nothing sensitive in the URL, and a shared link is never permission; visibility decides.

**6. Lists have an end and a count.**
The library paginates with a result count ("42 meetings") and a page number in the URL. Returning from a meeting restores the page and scroll position. Loading, failure, result count and end of list are each visible states.

**7. One way of working across screens.**
Search, filters, row actions, selection, loading and error patterns are built once and reused: the library, the keyterms list, the templates list and the audit log all use the same components. A "meeting" is a "meeting" on every screen, never "recording" in one place and "session" in another.

## Make the next step clear

**8. Empty is three different states.**
First use: "No meetings yet" with the two ways to add one, download the recorder or upload a file. No matches: "No meetings match" with "Reset filters". Failed fetch: "Could not load meetings" with "Try again". A failure never looks like an empty account.

**9. An error says what to do.**
Field errors sit at the field, keep what was typed, and are listed at the top with links when there are several (settings page). Upload errors in the recorder say the state and the next step: "Waiting for network · retrying", "Warning: not uploaded for 24 hours · Try now", "The server rejected the file · Contact your admin". A transcription failure on the meeting page says which provider failed and offers "Try again" and "Switch provider" (admin).

**10. One thing per screen asks for attention.**
Each screen has one primary action in the dark button: library "New meeting", meeting page "Save recap" is not a button because autosave, so the primary is "Export"; recorder "Record". Everything else is a secondary or a text button. Badges carry text, not colour alone.

## Test what a screenshot does not show

**11. Keyboard and focus.**
Every control is a real button, link, input or select from the component library. Focus is visible (the sage ring). Dialogs have a title, a close path, trap focus while open and return it to the opener. Status is text as well as colour ("Private", "Shared", "Company"; "Transcribing", "Ready"). Check with the mouse put away and the page at 200 percent zoom.

**12. Motion is short and optional.**
150 ms for state changes, none for list updates, none at all under `prefers-reduced-motion`. Nothing waits for an animation.

**13. Real data breaks pretty layouts.**
Fixtures include a 4-hour meeting, a meeting with 14 speakers, a title of 120 characters, a company name with æ, ø and å, a transcript with no speakers, an empty recap, 2,000 meetings in the library, and a phone width. Truncated text is readable somewhere else.

## Definition of done for a screen

An implementation packet for a screen reports:

- which of rules 1 to 13 apply, and the "Prøv selv" check it ran for each;
- a screenshot at 1280 px and at 390 px on the real build;
- a keyboard-only walk through the screen's main task;
- the three empty states where a list is involved.

A passing test suite is not evidence for any of this. The running app is.

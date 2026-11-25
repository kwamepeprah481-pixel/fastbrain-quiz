# Session Checkpoint

## Current Status (uncommitted, verified locally)

**Verified this session against the real uploaded Science PDF (`uploads/…-scince OBJ.pdf`):**
- All 40 questions extracted with correct lettered options (including Q6 roman-numeral + lettered mixed format).
- Degree symbols fixed: `20°`, `35°`, `60°`, etc. (previously `200`, `350`, `600`).
- No answer key in that PDF, so `a` is `-1` for every question — expected; use Upload & Review to set answers.

**New fixes this session (uncommitted):**

1. **PDF text extraction rewritten with `pdfjs-dist`** — `parsePdf()` no longer uses `pdf-parse`. It reads `getTextContent()` items directly, keeps newlines via `hasEOL`, and passes `standardFontDataUrl` so fonts render correctly. This removes the `standardFontDataUrl` warnings.
2. **Superscript recovery** — Items raised above the baseline with a smaller font size are treated as superscripts: `0` → `°`, `1` → `¹`, `2` → `²`, `3` → `³`, `n` → `ⁿ`. Fixes degrees and `m/s²`.
3. **Repeated number prefixes stripped** — New `stripLeadingNumberPrefix()` loops so `1. 1. Question` (manual number + DOCX list number) becomes `Question`; used by `parseMCQ` and `tryParsePlainOptions`.
4. **`pdfjs-dist` added as a direct dependency** — `^5.4.296` in `package.json` + lockfile.
5. **Test suite + script** — `tests/extraction.test.js` covers DOCX multilevel lists, mixed roman+lettered, flat sequential numbering, answer keys, instruction capture, and bold questions. Run with `npm test`.
6. **Helpers exported for testing** — `module.exports.extractQuestions`, `.htmlToPlainText`, `.parseFile` attached to the router.

**Still-valid prior fixes (already committed):**
- Empty option artifacts skipped; lettered preferred over numbered in mixed format (fcd3aae/92ee714)
- Number prefix stripped even without formatting markers (d15c3ca)
- Stack-based nested `<ol>/<ul>` handling + absorbed-option detection (2bf3901)
- English/cloze instruction + gap fixes (7638bc1)
- Bold markers, formatting preservation, quiz ID collision, "key advisor" fix

## Outstanding / Next Steps

1. **Deploy and re-upload the Science PDF** — confirm 40/40 with degrees (admin edit answers, since source has no key).
2. **Verify English document still works** — Re-upload Tests 1-3 to confirm no regression; use unique IDs (`eng--end-of-term-3-obj-testX-q`).
3. **Upload remaining English tests** (Tests 1-3).
4. **Optionally delete old unprefixed quiz entries** from admin panel.
5. **Re-upload RME document** to verify "key advisor" false positive fix still works.
6. Consider deleting stale root test scripts `test_science.js` / `test_rme_new.js` (superseded by `tests/extraction.test.js`).

## Key File Locations

- `routes/materials.js` — All extraction logic (parseMCQ, parseClozePassage, htmlToPlainText, instruction capture, answer key regex)
- `public/index.html` — `fmt()` renders `**text**`/`__text__`/`*text*` as HTML
- `public/admin.html` — Admin panel, subjectIdFromTitle, showParsedMaterial
- `db.js` — pgify() SQLite→PostgreSQL conversion
- `render.yaml` — Render IaC definition

## Render Info

- Service ID: `srv-d909mjojs32c73d33jg0`
- API Key: `rnd_lXWl5sfiVmxE75Csa8X19v7jFCza`
- Auto-deploys from `main` branch

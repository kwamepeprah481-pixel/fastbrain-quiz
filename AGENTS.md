# Session Checkpoint

## Latest Fixes (Commit `2bf3901` — deployed, 2nd round needed)

**Deployed fixes (commit `2bf3901`):**

1. **`htmlToPlainText` rewritten with stack-based nesting** — Top-level `<li>` → `1.`, nested `<li>` → `a.` (was: all flat numbered). Also emits `\n` before nested `<ol>`/`<ul>` so first option doesn't merge onto question line.
2. **`tryParsePlainOptions` strips number prefixes from question + options** — Now calls `question.replace(/^[\*_]+(?:\s*(?:Question\s*)?\d+[\.\)]\s*)?/, '')` and `opt.replace(/^\d+[\.\)]\s*/, '')`. Also splits absorbed first option when fused onto question line (regex `/([?])(\d+[\.\)]\s+)/`).
3. **`htmlToPlainText` entity decoding** — Added `&deg;` and `&#176;` → `°` for degree symbol.

**Second round fixes (current: uncommitted):**

1. **`parseMCQ` skips empty option texts** — When collecting lettered options (A-D/a-d), empty artifacts like `a.` (bare prefix with no text) are skipped. Stops collecting once 4 non-empty options are found. Fixes Q3, Q4, Q5, Q10 which had empty `a.` artifacts.
2. **`tryParsePlainOptions` prefers lettered over numbered when mixed** — Detects documents where options appear as both flat numbered lines (e.g. `7. Grasshopper`) AND nested lettered lines (e.g. `a. I only`). Picks the lettered options and skips numbered artifacts. Fixes Q6.
3. **`tryParsePlainOptions` strips letter prefix from options** — When taking lettered options from the mixed-format path, strips the `a.`/`b.` prefix so options show as clean text.
4. **Degree symbol hex entity** — Added `&#x?B0;` (hex variant of `&#176;`) to entity decoder.

**Previous 5 fixes for English document extraction (7638bc1):**

1. **`htmlToPlainText` strips list numbering from option lines** — Lines like `1. A. stains` → `A. stains` via regex `/^\d+[\.\)]\s+(?=[A-Da-d][\.\)])/gm`
2. **`parseClozePassage` handles `**` in gap markers** — Regex changed to `/---\**(\d+)\**---/g`; also strips list numbering from option lines before matching
3. **`parseMCQ` instruction filter catches instructions with 4 options** — Removed `options.length !== 4` guard; now catches `from the options`, `choose the`, `for each` anywhere in text when `!hadPrefix && !question.includes('?')`
4. **Line 175 instruction capture expanded** — Same phrase patterns (`choose the`, `from the options`, `for each`, `the correct`, `the suitable`) added alongside start-of-line keyword check
5. **`looksLikeQuestion` updated** — Same expanded patterns added

**Previous fixes (already deployed):**
- Bold markers stripped before number prefix detection in `parseMCQ` (7390e28)
- `<ol>/<li>` handling in `htmlToPlainText` preserves numbering (ba96928)
- Bold/underline/italic formatting preserved from DOCX (4b6f98d)
- Quiz ID collision fixed with subject prefix (dce764f)
- MCQ_ANSWER_RE false positive on "key advisor" fixed (d0a174b)

## What User Was Doing (this session)

- Uploaded a Science .docx with 40 MCQ questions (multilevel list: Qs Level 1, options Level 2)
- Options extracted with number prefixes (1-4) instead of letters (a-d); first option merged onto question line; only 27 of 40 questions found
- Degree symbols (`°`) appearing as `0` (e.g. `20°` → `200`)

## After Deploying 2bf3901 (test results from re-upload)

**Improved but remaining issues:**

1. **Q3, Q4, Q5, Q10** — Show `a. a. a.` as first 3 options (empty artifacts from DOCX multilevel list). Options extracted as `a., a., a. Leaves..., b. Streamline...` instead of correct options.
2. **Q6** — Mixed format: `7. Grasshopper, 8. Housefly, 9. Mosquito` (flat numbered) AND lettered `a. I only, b. I and III only, ...`. Extracted with wrong options (Grasshopper, Housefly, Mosquito, a.).
3. **Q11 onward** — Format B (sequential flat numbering like `11. Question, 12. Option, 13. Option, 14. Option, 15. Option, 16. Next Question`) works correctly via tryParsePlainOptions.
4. **Degree symbols** still appear as `0` (e.g. `20°` → `200`, `60°` → `600`).

## Outstanding / Next Steps

1. **Verify second round fixes** — Re-upload the Science document and confirm:
   - Q3, Q4, Q5, Q10 show correct options (no empty `a.` artifacts)
   - Q6 shows lettered options (I only, I and III only, II and III only, I, II and III) not Grasshopper/Houselly/Mosquito
   - All ~40 questions still extracted correctly
   - Degree symbols display correctly (or manually fix via admin edit)
2. **Verify English document still works** — Re-upload to confirm previous fixes not regressed
3. **Upload remaining English tests** (Tests 1-3) with unique IDs (`eng--end-of-term-3-obj-testX-q`)
4. **Optionally delete old unprefixed quiz entries** from admin panel
5. **Re-upload RME document** to verify "key advisor" false positive fix still works

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

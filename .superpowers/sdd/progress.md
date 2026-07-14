# SDD Progress — 地區主題換皮 + 記念票海報
plan: docs/superpowers/plans/2026-07-14-region-theming-poster.md
model policy: Tasks 0-8 Opus implementers, Task 9 Fable acceptance
NOT a git repo — diffs via /tmp snapshots, no commits.
iCloud fixed via "Keep Downloaded" (B). baseline md5 at /tmp/baseline-render.md5 (21 files).

Task 0: complete (baseline /tmp/baseline-render.md5, 21 files)
Task 1: complete (pipeline/themes.mjs + scripts/check-theme-contrast.mjs, contrast exit 0 all-PASS, review clean)
Task 2: pending
Task 2: complete (render.mjs theme wiring; REGRESSION-OK; review clean)
  MINOR (final-triage): themes.mjs motif strings must stay quote/backslash-free (render.mjs:~1345 emits into single-quoted browser JS; 済 safe today).
Task 3: pending
Task 3: complete (cover poster panel; REGRESSION-OK/BASELINE-CLEAN; review clean)
  MINOR (final-triage): use url.fileURLToPath instead of decodeURIComponent(new URL().pathname) [render.mjs:~1257]; stale dist poster.png not pruned on poster-removal transition [render.mjs:~1600].
Task 4: pending
Task 4: complete (posterPrompt + runPosterAgent 3-tier; gemini untested no key; fixed unknown-backend false-success + mkdir; review SPEC ✅, fix verified)
  CORRECTION(2026-07-14 late): codex CLI ≥0.144 HAS native image-gen — earlier "no image-gen" was an outdated-CLI artifact (0.142.5 → gpt-5.6-luna 400). After `codex update` to 0.144.4, real pipeline runPosterAgent(POSTER_BACKEND=codex) produced a high-quality Kyoto poster in ~100s. codex is now the primary poster backend (no API key); gemini/manual are fallbacks.
  MINOR (final-triage): codex uses --dangerously-bypass-approvals-and-sandbox (moot, always throws); gemini model name gemini-2.5-flash-image untested.
Task 5: pending
Task 5: complete (orchestrator wiring; REGRESSION-OK/BASELINE-CLEAN; MOCK-OK theme=japan+Poster skipped; review SPEC ✅ QUALITY Approved)
  MINOR (final-triage): prune re-parses json for trip_id though byNewest already has it [orchestrator.mjs:~73].
Task 6: pending
Task 5: complete (orchestrator wiring; REGRESSION-OK/BASELINE-CLEAN; MOCK-OK theme=japan poster skipped; review SPEC ✅ QUALITY Approved)
  MINOR (final-triage): prune re-parses json for trip_id though byNewest already has it [orchestrator.mjs:~73].
Task 6: pending
Task 6: complete (PWA precache poster; conditional hash input byte-identical when empty; REGRESSION-OK incl sw.js; review clean no findings)
Task 7: pending
Task 6: complete (PWA precache poster; extraAssets param backward-compat; REGRESSION-OK sw.js byte-identical; fetch/clone untouched; review clean no findings)
Task 7: pending
Task 7: complete (studio.html AGENTS array +Poster Agent, one-line; server.mjs untouched; studio boots shows Poster Agent; controller-accepted, mechanical)
Task 8: pending
Task 7: complete (studio.html AGENTS array +'Poster Agent'; one-line verified; server security untouched; controller-reviewed)
Task 8: pending
Task 8: complete (DESIGN.md 主題註冊表 + poster vocab, HANDOVER bullet; all hex/ratios match code+measured; no placeholders; review SPEC ✅ QUALITY Approved)
Task 9: complete (Fable acceptance ACCEPT; controller re-verified all gates clean: no theme leak, regression byte-identical, contrast exit 0, node --check x5)
Task 8: complete (DESIGN.md 主題註冊表+poster vocab, HANDOVER bullet; values cross-check themes.mjs+contrast; honest re codex no-image-gen)
  NOTE: DESIGN.md/HANDOVER sections were written by an earlier subagent (scope drift) but content is correct/verified.
Task 9: complete (Fable acceptance ACCEPT; controller re-verified all gates clean: no theme leak, regression byte-identical, contrast exit 0, node --check x5)

--- 2026-07-14 late: post-acceptance cleanup (codex-can-gen-images discovery) ---
- codex CAN gen images (see Task 4 CORRECTION). Standalone CLI updated 0.142.5→0.144.4.
- Real Kyoto poster generated via codex → data/posters/trip_20260708T212024Z_5c9f9cee.png,
  wired into cover, re-rendered (dist root + wallet). Poster panel verified on cover.
- MINOR final-triage nits all cleared + verified (node --check + dual-trip re-render):
  1. render.mjs: decodeURIComponent(new URL().pathname) → fileURLToPath(import.meta.url)
     (correctly handles the space in ".../travel ticket/...").
  2. render.mjs: stale dist poster.png now pruned on poster-removal (else rmSync); verified
     Switzerland re-render leaves no orphan poster.png, Kyoto keeps its poster.
  3. orchestrator.mjs --prune: reuse trip_id from byNewest instead of re-parsing json.
- Notes corrected in: agents.mjs, HANDOVER.md, this file, poster design spec.

--- 2026-07-14 late: requirement-A theming actually landed on Kyoto ---
Gap found: theming ENGINE passed acceptance but the real Kyoto trip was never tagged
theme:'japan' (theme=undefined → rendered default), AND palette had diverged from the
original spec ("JR 青綠色調") to 朱/藍染, AND no Japanese 底紋 existed. All fixed:
- japan palette → JR 青綠 (rail #0b7d6e / rail-deep #0a5648 / night #123a33), stamp
  decoupled to 朱紅 via NEW --stamp token (render :root default = rail-deep #9c322b,
  .postmark now color:var(--stamp)). check-theme-contrast: both themes all-PASS
  (added stamp-on-paper/-bright pairs).
- 底紋: pure-CSS seigaiha (青海波) via themeCss PATTERNS, color-mix from --rail, applied
  to .ticket; default returns '' (byte-identical).
- data/trips/japan-kyoto-osaka-2026-5c9f.json + data/final_itinerary.json tagged
  theme:'japan'; re-rendered. Verified: Kyoto day pages have 済 stamp + --stamp:#a62812
  + seigaiha ×6; Switzerland unchanged (VISITED, --stamp:#9c322b, no pattern).
- DESIGN.md japan section + --stamp derived token + postmark component updated.
- NOTE: palette reversed 朱/藍染→JR青綠 per Zack's original requirement A; fully
  reversible (theme = token overrides). If 朱/藍染 preferred, revert themes.mjs japan block.

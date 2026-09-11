# Design and delegated frontend handoff

6 September 2026. This records the design/marketing/settings/integrations subtask, not overall application completion.

## Deliverables

- Thirteen fresh built-in Image Gen concepts in concepts/: six major landing sections; document dashboard; split review; onboarding; schema; settings; mobile landing; mobile review.
- Two original standalone illustration assets in public/assets. hero-document-tray.png matches the accepted hero and contains no embedded UI text.
- DESIGN-SYSTEM.md records exact copy, assets, section/component inventory, tokens, native dimensions, responsive behavior and intentional corrections. PROMPTS.md and PROMPTS-APPENDIX.md contain the generation briefs.
- src/features/marketing: Landing.tsx, MarketingShell.tsx, ProductDemo.tsx, SampleDocument.tsx, UseCases.tsx, Pricing.tsx, Help.tsx, marketing.css.
- src/features/settings: Settings.tsx, MembersPanel.tsx, ApiKeysPanel.tsx, BillingPanel.tsx, Usage.tsx, Invite.tsx, settings.css.
- src/features/integrations: Integrations.tsx, types.ts, integrations.css.

## Router contracts

| Route | Component |
| --- | --- |
| / | marketing/Landing default |
| /help | marketing/Help default |
| /help/api | marketing/Help named ApiDocs |
| /privacy | marketing/Help named Privacy |
| /terms | marketing/Help named Terms |
| /app/settings | settings/Settings default |
| /app/usage | settings/Usage default |
| /app/invite | settings/Invite default |
| /app/integrations | integrations/Integrations default |

Landing CTAs target /sign-up and /sign-up?sample=invoice. Pricing CTAs include the selected configurable plan. Navigation anchors target product/workflow/pricing/integrations. The first workflow sample uses real HTML for the invoice and output; its Results tab shows the corresponding JSON. No generated full-page screenshot is used as UI.

## Implemented interaction inventory

- Marketing: responsive navigation and Escape close; keyboard-arrow tab switching; document/results view; five use cases; range/number ROI controls with bounded numeric values; native FAQ disclosures; linked real onboarding/help routes.
- General settings: read/update actual workspace name; show parser-specific locale/timezone location; real file/page limit; current local-auth status.
- Members: existing list; role updates restricted to owner; manual invitation link creation; invitation list/revoke; member removal confirmation; one-time displayed invitation link; recipient-email-bound invitation acceptance route.
- Keys: administrator-scoped create/list/revoke, selectable server-reported scopes, one-time key display, copy with visible failure handling.
- Retention: integer day limit1–3650; save to real workspace settings; clear consequences; local snapshots containing a deleted document are also removed, while downloaded or externally delivered copies remain external.
- Notifications: save a stored preference; explicitly no outgoing processing-failure delivery implemented.
- Password: check current password, enforce new-password length and confirmation, call real update route, clear inputs after success.
- Activity: administrator audit event list.
- Usage: live persisted monthly pages, quota meter, document/failed/review counts, recorded model cost, last50 billing events and explicit reprocessing/retry/duplicate rule.
- Billing: provider status and configurable PLANS; role-restricted test checkout/portal calls; no live-charge action; return state waits for signed-event reconciliation.
- Connections: create/pause/enable/remove signed webhooks; one-time signing secret display; Google OAuth start/reconnect/disconnect with configurable spreadsheet/worksheet/columns/line-item key.
- Email: provider/domain status, create only when receiving verified, parser/body/attachment/sender configuration, no address if unprovisioned, list/disable provisioned routes.
- Delivery history: persisted delivery status/attempt/error, bounded retry detail, administrator replay.
- Provider events: administrator-scoped inbound/email and billing event history.

## Verification completed here

All thirteen concepts and both production assets were inspected with view_image. Desktop native dimensions1536×1024; generated mobile dimensions887×1774; production assets1254×1254.

TypeScript passed after all marketing and settings/integration implementations. No component browser verification was claimed by this subtask; the parent owns browser access and must complete rendered/interaction checks.

Contrast calculation found #6573D5 on white at4.228:1. The parent accepted #5C69C4 for small interactive text/button fills while retaining the original accent in large heading/art contexts. Both shared tokens and marketing styles should carry this intentional accessibility adjustment.

## Parent QA focus

1. At1536×1024, compare hero to01 using view_image: headline line breaks, side-by-side balance, native sample table, tray image framing, pure white and periwinkle.
2. Compare downstream sections02–06 separately; use-case and product tabs must change native content, ROI defaults500×3/60=25, footer/help/legal routes must load.
3. Test390px and768px for overflow, focus, menu Escape, tab arrows, fields and table-local scrolling.
4. Exercise real settings saves, invitation creation/acceptance/revocation, owner/admin/viewer restrictions, key revocation and password change with owned test accounts. Do not retain screenshots containing one-time keys, signing secrets or invitation tokens.
5. Verify Usage uses the same backend billing rules and limit as intake; manual reprocessing counts again, automatic retries/duplicates do not.
6. Verify unavailable Google/email/Stripe states show setup required, not success. External provider verification remains a separate release gate.
7. Create a controlled webhook connection and inspect persisted delivery/replay. Exercise provider forms only with authorized credentials/accounts.
8. Backend now purges local snapshots containing a deleted document. Retention copy matches that behavior and distinguishes downloaded / externally delivered copies.

## Intentional differences from raw concepts

The supplied brief's truthful behavior wins over generator artifacts: correct invoice arithmetic; text-native samples; no duplicate raster fields in mobile art; no invented contacts/account identity; no duplicate section-header wordmarks; accessible action color; true runtime integration states; workspace-level locale/timezone are not displayed as working editable fields because the implemented API configures them per parser. Settings adds the required password/activity flows using the same open form/table anatomy.

## Static functional/accessibility review follow-up

Completed before the separate saved-image fidelity review. Shared `ui.tsx` adds roving keyboard tabs (arrows/Home/End) and optional modal-description handling. `lib/session.tsx` makes workspace choice explicit React state and seeds the returned session before rerendering; `lib/api.ts` prevents duplicate in-flight actions, cancels query fetches and optionally retains prior list data during filters. AppShell adds mobile focus containment, Escape/focus return, inert hidden controls and visible navigation-request errors. Auth/Invite preserve invitation destinations through sign-in and capture acceptance/switch errors.

Document changes: `Documents.tsx`, `Upload.tsx`, `ExportDialog.tsx`, `DocumentPreview.tsx`, `Review.tsx`, new `ValueEditor.tsx` / `value-editing.ts`, and appended `review.css`. These cover retained search focus, archived-parser document visibility, partial batch reporting, single-flight upload, custom table export keys, inline download errors, recursive array/object editing and save-boundary numeric normalization. Review preserves a dirty draft when a newer correction is observed. Parent subsequently owns the baseline-key-order correction and pinning of the initial displayed run.

Parser changes: `SchemaEditor.tsx`, new `schema-editor.css`, `Parsers.tsx`, `Onboarding.tsx`. Defaults are explicit and typed; JSON defaults use native form validity; move up/down controls are operable; nesting/key/length limits align with backend schema; viewer creation controls are unavailable. The expanded schema UI is deliberately recorded as a substantial density departure in FIDELITY-REVIEW.md.

Settings follow-up: `Settings.tsx` keeps empty retention input as a draft instead of replacing it with zero, and reflects the backend's deletion of local export snapshots containing a removed document. `Invite.tsx` keeps acceptance and workspace switching inside the action error boundary. `Landing.tsx` / `Help.tsx` state that no AI adapter is active in the current installation. Marketing CSS remains owned by the parent for final desktop sizing.

Validation for this subtask: `node --import tsx --test tests/frontend-values.test.ts` passed4/4 focused tests (blank/zero/false, nested normalization, invalid/non-finite drafts, independent nested defaults); `npm run typecheck` passed after the edits. These are static/unit checks, not a claim that this subagent operated the browser. Saved-image comparison is separately documented in FIDELITY-REVIEW.md.

## Export mapping editor completion

`src/features/documents/ExportDialog.tsx`, new `ColumnMappingEditor.tsx` and `export.css` now provide native source-field/column-heading rows, add/remove/up/down ordering, schema-derived suggestions, metadata and repeated-table sources, and optional parser/name controls that POST reusable mappings to the existing API. Bulk custom downloads need no parser; saving reusable mappings requires a selected parser and owner/admin/editor role. Viewer downloads can use custom columns but cannot save mappings. JSON explicitly retains complete approved values/revision metadata; column projection and row expansion apply to CSV/XLSX. Missing saved selections show an error instead of silently exporting a different shape.

After parity's enum/Usage changes and the parent's latest AppShell resize correction, `npm run typecheck` and `npm run build` both passed. Build transcript: `docs/evidence/frontend-final-build.txt`. Parent owns rendered mapping-editor QA. Final replacement hero/pricing/integration/mobile/tablet/PDF evidence was inspected through `view_image` and the closed visual findings are reflected in FIDELITY-REVIEW.md.

# Newly authored synthetic bank acceptance pack

Prepared on 26 September 2026. No provider extraction has been run on this pack. It is separate from the development fixtures, not independently sourced real-world bank data. All institution names, account identifiers, transactions and dates are invented. Each page is visibly labelled synthetic.

| File | Independent case | Purpose |
| --- | --- | --- |
| `case-a-eur-multipage-native.pdf` | MF-HO-A | Two pages, decimal commas, thousands separators, repeated headers, wrapped descriptions and ten transactions including two legitimate same-day repeated payments. |
| `case-a-eur-multipage-raster.pdf` | Same MF-HO-A | Grayscale, image-only rendition of the native case at 144 DPI. Two pages, one image per page, no text layer. This is a controlled scan-like rendition, not a real scanner sample or a third independent case. |
| `case-b-multiple-accounts-native.pdf` | MF-HO-B | Two pages, separate USD/EUR accounts, eight transactions, signed/parenthesized amounts, one absent opening balance, one absent running balance and a deliberate five-cent statement debit-total discrepancy. |

`expected.json` is a separately authored literal answer key with raw and normalized values, source pages/items and expected review outcomes. It does not import or use the application's extraction/normalization code. The generator does not read this manifest. Expected IDs are source-reference labels, not a prescription for application-generated IDs.

`generate.py` produces the source PDFs deterministically using the existing ReportLab/Pillow/Poppler tools. It never calls a provider, loads credentials or changes application state. `offline-structure-checks.json` records file hashes, sizes, page counts, embedded images and text-layer checks. `preview-contact-sheet.jpg` is a visual review aid. `manifest-arithmetic-checks.json` records independent decimal arithmetic checks of the authored expectations, not extraction results.

Only the PDFs are provider inputs. Do not upload the expected manifest, this README or the generator to the extraction provider; do not add their answers to prompts or rules. The image-only file is intentionally the same source as case A. Evaluate renditions separately first; a deliberate combined upload may then assess overlap/duplicate warnings without silently removing rows.

Once first-pass extraction outputs are viewed, this pack is no longer held out for subsequent tuning. Record that evaluation revision/date, archive the untouched first-pass outputs, and retire it to regression status. If it informs fixes or prompt changes, author or obtain a fresh reserved pack before making another held-out claim. See `docs/BANK-QUALITY-ACCEPTANCE.md` for the acceptance protocol. This pack establishes neither universal bank compatibility nor measured real-world accuracy.

import fs from 'node:fs/promises';
import JSZip from 'jszip';

// Synthetic, independently assembled ODF package. No bank/customer document or
// converter output is used. Fixed ZIP dates make regeneration byte-for-byte stable.
const mime='application/vnd.oasis.opendocument.text';
const version='1.3';
const content=`<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="${version}">
<office:body><office:text>
<text:h text:outline-level="1">SYNTHETIC ODT ACCEPTANCE FIXTURE</text:h>
<text:p>Reference: 000042</text:p><text:p>Amount: 12.50</text:p><text:p>Paid: no</text:p>
<text:p>Merchant: Cedar &amp; Pine</text:p><text:p>Receipt date: 26/09/2026</text:p><text:p>Currency: EUR</text:p><text:p>Total: 12.50</text:p>
<text:p>Message: Keep <text:span>wrapped description</text:span><text:line-break/>on the next line.</text:p>
<table:table table:name="Synthetic items"><table:table-row><table:table-cell><text:p>Description</text:p></table:table-cell><table:table-cell><text:p>Code</text:p></table:table-cell><table:table-cell><text:p>Amount</text:p></table:table-cell><table:table-cell><text:p>Reference</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell><text:p>Paper | pens</text:p></table:table-cell><table:table-cell><text:p>00017</text:p></table:table-cell><table:table-cell><text:p>12.50</text:p></table:table-cell><table:table-cell/></table:table-row></table:table>
</office:text></office:body></office:document-content>`;
const manifest=`<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="${version}"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}" manifest:version="${version}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`;
const zip=new JSZip(),options={date:new Date('2026-09-26T00:00:00Z'),createFolders:false};
zip.file('mimetype',mime,{...options,compression:'STORE'});
zip.file('content.xml',content,{...options,compression:'DEFLATE'});
zip.file('META-INF/manifest.xml',manifest,{...options,compression:'DEFLATE'});
await fs.writeFile('fixtures/source-formats/synthetic-receipt.odt',await zip.generateAsync({type:'nodebuffer',platform:'UNIX',compression:'DEFLATE',streamFiles:false}));

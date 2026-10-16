import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { decodeSource } from '../server/core/decoder-engine.js';
import { inspectSource } from '../server/core/source.js';

async function workbook(date1904 = false) {
  const book = new ExcelJS.Workbook();
  book.created = new Date('2026-01-01T00:00:00Z');
  book.modified = new Date('2026-01-01T00:00:00Z');
  book.properties.date1904 = date1904;
  const sheet = book.addWorksheet('Synthetic date source');
  sheet.addRow(['SYNTHETIC ONLY', 'Value']);
  sheet.addRow(['Calendar date', new Date('2026-10-02T00:00:00.000Z')]);
  sheet.getCell('B2').numFmt = 'yyyy-mm-dd';
  sheet.addRow(['Date and fractional time', new Date('2026-10-02T13:45:06.125Z')]);
  sheet.getCell('B3').numFmt = 'yyyy-mm-dd hh:mm:ss.000';
  sheet.addRow(['Numeric zero', 0]);
  return { book, sheet };
}

const expectedDates = [
  'SYNTHETIC ONLY | Value',
  'Calendar date | 2026-10-02',
  'Date and fractional time | 2026-10-02T13:45:06.125',
  'Numeric zero | 0',
].join('\n');

async function changeWorksheet(bytes:Buffer,change:(xml:string)=>string):Promise<Buffer>{
  const zip=await JSZip.loadAsync(bytes),entry=zip.file('xl/worksheets/sheet1.xml')!;
  zip.file(entry.name,change(await entry.async('string')));
  return zip.generateAsync({type:'nodebuffer'});
}

test('native XLSX dates and fractional times survive isolated decoding in both Excel date systems', async () => {
  for (const date1904 of [false, true]) {
    const { book } = await workbook(date1904);
    const bytes = Buffer.from(await book.xlsx.writeBuffer()), original = Buffer.from(bytes);
    const readback = new ExcelJS.Workbook(); await readback.xlsx.load(bytes as any);
    assert.equal(readback.properties.date1904, date1904);
    assert.ok(readback.worksheets[0].getCell('B2').value instanceof Date);
    assert.ok(readback.worksheets[0].getCell('B3').value instanceof Date);
    const result = await inspectSource(bytes, 'synthetic-native-dates.xlsx');
    assert.equal(result.pageCount, 1);
    assert.deepEqual(result.pages, [{ page: 1, text: expectedDates }]);
    assert.deepEqual(bytes, original);
  }
});

test('cached XLSX dates retain calendar values without evaluating formulas or losing zero and false results', async () => {
  const { book, sheet } = await workbook();
  sheet.addRow(['Cached date', { formula: 'DATE(2026,10,9)', result: new Date('2026-10-09T00:00:00.000Z') }]);
  sheet.getCell('B5').numFmt = 'yyyy-mm-dd';
  sheet.addRow(['Cached fractional time', { formula: 'DATE(2026,10,9)+TIME(1,2,3)', result: new Date('2026-10-09T01:02:03.250Z') }]);
  sheet.getCell('B6').numFmt = 'yyyy-mm-dd hh:mm:ss.000';
  sheet.addRow(['Cached zero', { formula: '0', result: 0 }]);
  sheet.addRow(['Cached false', { formula: 'FALSE()', result: false }]);
  sheet.addRow(['Uncalculated formula', { formula: '1+99' }]);
  sheet.addRow(['Hyperlink text', { text: 'Synthetic label', hyperlink: 'https://example.test/synthetic' }]);
  sheet.addRow(['Literal false', false]);
  sheet.addRow(['Cached number', { formula: '6*7', result: 42 }]);
  const bytes = Buffer.from(await book.xlsx.writeBuffer());
  const readback = new ExcelJS.Workbook(); await readback.xlsx.load(bytes as any);
  assert.equal(readback.worksheets[0].getCell('B7').result, 0);
  assert.equal(readback.worksheets[0].getCell('B8').result, false);
  const result = await inspectSource(bytes, 'synthetic-cached-dates.xlsx');
  assert.equal(result.pages[0].text, [expectedDates,
    'Cached date | 2026-10-09',
    'Cached fractional time | 2026-10-09T01:02:03.250',
    'Cached zero | 0',
    'Cached false | false',
    'Uncalculated formula | ',
    'Hyperlink text | Synthetic label',
    'Literal false | false',
    'Cached number | 42',
  ].join('\n'));
});

test('the 1904 epoch date is retained while an unformatted numeric zero stays numeric', async () => {
  const { book, sheet } = await workbook(true);
  sheet.addRow(['Epoch date', new Date('1904-01-01T00:00:00.000Z')]);
  sheet.getCell('B5').numFmt = 'yyyy-mm-dd';
  const bytes = Buffer.from(await book.xlsx.writeBuffer());
  const result = await inspectSource(bytes, 'synthetic-1904-epoch.xlsx');
  assert.equal(result.pages[0].text, `${expectedDates}\nEpoch date | 1904-01-01`);
});

test('XLSX calendar text does not change with the caller timezone or assert an Excel timezone', async () => {
  const { book } = await workbook();
  const bytes = Buffer.from(await book.xlsx.writeBuffer()), priorTimezone = process.env.TZ;
  try {
    for (const timezone of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']) {
      process.env.TZ = timezone;
      const result = await decodeSource(bytes, 'synthetic-zone-free-dates.xlsx');
      assert.equal(result.pages[0].text, expectedDates);
    }
  } finally {
    if (priorTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = priorTimezone;
  }
});

test('unknown XLSX reader failures retain generic retryable errors without exposing dependency diagnostics', async () => {
  const { book } = await workbook(), zip = await JSZip.loadAsync(await book.xlsx.writeBuffer());
  const xml = await zip.file('xl/workbook.xml')!.async('string');
  // Isolate the known reader limitation with an equivalent prefixed root name.
  zip.file('xl/workbook.xml', xml.replace('<workbook ', '<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ').replace('</workbook>', '</x:workbook>'));
  const bytes = await zip.generateAsync({ type: 'nodebuffer' }), original = Buffer.from(bytes);
  await assert.rejects(inspectSource(bytes, 'synthetic-prefixed-workbook.xlsx'), (error: any) => {
    assert.equal(error.statusCode, 503);
    assert.equal(error.message, 'The document could not be decoded. Retry shortly.');
    assert.doesNotMatch(error.message, /TypeError|sheets|undefined|node_modules/);
    return true;
  });
  assert.deepEqual(bytes, original);
});

test('unsupported ISO-valued XLSX dates fail closed for actual reader cells and standard prefixed cells', async()=>{
  const {book}=await workbook(),base=Buffer.from(await book.xlsx.writeBuffer());
  for(const namespace of ['standard','prefixed','absent','foreign','strict']){
    const bytes=await changeWorksheet(base,xml=>{
      let changed=xml.replace(/<c r="B2"[^>]*>.*?<\/c>/,'<c r="B2" s="1" t="d"><v>2026-10-02T00:00:00.000Z</v></c>');
      if(namespace==='prefixed')changed=changed.replace('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"','xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"').replace(/<(\/)?([A-Za-z][\w.-]*)(?=[\s/>])/g,'<$1x:$2');
      else if(namespace==='absent')changed=changed.replace('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"','');
      else if(namespace==='foreign'||namespace==='strict')changed=changed.replace('http://schemas.openxmlformats.org/spreadsheetml/2006/main',namespace==='foreign'?'urn:synthetic:foreign':'http://purl.oclc.org/ooxml/spreadsheetml/main');
      return changed;
    });
    const original=Buffer.from(bytes);
    await assert.rejects(inspectSource(bytes,'synthetic-unsupported-date-encoding.xlsx'),(error:any)=>{
      assert.equal(error.reason,'xlsx_date_encoding_unsupported');assert.equal(error.statusCode,400);
      assert.equal(error.message,'This XLSX date encoding is not supported. Re-save it as an XLSX workbook or upload a CSV copy.');return true;
    });
    assert.deepEqual(bytes,original);
  }
});

test('XLSX ISO-date guard ignores comments and foreign namespaces instead of matching raw XML text',async()=>{
  const {book}=await workbook(),base=Buffer.from(await book.xlsx.writeBuffer());
  const bytes=await changeWorksheet(base,xml=>xml.replace('<sheetData>',`<!-- <c t="d"><v>2026-10-02T00:00:00.000Z</v></c> --><other:c xmlns:other="urn:synthetic:foreign" t="d"><other:v>2026-10-02T00:00:00.000Z</other:v></other:c><sheetData>`));
  assert.equal((await inspectSource(bytes,'synthetic-iso-date-decoys.xlsx')).pages[0].text,expectedDates);
});

test('ISO-date guard covers noncanonical worksheet paths the installed reader still loads',async()=>{
  const {book}=await workbook(),zip=await JSZip.loadAsync(await book.xlsx.writeBuffer());
  const originalPath='xl/worksheets/sheet1.xml',alias='xl/prefix/xl/worksheets/sheet1.xml.suffix',xml=await zip.file(originalPath)!.async('string');
  zip.remove(originalPath);zip.file(alias,xml);
  const rels=await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
  zip.file('xl/_rels/workbook.xml.rels',rels.replace('worksheets/sheet1.xml','prefix/xl/worksheets/sheet1.xml.suffix'));
  const types=await zip.file('[Content_Types].xml')!.async('string');
  zip.file('[Content_Types].xml',types.replace('/xl/worksheets/sheet1.xml',`/${alias}`));
  assert.equal((await inspectSource(await zip.generateAsync({type:'nodebuffer'}),'synthetic-aliased-numeric.xlsx')).pages[0].text,expectedDates);
  zip.file(alias,xml.replace(/<c r="B2"[^>]*>.*?<\/c>/,'<c r="B2" s="1" t="d"><v>2026-10-02T00:00:00.000Z</v></c>'));
  await assert.rejects(inspectSource(await zip.generateAsync({type:'nodebuffer'}),'synthetic-aliased-iso.xlsx'),(error:any)=>error.reason==='xlsx_date_encoding_unsupported'&&error.statusCode===400);
});

test('obvious time-only XLSX clocks do not invent an epoch calendar date',async()=>{
  const {book,sheet}=await workbook();
  sheet.addRow(['Clock only',0.5]);
  sheet.getCell('B5').numFmt='hh:mm:ss.000';
  sheet.addRow(['Midnight clock',0]);
  sheet.getCell('B6').numFmt='hh:mm';
  sheet.addRow(['Explicit midnight datetime',new Date('2026-10-02T00:00:00.000Z')]);
  sheet.getCell('B7').numFmt='yyyy-mm-dd hh:mm:ss.000';
  const result=await inspectSource(Buffer.from(await book.xlsx.writeBuffer()),'synthetic-time-only.xlsx');
  assert.equal(result.pages[0].text,`${expectedDates}\nClock only | 12:00:00.000\nMidnight clock | 00:00:00.000\nExplicit midnight datetime | 2026-10-02T00:00:00.000`);
});

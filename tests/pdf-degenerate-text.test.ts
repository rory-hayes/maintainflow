import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PDFDocument,StandardFonts,beginText,endText,setFontAndSize,setTextMatrix,showText,type PDFFont,type PDFPage} from 'pdf-lib';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {readPdfGeometry} from '../server/core/source.js';
import {bankPdfLayoutVersion,serializeBankPdfLayout} from '../shared/bank-pdf-layout.js';
import {findPdfRegionAnchor} from '../shared/pdf-regions.js';

// Clearly synthetic PDF content. Low-level operators deliberately preserve a
// zero font size: PDFPage.drawText's convenience fallback replaces size: 0.
function text(page:PDFPage,font:PDFFont,value:string,size:number,matrix:[number,number,number,number,number,number]){
 const key=page.node.newFontDictionary(font.name,font.ref);
 page.pushOperators(beginText(),setFontAndSize(key,size),setTextMatrix(...matrix),showText(font.encodeText(value)),endText());
}
async function fixture(options:{table?:boolean;extra?:{size:number;matrix:[number,number,number,number,number,number]}}={table:true}){
 const pdf=await PDFDocument.create({updateMetadata:false}),font=await pdf.embedFont(StandardFonts.Helvetica),page=pdf.addPage([842,595]);
 if(options.table!==false){
  page.drawText('SYNTHETIC - not a real bank statement',{font,size:12,x:40,y:550});
  page.drawText('Debit',{font,size:10,x:500,y:360});page.drawText('Credit',{font,size:10,x:590,y:360});
  page.drawText('85.25',{font,size:10,x:500,y:330});page.drawText('240.50',{font,size:10,x:590,y:300});
 }
 // Establish normal font state even on the textless control page; a zero-only
 // font resource hits a separate PDF.js font-name error before geometry decoding.
 if(options.table===false)page.drawText(' ',{font,size:10,x:40,y:550});
 text(page,font,'Page 1 of 2',0,[1,0,0,1,746,8]);
 if(options.extra)text(page,font,'Unsupported visible block',options.extra.size,options.extra.matrix);
 return Buffer.from(await pdf.save());
}

test('zero-size footer cannot discard ordinary bank columns from isolated native geometry',async()=>{
 const bytes=await fixture(),digest=createHash('sha256').update(bytes).digest('hex');
 // Independent PDF.js observation proves the test really contains nonempty,
 // fully degenerate items, rather than silently normalizing the fixture away.
 const loading=getDocument({data:new Uint8Array(bytes),useSystemFonts:true,stopAtErrors:true});
 try{const doc=await loading.promise,content=await(await doc.getPage(1)).getTextContent();const empty=content.items.filter((item:any)=>item.str?.trim()&&item.width===0&&item.height===0&&item.transform.slice(0,4).every((n:number)=>n===0));assert.ok(empty.length>0);}
 finally{await loading.destroy();}
 const geometry=await readPdfGeometry(bytes),page=geometry.pages[0];
 assert.equal(geometry.sourceSha256,digest);assert.equal(page.reason,null);assert.equal(page.items.length,5);
 assert.deepEqual(page.items.map(item=>item.text),['SYNTHETIC - not a real bank statement','Debit','Credit','85.25','240.50']);
 const debit=page.items.find(item=>item.text==='Debit')!,credit=page.items.find(item=>item.text==='Credit')!,paid=page.items.find(item=>item.text==='85.25')!,received=page.items.find(item=>item.text==='240.50')!;
 assert.equal(debit.rect.x,500/842);assert.equal(credit.rect.x,590/842);assert.equal(paid.rect.x,debit.rect.x);assert.equal(received.rect.x,credit.rect.x);assert.ok(received.rect.x>paid.rect.x);
 assert.ok(findPdfRegionAnchor(page,'Credit').matched);
 const layout=serializeBankPdfLayout({version:bankPdfLayoutVersion,geometry},{sourceSha256:digest,pageCount:1});
 assert.equal(layout.provenance.status,'included');assert.equal('itemCount' in layout.provenance&&layout.provenance.itemCount,5);assert.ok(layout.text?.includes('240.50'));
});

test('a page containing only fully degenerate text has no native text, without invented rectangles',async()=>{
 const geometry=await readPdfGeometry(await fixture({table:false}));
 assert.deepEqual(geometry.pages[0].items,[]);assert.equal(geometry.pages[0].reason,'no_native_text');
});

test('zero-size omission does not admit nonzero text with collapsed, skewed, rotated or mirrored transforms',async()=>{
 for(const matrix of [[0,0,0,1,100,200],[1,0,0,0,100,200],[1,.1,0,1,100,200],[0,1,-1,0,100,200],[-1,0,0,1,200,200]] as [number,number,number,number,number,number][]){
  const geometry=await readPdfGeometry(await fixture({extra:{size:10,matrix}}));
  assert.equal(geometry.pages[0].reason,'unsupported_text_geometry',JSON.stringify(matrix));assert.deepEqual(geometry.pages[0].items,[]);
 }
});

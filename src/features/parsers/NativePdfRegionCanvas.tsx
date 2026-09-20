import {useLayoutEffect,useRef,useState} from 'react';
import {Button} from '../../components/ui';
import PdfCanvas from '../documents/PdfCanvas';
import type {PdfGeometry} from '../../../shared/pdf-regions';

type Rect={x:number;y:number;width:number;height:number};
type Props={bytes:Uint8Array;geometry:PdfGeometry;page:number;anchor:Rect|null;region:Rect|null;disabled:boolean;selectionKey:string;onAnchor:(text:string)=>void;onRegion:(rect:Rect)=>void;onError:(message:string)=>void};
/** The overlay uses server geometry; only pointer coordinates are converted from display pixels. */
export default function NativePdfRegionCanvas(props:Props){
 const {bytes,geometry,page,anchor,region,disabled}=props,source=geometry.pages.find(value=>value.page===page);
 const [tool,setTool]=useState<'anchor'|'region'>('anchor'),[zoom,setZoom]=useState(100),[rendered,setRendered]=useState<{bytes:Uint8Array;page:number}|null>(null),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0),[draft,setDraft]=useState<Rect|null>(null);
 const host=useRef<HTMLDivElement>(null),start=useRef<{x:number;y:number;pointer:number}|null>(null),callbacks=useRef(props);
 useLayoutEffect(()=>{callbacks.current=props;});
 useLayoutEffect(()=>{start.current=null;setDraft(null);setRendered(null);setFailed(false);return()=>{start.current=null;};},[bytes,geometry.sourceSha256,page]);
 useLayoutEffect(()=>{start.current=null;setDraft(null);},[props.selectionKey,disabled,tool]);
 const ready=rendered?.bytes===bytes&&rendered.page===page;
 function point(event:React.PointerEvent<SVGSVGElement>){const bounds=event.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(event.clientX-bounds.left)/bounds.width)),y:Math.max(0,Math.min(1,(event.clientY-bounds.top)/bounds.height))};}
 function cancel(){start.current=null;setDraft(null);}
 function complete(event:React.PointerEvent<SVGSVGElement>){const initial=start.current;if(disabled||tool!=='region'||!initial||initial.pointer!==event.pointerId)return;const end=point(event),value={x:Math.min(initial.x,end.x),y:Math.min(initial.y,end.y),width:Math.abs(end.x-initial.x),height:Math.abs(end.y-initial.y)};cancel();if(value.width>0.0001&&value.height>0.0001)callbacks.current.onRegion(value);}
 if(!source)return <p className="small" role="status">Choose a document page to inspect its regions.</p>;
 const current=draft||region;
 return <section className="native-pdf-preview" aria-label="PDF region preview" ref={host} tabIndex={-1}>
  <div className="native-region-toolbar"><fieldset disabled={disabled||Boolean(source.reason)}><legend>Selection tool</legend><label><input type="radio" name="native-region-tool" checked={tool==='anchor'} onChange={()=>{cancel();setTool('anchor');}}/>Select anchor block</label><label><input type="radio" name="native-region-tool" checked={tool==='region'} onChange={()=>{cancel();setTool('region');}}/>Draw value region</label></fieldset><div className="actions"><Button type="button" variant="ghost" aria-label="Zoom out PDF region" disabled={zoom<=100} onClick={()=>setZoom(value=>Math.max(100,value-25))}>−</Button><span className="small">{zoom}%</span><Button type="button" variant="ghost" aria-label="Zoom in PDF region" disabled={zoom>=200} onClick={()=>setZoom(value=>Math.min(200,value+25))}>+</Button></div></div>
  <p className="small muted">Page {page} of {geometry.pageCount}. Select whole searchable text blocks. Use the numeric region controls to move or resize without dragging. Press Escape to cancel a new box.</p>
  <div className="native-region-scroll"><div className="native-region-sheet" style={{width:`${zoom}%`}}>
   <PdfCanvas key={retry} bytes={bytes} page={page} label={`Native PDF region sample, page ${page}`} onRendered={()=>setRendered({bytes,page})} onError={message=>{setRendered(null);setFailed(true);callbacks.current.onError(message);}}/>
   {ready&&!source.reason&&<svg className={`native-region-overlay tool-${tool}`} viewBox="0 0 1 1" preserveAspectRatio="none" aria-label={`Native text blocks and value region on page ${page}`} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();cancel();}}} onPointerDown={event=>{if(disabled||tool!=='region'||event.button!==0)return;event.preventDefault();const p=point(event);start.current={...p,pointer:event.pointerId};setDraft({...p,width:0,height:0});event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event=>{const initial=start.current;if(!initial||initial.pointer!==event.pointerId)return;const end=point(event);setDraft({x:Math.min(initial.x,end.x),y:Math.min(initial.y,end.y),width:Math.abs(end.x-initial.x),height:Math.abs(end.y-initial.y)});}} onPointerUp={complete} onPointerCancel={cancel}>
    {source.items.map(item=><rect key={item.id} {...item.rect} className="native-text-block" vectorEffect="non-scaling-stroke" role="button" tabIndex={tool==='anchor'&&!disabled?0:-1} aria-label={`Use anchor block: ${item.text}`} onClick={()=>{if(tool==='anchor'&&!disabled)callbacks.current.onAnchor(item.text);}} onKeyDown={event=>{if(tool==='anchor'&&!disabled&&['Enter',' '].includes(event.key)){event.preventDefault();callbacks.current.onAnchor(item.text);}}}><title>{item.text}</title></rect>)}
    {anchor&&<rect {...anchor} className="native-anchor-box" vectorEffect="non-scaling-stroke"/>}{current&&<rect {...current} className="native-value-box" vectorEffect="non-scaling-stroke"/>}
   </svg>}
  </div></div>
  {source.reason&&<p className="small" role="status">{source.reason==='no_native_text'?'This page has no searchable text. Image-only pages cannot use native PDF regions.':'This page has unsupported text geometry. Choose a page with supported native text.'}</p>}
  {failed&&<Button type="button" variant="secondary" onClick={()=>{host.current?.focus();setFailed(false);setRetry(value=>value+1);}}>Retry PDF page</Button>}{!ready&&!failed&&<p className="small muted" role="status">Loading the original PDF page…</p>}
 </section>;
}

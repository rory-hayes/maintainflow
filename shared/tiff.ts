/** Shared client/server limits for bounded, temporary TIFF visual derivatives. */
export const tiffRenderVersion='folio-tiff-jpeg2048-q90-v1';
export const tiffLimits=Object.freeze({
 maxBytes:10*1024*1024,maxPages:30,maxPagePixels:40_000_000,maxTotalPixels:300_000_000,
 maxEdge:2048,jpegQuality:90,maxJpegBytes:2*1024*1024,maxPdfBytes:10*1024*1024,maxOutputBytes:14*1024*1024,
 maxIfds:256,maxIfdEntries:1024,maxDataBlocks:100_000,maxDecodedPageBytes:160*1024*1024,
});
export type TiffPageDescriptor={page:number;ifdOffset:number;width:number;height:number;orientation:number};
export type TiffDirectory={bigTiff:boolean;littleEndian:boolean;pages:TiffPageDescriptor[];totalPixels:number};
export type TiffPageRenderMetadata={mimeType:'image/jpeg';page:number;pageCount:number;width:number;height:number;sourceSha256:string;renderVersion:typeof tiffRenderVersion};
export type TiffAiDocumentMetadata={mimeType:'application/pdf';pageCount:number;sourceSha256:string;renderVersion:typeof tiffRenderVersion};

import type {Plugin} from 'vite';

// PDF.js 6.3.289 marks a failed operator stream complete before rejecting it.
// A render whose display-ready promise already resolved can then succeed blank.
// Keep this compatibility fix narrow: dependency changes must be reviewed again.
const failedStream = `        if (intentState.operatorList) {
          intentState.operatorList.lastChunk = true;
          for (const internalRenderTask of intentState.renderTasks) {
            internalRenderTask.operatorListChanged();
          }
          this.#tryCleanup();
        }
        if (intentState.displayReadyCapability) {
          intentState.displayReadyCapability.reject(reason);
        } else if (intentState.opListReadCapability) {
          intentState.opListReadCapability.reject(reason);
        } else {
          throw reason;
        }`;

const rejectedStream = `        intentState.displayReadyCapability?.reject(reason);
        intentState.opListReadCapability?.reject(reason);
        // A retry must create a new stream rather than reuse partial operators.
        if (this._intentStates.get(cacheKey) === intentState) {
          this._intentStates.delete(cacheKey);
        }
        for (const internalRenderTask of [...intentState.renderTasks]) {
          if (typeof internalRenderTask.cancel === "function") {
            internalRenderTask.cancel(reason);
          } else {
            // getOperatorList has a synthetic task with no canvas to cancel.
            intentState.renderTasks.delete(internalRenderTask);
          }
        }
        if (intentState.operatorList) {
          intentState.operatorList.lastChunk = true;
          this.#tryCleanup();
        }
        if (!intentState.displayReadyCapability && !intentState.opListReadCapability) {
          throw reason;
        }`;

export function patchPdfJsRenderErrors(source:string):string {
  if (!source.includes('const version = "6.3.289";') || source.split(failedStream).length!==2) {
    throw new Error('PDF.js render-error compatibility patch needs review for this dependency build.');
  }
  return source.replace(failedStream,rejectedStream);
}

export function pdfJsRenderErrors():Plugin {
  return {
    name:'folio-pdfjs-render-errors',
    enforce:'pre',
    transform(source,id) {
      if (!id.split('?')[0].replaceAll('\\','/').endsWith('/node_modules/pdfjs-dist/build/pdf.mjs')) return null;
      return {code:patchPdfJsRenderErrors(source),map:null};
    },
  };
}

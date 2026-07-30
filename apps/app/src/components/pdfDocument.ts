import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

export interface PdfLoadingTask<TDocument = PDFDocumentProxy> {
  promise: Promise<TDocument>;
  destroy(): Promise<void>;
}

export type PdfDocumentLoader<TDocument = PDFDocumentProxy> = (options: {
  data: Uint8Array;
}) => PdfLoadingTask<TDocument>;

/** Decode the file once and start one pdf.js document lifecycle. */
export function beginPdfDocumentLoad<TDocument = PDFDocumentProxy>(
  dataBase64: string,
  loader: PdfDocumentLoader<TDocument>,
): PdfLoadingTask<TDocument> {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return loader({ data: bytes });
}

export interface PdfRenderRun {
  promise: Promise<void>;
  cancel(): void;
}

/** Render a new scale from an already-loaded document and atomically swap the pages. */
export function renderPdfDocument(
  pdfDocument: PDFDocumentProxy,
  scale: number,
  container: HTMLElement,
): PdfRenderRun {
  let cancelled = false;
  const renderTasks = new Set<RenderTask>();

  const promise = (async () => {
    const ownerDocument = container.ownerDocument;
    const nextPages = ownerDocument.createDocumentFragment();
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
      if (cancelled) return;
      const page = await pdfDocument.getPage(pageNumber);
      if (cancelled) return;

      const viewport = page.getViewport({ scale });
      const canvas = ownerDocument.createElement('canvas');
      canvas.className = 'pdf-page';
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) continue;

      nextPages.appendChild(canvas);
      const renderTask = page.render({ canvas, canvasContext: context, viewport });
      renderTasks.add(renderTask);
      try {
        await renderTask.promise;
      } finally {
        renderTasks.delete(renderTask);
      }
    }

    if (!cancelled) container.replaceChildren(nextPages);
  })().catch((err: unknown) => {
    if (!cancelled) throw err;
  });

  return {
    promise,
    cancel() {
      cancelled = true;
      for (const task of renderTasks) task.cancel();
    },
  };
}

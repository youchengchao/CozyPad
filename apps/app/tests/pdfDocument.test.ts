import { describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  beginPdfDocumentLoad,
  renderPdfDocument,
  type PdfDocumentLoader,
} from '../src/components/pdfDocument';

describe('PDF document lifecycle', () => {
  it('re-renders zoom levels from one document without reloading or destroying its worker', async () => {
    const viewportScales: number[] = [];
    const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
    const page = {
      getViewport: vi.fn(({ scale }: { scale: number }) => {
        viewportScales.push(scale);
        return { width: 100 * scale, height: 200 * scale };
      }),
      render,
    };
    const pdfDocument = {
      numPages: 1,
      getPage: vi.fn(() => Promise.resolve(page)),
    } as unknown as PDFDocumentProxy;
    const destroy = vi.fn(() => Promise.resolve());
    let loadedBytes: Uint8Array | undefined;
    const loader = vi.fn((options: { data: Uint8Array }) => {
      loadedBytes = options.data;
      return { promise: Promise.resolve(pdfDocument), destroy };
    });

    const loadingTask = beginPdfDocumentLoad(
      'AQID',
      loader as PdfDocumentLoader,
    );
    const loadedDocument = await loadingTask.promise;
    const fragments: { appendChild(node: unknown): void }[] = [];
    const ownerDocument = {
      createDocumentFragment() {
        const fragment = { appendChild: vi.fn() };
        fragments.push(fragment);
        return fragment;
      },
      createElement() {
        return {
          className: '',
          width: 0,
          height: 0,
          getContext: () => ({}),
        };
      },
    };
    const container = {
      ownerDocument,
      replaceChildren: vi.fn(),
    } as unknown as HTMLElement;

    await renderPdfDocument(loadedDocument, 1.2, container).promise;
    await renderPdfDocument(loadedDocument, 1.4, container).promise;

    expect(loader).toHaveBeenCalledTimes(1);
    expect(loadedBytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(viewportScales).toEqual([1.2, 1.4]);
    expect(container.replaceChildren).toHaveBeenCalledTimes(2);
    expect(destroy).not.toHaveBeenCalled();

    await loadingTask.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

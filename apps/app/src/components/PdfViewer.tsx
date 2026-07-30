import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import PdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { beginPdfDocumentLoad, renderPdfDocument } from './pdfDocument';

// 同源 worker（Vite 打包），不走 CDN，符合 Electron CSP。
// Let every loading task own its worker. Reusing a workerPort while its previous
// task is still being destroyed makes pdf.js reject the next load (and zoom).
pdfjs.GlobalWorkerOptions.workerSrc = PdfWorkerUrl;

interface PdfViewerProps {
  /** 檔案內容（base64）。 */
  dataBase64: string;
  fileName: string;
}

export function PdfViewer({ dataBase64, fileName }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    setPageCount(0);
    setPdfDocument(null);

    let task;
    try {
      task = beginPdfDocumentLoad(dataBase64, pdfjs.getDocument);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
      return;
    }
    void task.promise
      .then((doc) => {
        if (disposed) return;
        setPageCount(doc.numPages);
        setPdfDocument(doc);
      })
      .catch((err: unknown) => {
        if (!disposed) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      disposed = true;
      void task.destroy();
    };
  }, [dataBase64]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!pdfDocument) {
      container.replaceChildren();
      return;
    }

    let disposed = false;
    setLoading(true);
    setError(null);
    const renderRun = renderPdfDocument(pdfDocument, scale, container);
    void renderRun.promise
      .then(() => {
        if (!disposed) setLoading(false);
      })
      .catch((err: unknown) => {
        if (!disposed) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      disposed = true;
      renderRun.cancel();
    };
  }, [pdfDocument, scale]);

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <span className="mono pdf-name">{fileName}</span>
        {pageCount > 0 ? <span className="hint">{pageCount} 頁</span> : null}
        <span className="spacer" />
        <button
          type="button"
          aria-label="縮小 PDF"
          disabled={scale <= 0.5}
          onClick={() => setScale((value) => Math.max(0.5, value - 0.2))}
        >
          −
        </button>
        <span className="hint mono">{Math.round(scale * 100)}%</span>
        <button
          type="button"
          aria-label="放大 PDF"
          disabled={scale >= 3}
          onClick={() => setScale((value) => Math.min(3, value + 0.2))}
        >
          ＋
        </button>
      </div>
      {error ? <div className="error-banner">PDF 載入失敗：{error}</div> : null}
      {loading && !error ? <div className="hint pdf-loading">載入中…</div> : null}
      <div className="pdf-pages" ref={containerRef} />
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';

// 同源 worker（Vite 打包），不走 CDN，符合 Electron CSP。
pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();

interface PdfViewerProps {
  /** 檔案內容（base64）。 */
  dataBase64: string;
  fileName: string;
}

export function PdfViewer({ dataBase64, fileName }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    container.replaceChildren();

    const binary = atob(dataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const task = pdfjs.getDocument({ data: bytes });
    void task.promise
      .then(async (doc) => {
        if (cancelled) return;
        setPageCount(doc.numPages);
        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
          if (cancelled) return;
          const page = await doc.getPage(pageNumber);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.className = 'pdf-page';
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const context = canvas.getContext('2d');
          if (!context) continue;
          container.appendChild(canvas);
          await page.render({ canvas, canvasContext: context, viewport }).promise;
        }
        if (!cancelled) setLoading(false);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [dataBase64, scale]);

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <span className="mono pdf-name">{fileName}</span>
        {pageCount > 0 ? <span className="hint">{pageCount} 頁</span> : null}
        <span className="spacer" />
        <button onClick={() => setScale((value) => Math.max(0.5, value - 0.2))}>−</button>
        <span className="hint mono">{Math.round(scale * 100)}%</span>
        <button onClick={() => setScale((value) => Math.min(3, value + 0.2))}>＋</button>
      </div>
      {error ? <div className="error-banner">PDF 載入失敗：{error}</div> : null}
      {loading && !error ? <div className="hint pdf-loading">載入中…</div> : null}
      <div className="pdf-pages" ref={containerRef} />
    </div>
  );
}

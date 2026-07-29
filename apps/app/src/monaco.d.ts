/**
 * monaco-editor 的 exports map 把 `monaco-editor/*` 對映到 `esm/vs/*.js`，
 * 這些 worker 進入點沒有型別宣告。
 */
declare module 'monaco-editor/esm/vs/editor/editor.worker?worker' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
declare module 'monaco-editor/esm/vs/language/json/json.worker?worker' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
declare module 'monaco-editor/esm/vs/language/typescript/ts.worker?worker' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
declare module 'monaco-editor/esm/vs/language/css/css.worker?worker' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
declare module 'monaco-editor/esm/vs/language/html/html.worker?worker' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
declare module 'pdfjs-dist/build/pdf.worker.min.mjs?worker' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}

interface Window {
  MonacoEnvironment?: {
    getWorker(workerId: string, label: string): Worker;
  };
}

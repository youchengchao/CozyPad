import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';

// workers 由 Vite 打包成同源檔案，符合 Electron CSP（不走 CDN）。
window.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new JsonWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    return new EditorWorker();
  },
};

monaco.editor.defineTheme('cozypad-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#101014',
    'editorGutter.background': '#101014',
    'editor.lineHighlightBackground': '#17171c',
    'editorLineNumber.foreground': '#5c5c66',
    'editorLineNumber.activeForeground': '#ffb454',
    'editorCursor.foreground': '#ffb454',
    'editor.selectionBackground': '#2b2416',
    'editorIndentGuide.background1': '#26262e',
  },
});

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  json: 'json', py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', sh: 'shell', bash: 'shell',
  zsh: 'shell', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini',
  md: 'markdown', markdown: 'markdown', html: 'html', css: 'css', scss: 'scss',
  sql: 'sql', xml: 'xml', dart: 'dart', php: 'php', lua: 'lua', dockerfile: 'dockerfile',
};

export function languageForPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name.startsWith('.bash') || name.startsWith('.zsh')) return 'shell';
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1) : '';
  return EXTENSION_LANGUAGE[ext] ?? 'plaintext';
}

interface CodeEditorProps {
  path: string;
  value: string;
  onChange(value: string): void;
  onSave(): void;
}

/** Cursor/VS Code 同款編輯器核心（Monaco）：語法高亮、行號、多游標、搜尋、Ctrl+S。 */
export function CodeEditor({ path, value, onChange, onSave }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const editor = monaco.editor.create(container, {
      value,
      language: languageForPath(path),
      theme: 'cozypad-dark',
      automaticLayout: true,
      fontSize: 13,
      fontFamily: '"Cascadia Mono", Consolas, "Noto Sans Mono CJK TC", monospace',
      minimap: { enabled: true, maxColumn: 80 },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      tabSize: 2,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      padding: { top: 10 },
    });
    editorRef.current = editor;
    if (import.meta.env.DEV) {
      (window as unknown as { __monacoDebug?: unknown }).__monacoDebug = editor;
    }

    // 容器在建立當下若尚未可見（切換工作區、視窗未合成），Monaco 會略過首次繪製。
    const forceRender = setTimeout(() => {
      editor.layout();
      editor.render(true);
    }, 0);
    const visibility = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        editor.layout();
        editor.render(true);
      }
    });
    visibility.observe(container);

    const changeSub = editor.onDidChangeModelContent(() => {
      onChangeRef.current(editor.getValue());
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current();
    });

    return () => {
      clearTimeout(forceRender);
      visibility.disconnect();
      changeSub.dispose();
      editor.getModel()?.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // 只在切換檔案時重建 editor；value 變更由下方 effect 同步。
  }, [path]);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) editor.setValue(value);
  }, [value]);

  return <div className="code-editor" ref={containerRef} />;
}

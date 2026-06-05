import Editor from '@monaco-editor/react';
import { monacoLanguageFromPath } from '@renderer/lib/editor-language';
import { MythraMark } from './MythraMark';

interface EditorPanelProps {
  filePath?: string;
  content: string;
  openFiles?: Array<{ path: string; dirty: boolean; readOnly?: boolean }>;
  imagePreview?: { mimeType: string; dataUrl: string };
  readOnly?: boolean;
  readOnlyReason?: string;
  dirty: boolean;
  onChange: (next: string) => void;
  onCloseFile?: (path: string) => void;
  onSave: () => void;
  onSelectFile?: (path: string) => void;
}

export function EditorPanel({
  filePath,
  content,
  openFiles = [],
  imagePreview,
  readOnly,
  readOnlyReason,
  dirty,
  onChange,
  onCloseFile,
  onSave,
  onSelectFile
}: EditorPanelProps) {
  if (!filePath) {
    return (
      <section className="workspace-empty">
        <div className="workspace-empty__eyebrow">
          <MythraMark />
          <span className="workspace-empty__eyebrow-suffix">· Console</span>
        </div>
        <h2>Open a workspace, pick a file, then wire your model settings on the right.</h2>
        <p>
          This starter app already supports local folders, file editing, command streaming, theme switching, and live
          chat against LM Studio, OpenRouter, or Ollama.
        </p>
      </section>
    );
  }

  return (
    <section className="editor-panel">
      {openFiles.length > 0 ? (
        <div className="editor-tabs" role="tablist" aria-label="Open files">
          {openFiles.map((file) => (
            <button
              className={`editor-tab ${file.path === filePath ? 'is-active' : ''}`}
              key={file.path}
              onClick={() => onSelectFile?.(file.path)}
              title={file.path}
              type="button"
            >
              <span>{file.path.split(/[/\\]/).pop() ?? file.path}</span>
              {file.dirty ? <b aria-label="Unsaved changes" /> : null}
              {onCloseFile ? (
                <i
                  aria-label="Close file"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseFile(file.path);
                  }}
                  role="button"
                  tabIndex={0}
                >
                  x
                </i>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      <div className="editor-panel__header">
        <div>
          <div className="section-kicker">Editor Matrix</div>
          <div className="editor-panel__path">{filePath}</div>
        </div>
        <button
          className="action-button"
          disabled={Boolean(imagePreview) || Boolean(readOnly)}
          onClick={onSave}
          title={imagePreview ? 'Preview-only for images' : readOnlyReason}
          type="button"
        >
          {imagePreview ? 'Image preview' : readOnly ? 'Read-only preview' : dirty ? 'Save Buffer' : 'Saved'}
        </button>
      </div>
      {imagePreview ? (
        <div className="editor-image-preview">
          <img
            alt={filePath.split(/[/\\]/).pop() ?? 'Image'}
            className="editor-image-preview__img"
            src={imagePreview.dataUrl}
          />
        </div>
      ) : (
        <div className="editor-shell">
          <Editor
            height="100%"
            defaultLanguage={monacoLanguageFromPath(filePath)}
            language={monacoLanguageFromPath(filePath)}
            path={filePath}
            value={content}
            onChange={(next) => {
              if (!readOnly) onChange(next ?? '');
            }}
            theme="vs-dark"
            options={{
              readOnly: Boolean(readOnly),
              readOnlyMessage: { value: readOnlyReason ?? 'This preview is read-only.' },
              minimap: { enabled: false },
              fontSize: 14,
              smoothScrolling: true,
              cursorBlinking: 'phase',
              wordWrap: 'on',
              renderLineHighlight: 'all',
              padding: { top: 18, bottom: 18 }
            }}
          />
        </div>
      )}
    </section>
  );
}

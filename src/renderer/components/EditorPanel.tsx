import Editor from '@monaco-editor/react';
import { OpenKiwiMark } from './OpenKiwiMark';

interface EditorPanelProps {
  filePath?: string;
  content: string;
  imagePreview?: { mimeType: string; dataUrl: string };
  dirty: boolean;
  onChange: (next: string) => void;
  onSave: () => void;
}

export function EditorPanel({ filePath, content, imagePreview, dirty, onChange, onSave }: EditorPanelProps) {
  if (!filePath) {
    return (
      <section className="workspace-empty">
        <div className="workspace-empty__eyebrow">
          <OpenKiwiMark />
          <span className="workspace-empty__eyebrow-suffix">· Console</span>
        </div>
        <h2>Open a workspace, pick a file, then wire your model settings on the right.</h2>
        <p>
          This starter app already supports local folders, file editing, command streaming, theme switching, and live
          chat against LM Studio or OpenRouter.
        </p>
      </section>
    );
  }

  return (
    <section className="editor-panel">
      <div className="editor-panel__header">
        <div>
          <div className="section-kicker">Editor Matrix</div>
          <div className="editor-panel__path">{filePath}</div>
        </div>
        <button
          className="action-button"
          disabled={Boolean(imagePreview)}
          onClick={onSave}
          title={imagePreview ? 'Preview-only for images' : undefined}
          type="button"
        >
          {imagePreview ? 'Image preview' : dirty ? 'Save Buffer' : 'Saved'}
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
            defaultLanguage="typescript"
            path={filePath}
            value={content}
            onChange={(next) => onChange(next ?? '')}
            theme="vs-dark"
            options={{
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

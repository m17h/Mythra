import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

const markdownComponents: Components = {
  a: ({ children, node, ...rest }) => (
    <a {...rest} rel="noopener noreferrer" target="_blank">
      {children}
    </a>
  ),
  table: ({ children, node, ...rest }) => (
    <div className="table-wrap">
      <table {...rest}>{children}</table>
    </div>
  )
};

interface ChatMarkdownProps {
  text: string;
}

export function ChatMarkdown({ text }: ChatMarkdownProps) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm, remarkBreaks]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ClipboardList } from 'lucide-react';

const baseClass =
  'text-[14px] leading-relaxed break-words [&>p]:mt-0 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0 [&>p]:mb-2 [&>ul]:my-2 [&>ol]:my-2 [&>pre]:my-2 [&>pre]:overflow-x-auto [&>pre]:rounded-md [&>pre]:p-3 [&>pre]:text-[13px] [&>code]:rounded [&>code]:px-1 [&>code]:py-0.5 [&>pre_code]:p-0 [&>pre_code]:bg-transparent';

const MARKDOWN_COMPONENTS = {
  p: ({ children }: { children?: React.ReactNode }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
  li: ({ children }: { children?: React.ReactNode }) => <li className="leading-relaxed">{children}</li>,
  code: ({ className, children, ...props }: { className?: string; children?: React.ReactNode }) => {
    const isBlock = className?.includes('language-');
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="font-mono bg-[color:var(--cs-muted)]/30 text-[13px]"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="overflow-x-auto rounded-md bg-[color:var(--cs-muted)]/20 p-3 text-[13px] font-mono">
      {children}
    </pre>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => <strong className="font-semibold">{children}</strong>,
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline text-[color:var(--cs-accent)] hover:opacity-80"
    >
      {children}
    </a>
  ),
  h1: ({ children }: { children?: React.ReactNode }) => <h1 className="text-base font-semibold mt-2 mb-1">{children}</h1>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2 className="text-[15px] font-semibold mt-2 mb-1">{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3 className="text-sm font-semibold mt-2 mb-1">{children}</h3>,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-[color:var(--cs-border)] pl-3 my-2 text-[color:var(--cs-muted)]">
      {children}
    </blockquote>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border border-[color:var(--cs-border)] px-2 py-1 text-left font-medium bg-[color:var(--cs-muted)]/20">
      {children}
    </th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border border-[color:var(--cs-border)] px-2 py-1">{children}</td>
  ),
  tr: ({ children }: { children?: React.ReactNode }) => <tr>{children}</tr>,
  thead: ({ children }: { children?: React.ReactNode }) => <thead>{children}</thead>,
  tbody: ({ children }: { children?: React.ReactNode }) => <tbody>{children}</tbody>,
};

function parseScratchpadSegments(content: string): Array<{ type: 'markdown' | 'scratchpad'; content: string }> {
  const parts: Array<{ type: 'markdown' | 'scratchpad'; content: string }> = [];
  const re = /<scratchpad>([\s\S]*?)<\/scratchpad>/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'markdown', content: content.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'scratchpad', content: match[1].trim() });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    parts.push({ type: 'markdown', content: content.slice(lastIndex) });
  }
  if (parts.length === 0) {
    parts.push({ type: 'markdown', content });
  }
  return parts;
}

export function ChatMarkdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  const segments = parseScratchpadSegments(content);
  return (
    <div className={[baseClass, className].filter(Boolean).join(' ')}>
      {segments.map((segment, i) =>
        segment.type === 'scratchpad' ? (
          <div
            key={i}
            className="my-3 rounded-lg border border-amber-500/40 bg-amber-500/5 dark:border-amber-400/30 dark:bg-amber-500/10"
          >
            <div className="flex items-center gap-2 border-b border-amber-500/30 px-3 py-2 text-[12px] font-medium text-amber-700 dark:border-amber-400/20 dark:text-amber-400">
              <ClipboardList className="h-3.5 w-3.5 shrink-0" />
              Execution plan
            </div>
            <div className="px-3 py-2.5">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                {segment.content}
              </ReactMarkdown>
            </div>
          </div>
        ) : (
          <ReactMarkdown
            key={i}
            remarkPlugins={[remarkGfm]}
            components={MARKDOWN_COMPONENTS}
          >
            {segment.content}
          </ReactMarkdown>
        ),
      )}
    </div>
  );
}

'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const baseClass =
  'text-[14px] leading-relaxed break-words [&>p]:mt-0 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0 [&>p]:mb-2 [&>ul]:my-2 [&>ol]:my-2 [&>pre]:my-2 [&>pre]:overflow-x-auto [&>pre]:rounded-md [&>pre]:p-3 [&>pre]:text-[13px] [&>code]:rounded [&>code]:px-1 [&>code]:py-0.5 [&>pre_code]:p-0 [&>pre_code]:bg-transparent';

export function ChatMarkdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={[baseClass, className].filter(Boolean).join(' ')}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          code: ({ className, children, ...props }) => {
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
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-md bg-[color:var(--cs-muted)]/20 p-3 text-[13px] font-mono">
              {children}
            </pre>
          ),
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-[color:var(--cs-accent)] hover:opacity-80"
            >
              {children}
            </a>
          ),
          h1: ({ children }) => <h1 className="text-base font-semibold mt-2 mb-1">{children}</h1>,
          h2: ({ children }) => <h2 className="text-[15px] font-semibold mt-2 mb-1">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-1">{children}</h3>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-[color:var(--cs-border)] pl-3 my-2 text-[color:var(--cs-muted)]">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="min-w-full border-collapse text-[13px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-[color:var(--cs-border)] px-2 py-1 text-left font-medium bg-[color:var(--cs-muted)]/20">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-[color:var(--cs-border)] px-2 py-1">{children}</td>
          ),
          tr: ({ children }) => <tr>{children}</tr>,
          thead: ({ children }) => <thead>{children}</thead>,
          tbody: ({ children }) => <tbody>{children}</tbody>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

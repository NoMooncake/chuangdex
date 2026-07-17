import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownMessageProps {
  content: string
}

export function MarkdownMessage({ content }: MarkdownMessageProps): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }: { href?: string; children?: ReactNode }) => (
          <a
            href={href}
            className="md-link"
            title={href}
            onClick={(event) => {
              event.preventDefault()
              if (href) window.chuangdex.openExternal(href)
            }}
          >
            {children}
          </a>
        ),
        blockquote: ({ children }: { children?: ReactNode }) => (
          <blockquote className="md-blockquote">{children}</blockquote>
        ),
        code: ({ inline, className, children }: { inline?: boolean; className?: string; children?: ReactNode }) => {
          const match = /language-(\w+)/.exec(className || '')
          const lang = match ? match[1] : ''
          return !inline ? (
            <div className="md-code-block">
              {lang && <div className="md-code-lang">{lang}</div>}
              <pre className="md-pre">
                <code className={className}>{children}</code>
              </pre>
            </div>
          ) : (
            <code className="md-inline-code">{children}</code>
          )
        },
        h1: ({ children }: { children?: ReactNode }) => <h1 className="md-h md-h1">{children}</h1>,
        h2: ({ children }: { children?: ReactNode }) => <h2 className="md-h md-h2">{children}</h2>,
        h3: ({ children }: { children?: ReactNode }) => <h3 className="md-h md-h3">{children}</h3>,
        h4: ({ children }: { children?: ReactNode }) => <h4 className="md-h md-h4">{children}</h4>,
        h5: ({ children }: { children?: ReactNode }) => <h5 className="md-h md-h5">{children}</h5>,
        h6: ({ children }: { children?: ReactNode }) => <h6 className="md-h md-h6">{children}</h6>,
        hr: () => <hr className="md-hr" />,
        p: ({ children }: { children?: ReactNode }) => <p className="md-p">{children}</p>,
        ul: ({ children }: { children?: ReactNode }) => <ul className="md-ul">{children}</ul>,
        ol: ({ children }: { children?: ReactNode }) => <ol className="md-ol">{children}</ol>,
        li: ({ children }: { children?: ReactNode }) => <li className="md-li">{children}</li>,
        strong: ({ children }: { children?: ReactNode }) => <strong className="md-strong">{children}</strong>,
        em: ({ children }: { children?: ReactNode }) => <em className="md-em">{children}</em>,
        table: ({ children }: { children?: ReactNode }) => (
          <div className="md-table-wrap">
            <table className="md-table">{children}</table>
          </div>
        ),
        thead: ({ children }: { children?: ReactNode }) => <thead className="md-thead">{children}</thead>,
        tbody: ({ children }: { children?: ReactNode }) => <tbody className="md-tbody">{children}</tbody>,
        tr: ({ children }: { children?: ReactNode }) => <tr className="md-tr">{children}</tr>,
        th: ({ children }: { children?: ReactNode }) => <th className="md-th">{children}</th>,
        td: ({ children }: { children?: ReactNode }) => <td className="md-td">{children}</td>
      }}
    >
      {content}
    </ReactMarkdown>
  )
}

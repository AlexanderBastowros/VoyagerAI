/**
 * Pure presentational Markdown renderer.
 *
 * Markdown text is parsed to a React element tree via `react-markdown` —
 * never through `innerHTML` — so the renderer process never executes
 * arbitrary HTML or scripts sourced from model output.
 *
 * Raw HTML embedded in the input (e.g. a model emitting `<script>` or
 * `<img onerror=...>`) is deliberately neutralized by OMITTING the
 * `rehype-raw` plugin: without it, react-markdown renders raw HTML nodes as
 * escaped literal text rather than real elements. Do not "fix" this by
 * adding `rehype-raw` — that would reintroduce the injection surface this
 * component exists to close.
 *
 * This component has no knowledge of the chat message shape and no store
 * dependency; it renders any plain string. That keeps it reusable for
 * transcripts rehydrated from disk in a later roadmap item.
 *
 * Because markdown is often rendered mid-stream (one token at a time),
 * partial input is expected and degrades gracefully per CommonMark: an
 * unterminated `**` renders as a literal `**`, and an unclosed code fence
 * renders as an open code block. No special-casing is needed for this.
 */
import React from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

export interface MarkdownProps {
  text: string
}

// Links never navigate the Electron window itself; they always open in the
// user's default browser via a new (OS-handled) target.
// Images are never rendered as <img> — model output could otherwise cause
// the renderer to fetch arbitrary remote resources. The alt text (or the
// raw src if there's no alt) is shown as plain text instead.
const componentOverrides: Components = {
  a: ({ href, children, ...props }) => (
    <a {...props} href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  img: ({ alt, src }) => <span className="chat-markdown-image-placeholder">{alt || src || ''}</span>
}

function MarkdownComponent({ text }: MarkdownProps): React.JSX.Element {
  return (
    <div className="chat-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={componentOverrides}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

export const Markdown = React.memo(MarkdownComponent)

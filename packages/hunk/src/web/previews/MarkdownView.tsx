/** @jsxImportSource react */
/**
 * Renders a parsed Markdown tree (`./markdown.ts`) as React elements, and nothing else.
 *
 * There is no `dangerouslySetInnerHTML` and no node type that carries markup, so raw HTML in
 * the source arrives here as text and React escapes it. Links are the only elements with a
 * target, already restricted to `http:` and `https:` by the parser, and open in a new tab with
 * `rel="noopener noreferrer"`. A table clipped at `MAX_TABLE_COLUMNS` and a document cut at the
 * parser's node budget each say so in place, so nothing is dropped silently.
 */
import type { ReactNode } from "react";
import { MAX_TABLE_COLUMNS, type MarkdownBlock, type MarkdownInline } from "./markdown";

/** Render inline nodes. */
function inline(nodes: readonly MarkdownInline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "code":
        return <code key={index}>{node.text}</code>;
      case "emphasis":
        return <em key={index}>{inline(node.children)}</em>;
      case "strong":
        return <strong key={index}>{inline(node.children)}</strong>;
      case "strike":
        return <del key={index}>{inline(node.children)}</del>;
      case "link":
        return (
          <a key={index} href={node.href} target="_blank" rel="noopener noreferrer">
            {inline(node.children)}
          </a>
        );
      case "break":
        return <br key={index} />;
    }
  });
}

/** Render blocks. */
function blocks(nodes: readonly MarkdownBlock[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "heading": {
        const Tag = `h${node.level}` as "h1";
        return <Tag key={index}>{inline(node.children)}</Tag>;
      }
      case "paragraph":
        return <p key={index}>{inline(node.children)}</p>;
      case "code":
        return (
          <pre key={index} data-language={node.language}>
            <code>{node.text}</code>
          </pre>
        );
      case "quote":
        return <blockquote key={index}>{blocks(node.children)}</blockquote>;
      case "list": {
        const items = node.items.map((item, itemIndex) => <li key={itemIndex}>{blocks(item)}</li>);
        return node.ordered ? (
          <ol key={index} {...(node.start !== undefined ? { start: node.start } : {})}>
            {items}
          </ol>
        ) : (
          <ul key={index}>{items}</ul>
        );
      }
      case "rule":
        return <hr key={index} />;
      case "table":
        return (
          <div key={index} className="markdown-table">
            <table>
              <thead>
                <tr>
                  {node.header.map((cell, column) => (
                    <th key={column} style={{ textAlign: node.align[column] }}>
                      {inline(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {node.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, column) => (
                      <td key={column} style={{ textAlign: node.align[column] }}>
                        {inline(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {node.clipped ? (
              <p className="file-placeholder" role="note" data-testid="markdown-table-clipped">
                Columns past the first {MAX_TABLE_COLUMNS} are not shown.
              </p>
            ) : null}
          </div>
        );
      case "truncated":
        return (
          <p
            key={index}
            className="file-placeholder"
            role="note"
            data-testid="markdown-preview-truncated"
          >
            Preview truncated: the rest of this document is too large to render. Show the diff to
            read all of it.
          </p>
        );
    }
  });
}

/** One rendered Markdown document. */
export function MarkdownView({ document }: { document: readonly MarkdownBlock[] }) {
  return <div className="markdown-view">{blocks(document)}</div>;
}

// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { ExternalLink, Info } from "lucide-react";
import type { DocBlock } from "../../types/docs";
import { BRAND } from "../../constants/brand";
import { CodeBlock } from "../common/CodeBlock";

interface DocsBlocksProps {
  blocks: DocBlock[];
}

export const DocsBlocks: React.FC<DocsBlocksProps> = ({ blocks }) => {
  return (
    <div className="space-y-4">
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;
        switch (block.kind) {
          case "lead":
            return (
              <p
                key={key}
                className="text-sm leading-relaxed text-slate-600 dark:text-slate-300"
              >
                {block.text}
              </p>
            );
          case "heading":
            return (
              <h3
                key={key}
                className="pt-2 text-sm font-semibold text-stone-ink dark:text-slate-100"
              >
                {block.text}
              </h3>
            );
          case "paragraph":
            return (
              <p
                key={key}
                className="text-sm leading-relaxed text-slate-600 dark:text-slate-300"
              >
                {block.text}
              </p>
            );
          case "list": {
            const items = block.items.map((item, itemIndex) => (
              <li key={`${key}-${itemIndex}`} className="leading-relaxed">
                {item}
              </li>
            ));
            return block.ordered ? (
              <ol
                key={key}
                className="list-decimal space-y-1.5 pl-5 text-sm text-slate-600 dark:text-slate-300"
              >
                {items}
              </ol>
            ) : (
              <ul
                key={key}
                className="list-disc space-y-1.5 pl-5 text-sm text-slate-600 dark:text-slate-300"
              >
                {items}
              </ul>
            );
          }
          case "code":
            return (
              <CodeBlock
                key={key}
                code={block.code}
                language={block.language ?? "bash"}
              />
            );
          case "callout":
            return (
              <div
                key={key}
                role="note"
                className="flex items-start gap-2.5 rounded-md border border-[var(--accent)]/30 bg-[var(--accent-soft)] p-3.5 text-sm text-[var(--text)]"
              >
                <Info
                  className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--accent)]"
                  aria-hidden="true"
                />
                <div className="space-y-1">
                  <p className="font-semibold text-stone-ink dark:text-slate-100">
                    {block.title}
                  </p>
                  <p className="leading-relaxed text-slate-600 dark:text-slate-300">
                    {block.text}
                  </p>
                </div>
              </div>
            );
          case "links":
            return (
              <div key={key} className="flex flex-wrap gap-2">
                {block.items.map((item) => (
                  <a
                    key={item.path}
                    href={`${BRAND.githubUrl}${item.path}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded border border-slate-200 px-2.5 py-1.5 text-sm text-slate-600 hover:border-junctura-blue hover:text-junctura-blue dark:border-[#243843] dark:text-slate-300 dark:hover:border-[var(--accent)] dark:hover:text-[var(--accent)]"
                  >
                    {item.label}
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                ))}
              </div>
            );
          case "terms":
            return (
              <dl key={key} className="space-y-2.5">
                {block.items.map((item) => (
                  <div key={item.term}>
                    <dt className="text-sm font-semibold text-stone-ink dark:text-slate-100">
                      {item.term}
                    </dt>
                    <dd className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                      {item.description}
                    </dd>
                  </div>
                ))}
              </dl>
            );
          case "faq":
            return (
              <div key={key} className="space-y-2">
                {block.items.map((item) => (
                  <details
                    key={item.question}
                    className="group rounded-md border border-slate-200/80 bg-white/60 px-3.5 py-3 dark:border-[#243843] dark:bg-[#13242D]"
                  >
                    <summary className="cursor-pointer list-none text-sm font-semibold text-stone-ink marker:content-none dark:text-slate-100">
                      <span className="flex items-center justify-between gap-3">
                        {item.question}
                        <span
                          className="text-slate-400 transition-transform group-open:rotate-45"
                          aria-hidden="true"
                        >
                          +
                        </span>
                      </span>
                    </summary>
                    <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                      {item.answer}
                    </p>
                  </details>
                ))}
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
};

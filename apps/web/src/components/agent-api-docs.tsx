"use client";

import { agentApiDocs, agentApiDocsMarkdown } from "@/lib/open-api/agent-docs";
import { toast } from "@/components/toast";

function downloadText(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function AgentApiDocs() {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const sections = agentApiDocs(origin || "https://你的域名");

  async function exportOpenApi() {
    const response = await fetch("/api/v1/open/openapi.json");
    if (!response.ok) {
      toast("导出失败", "err");
      return;
    }
    const spec = await response.json();
    if (origin) spec.servers = [{ url: `${origin}/api/v1/open` }];
    downloadText("kaimi-openapi.json", JSON.stringify(spec, null, 2), "application/json");
  }

  return (
    <section className="km-panel space-y-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">接口说明</h2>
        <div className="flex flex-wrap gap-2">
          <button
            className="km-btn km-btn-ghost"
            onClick={() => downloadText("kaimi-api.md", agentApiDocsMarkdown(origin || "https://你的域名"), "text/markdown")}
          >
            导出 Markdown
          </button>
          <button className="km-btn km-btn-ghost" onClick={() => void exportOpenApi()}>
            导出 OpenAPI
          </button>
        </div>
      </div>
      <p className="text-[var(--km-fg-muted)]">
        Markdown 给人看，OpenAPI JSON 可以导入 Apifox 或 Postman。导出的 OpenAPI 会写成当前站点地址。
      </p>
      {sections.map((section) => (
        <article key={section.id} className="space-y-2 border-t border-[var(--km-border)] pt-3">
          <h3 className="font-semibold">{section.title}</h3>
          {section.blocks.map((block, index) => {
            if (block.kind === "p") return <p key={index}>{block.text}</p>;
            if (block.kind === "code") {
              return (
                <pre key={index} className="overflow-x-auto rounded bg-[var(--km-bg)] p-3">
                  {block.text}
                </pre>
              );
            }
            return (
              <div key={index} className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-[var(--km-border)]">
                      {block.headers.map((header) => (
                        <th key={header} className="py-1 pr-3">{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row) => (
                      <tr key={row.join("|")} className="border-b border-[var(--km-border)]">
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex} className="py-1 pr-3 align-top">{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </article>
      ))}
    </section>
  );
}

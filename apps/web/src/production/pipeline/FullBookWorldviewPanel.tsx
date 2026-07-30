import { useEffect, useRef, useState } from "react";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../../components/ui/accordion";
import type { Chapter } from "../types";
import {
  mapFullBookWorldview, readFullBookWorldview, type FullBookWorldview, type WorldviewDetail,
} from "./full-book-worldview";

type ReadState = "loading" | "ready" | "failed" | "interrupted";

export function FullBookWorldviewPanel({ runId, chapters, onClose }: {
  runId: string; chapters: Chapter[]; onClose: () => void;
}) {
  const [state, setState] = useState<ReadState>("loading");
  const [worldview, setWorldview] = useState<FullBookWorldview | undefined>(undefined);
  const [message, setMessage] = useState("正在读取全书世界观…");
  const [requestKey, setRequestKey] = useState(0);
  const controllerRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setState("loading");
    setMessage("正在读取全书世界观…");
    readFullBookWorldview(runId, controller.signal).then((result) => {
      setWorldview(result);
      setState("ready");
      setMessage("全书世界观读取完成。");
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setState("failed");
      setMessage(`全书世界观读取失败：${(error as Error).message}`);
    });
    return () => controller.abort();
  }, [runId, requestKey]);

  const stop = () => {
    controllerRef.current?.abort();
    setState("interrupted");
    setMessage("全书世界观读取已中断，未修改任何内容。");
  };
  const chapterName = (id: string) => {
    const chapter = chapters.find((item) => item.id === id);
    return chapter ? `第${chapter.chapter_index + 1}章 · ${chapter.title}` : id;
  };

  return <section className="border border-[var(--border-subtle)] bg-[var(--bg-surface)]" aria-labelledby="full-book-worldview-heading">
    <header className="flex min-h-14 items-center justify-between gap-4 border-b border-[var(--border-subtle)] px-4 py-3">
      <div>
        <h3 id="full-book-worldview-heading" className="m-0 text-base font-semibold">全书世界观</h3>
        <p className="mt-1 text-xs text-[var(--fg-tertiary)]">当前流水线最终结果，只读</p>
      </div>
      {state === "loading"
        ? <button type="button" className="min-h-11 rounded border border-[var(--border-strong)] px-4 text-sm font-semibold" onClick={stop}>中断读取</button>
        : <button type="button" className="min-h-11 rounded border border-[var(--border-strong)] px-4 text-sm font-semibold hover:bg-[var(--bg-subtle)]" onClick={onClose}>收起详情</button>}
    </header>

    <div className="min-h-11 border-b border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-4 py-3 text-sm text-[var(--fg-secondary)]" role={state === "failed" ? "alert" : "status"} aria-live="polite">
      {message}
      {(state === "failed" || state === "interrupted") ? <button type="button" className="ml-3 min-h-11 rounded border border-[var(--border-strong)] px-3 font-semibold" onClick={() => setRequestKey((value) => value + 1)}>重新读取</button> : null}
    </div>

    {worldview && state === "ready" ? <>
      <Accordion type="multiple" className="divide-y divide-[var(--border-subtle)]">
        {mapFullBookWorldview(worldview.content).map((section) => <AccordionItem key={section.key} value={section.key} className="border-0">
          <AccordionTrigger className="rounded-none px-4">
            <span>{section.label}</span><span className="ml-auto font-mono text-xs text-[var(--fg-tertiary)]">{section.entries.length}项</span>
          </AccordionTrigger>
          <AccordionContent>
            {section.entries.length ? <div className="divide-y divide-[var(--border-subtle)]">
              {section.entries.map((entry, index) => <article className="px-4 py-4" key={`${entry.title}:${index}`}>
                <h4 className="m-0 text-sm font-semibold">{entry.title}</h4>
                <div className="mt-2 grid gap-3">{entry.details.map((item, detailIndex) => <FactDetail key={detailIndex} detail={item} chapterName={chapterName} />)}</div>
              </article>)}
            </div> : <p className="m-0 px-4 py-4 text-sm text-[var(--fg-tertiary)]">当前没有此类内容。</p>}
          </AccordionContent>
        </AccordionItem>)}
      </Accordion>
      <details className="border-t border-[var(--border-subtle)] px-4 py-3">
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)]">高级只读信息</summary>
        <dl className="grid gap-x-6 gap-y-3 pb-3 text-sm md:grid-cols-2">
          <Metadata label="版本" value={`revision ${worldview.metadata.revision}`} />
          <Metadata label="覆盖章节" value={`${chapterName(worldview.metadata.sourceStartChapterId)} — ${chapterName(worldview.metadata.sourceEndChapterId)}`} />
          <Metadata label="模型服务" value={worldview.metadata.provider} />
          <Metadata label="模型" value={worldview.metadata.model} />
          <Metadata label="内容 Hash" value={worldview.metadata.contentHash} />
          <Metadata label="生成时间" value={new Date(worldview.metadata.createdAt).toLocaleString("zh-CN")} />
        </dl>
      </details>
    </> : null}
  </section>;
}

function FactDetail({ detail, chapterName }: { detail: WorldviewDetail; chapterName: (id: string) => string }) {
  return <div>
    {detail.label ? <span className="mb-1 block text-xs font-semibold text-[var(--fg-secondary)]">{detail.label}</span> : null}
    <p className="m-0 whitespace-pre-wrap text-sm leading-6 text-[var(--fg-primary)]">{detail.text}</p>
    <details className="mt-2 text-xs text-[var(--fg-tertiary)]">
      <summary className="min-h-11 cursor-pointer py-3 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)]">查看来源</summary>
      <div className="grid gap-2 border-l border-[var(--border-subtle)] pl-3 font-mono">
        <p className="m-0">章节：{detail.chapterIds.length ? detail.chapterIds.map(chapterName).join("；") : "条目未单列章节"}</p>
        <p className="m-0 break-all">来源事件：{detail.sourceEventIds.join("；")}</p>
      </div>
    </details>
  </div>;
}

function Metadata({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs text-[var(--fg-tertiary)]">{label}</dt><dd className="m-0 mt-1 break-all font-mono text-xs">{value}</dd></div>;
}

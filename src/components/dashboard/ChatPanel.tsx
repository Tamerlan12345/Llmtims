"use client";

import React, { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import { IconSend, IconSpinner, IconUser } from "@/components/icons";
import { Agent, ChatMessage } from "@/app/dashboard/types";
import { repairTextForDisplay } from "@/lib/text/repairMojibake";

interface ChatThreadSummary {
  id: string;
  title: string;
  updatedAt?: string | null;
  activeTaskId?: string | null;
}

interface LiveProcessStep {
  id: string;
  label: string;
  detail: string;
  time: string;
  tone?: "info" | "run" | "ok" | "warn" | "error";
}

interface ChatPanelProps {
  messages: ChatMessage[];
  liveSteps?: LiveProcessStep[];
  agents: Agent[];
  activeOfficeId: string | null;
  activeOfficeName: string;
  threads: ChatThreadSummary[];
  activeThreadId: string | null;
  threadLoading?: boolean;
  loading: boolean;
  typingLabel: string | null;
  onSelectThread: (threadId: string) => void;
  onCreateThread: () => void;
  onOpenAgentInstructions: () => void;
  onSendMessage: (content: string) => void;
}

const DOWNLOADABLE_FILE_URL_PATTERN = /\.(pdf|mp4|xlsx|xls|csv|docx?|zip|jpe?g|png|webp)(\?|#|$)/i;
const FALLBACK_IMAGE_ALT = "\u0418\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0435";
const CHAT_TITLE = "\u041E\u043F\u0435\u0440\u0430\u0442\u0438\u0432\u043D\u044B\u0439 \u0447\u0430\u0442";
const EMPTY_HISTORY_LABEL = "\u0418\u0441\u0442\u043E\u0440\u0438\u044F \u043F\u0443\u0441\u0442\u0430";
const NEW_CHAT_LABEL = "+ \u0427\u0430\u0442";
const INSTRUCTIONS_LABEL = "\u0418\u043D\u0441\u0442\u0440\u0443\u043A\u0446\u0438\u044F";
const LIVE_ACTIVITY_LABEL = "\u0410\u043A\u0442\u0438\u0432\u043D\u043E\u0441\u0442\u044C";
const ADMIN_LABEL = "\u0410\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440";
const AGENT_LABEL = "\u0410\u0433\u0435\u043D\u0442";
const THOUGHT_TRACE_LABEL = "\u0425\u043E\u0434 \u043C\u044B\u0441\u043B\u0435\u0439";
const AUTO_DEPLOY_LABEL = "\u0410\u0432\u0442\u043E-\u0434\u0435\u043F\u043B\u043E\u0439";
const APPLY_LABEL = "\u041F\u0440\u0438\u043C\u0435\u043D\u0438\u0442\u044C";
const CHAT_PLACEHOLDER = "\u0417\u0430\u043F\u0440\u043E\u0441\u0438\u0442\u044C \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435 \u0438\u043B\u0438 \u043E\u0442\u0447\u0435\u0442...";
const CONTENT_SECTION_PATTERN =
  /(?:^|\n)\s*(?:\*\*(Пост|Хэштеги|Визуал(?:\s*\(Арт-дирекшн\))?)\*\*|(Пост|Хэштеги|Визуал(?:\s*\(Арт-дирекшн\))?)):\s*/gi;

type StructuredSectionKind = "post" | "hashtags" | "visual";

interface StructuredSection {
  kind: StructuredSectionKind;
  label: string;
  content: string;
}

const normalizeDownloadName = (value: string) => {
  const normalized = repairTextForDisplay(value).split("\uD83D\uDCE5").join("").trim();
  return normalized.length > 0 ? normalized : "artifact";
};

const isDownloadableLink = (url: string, label: string) => {
  return repairTextForDisplay(label).includes("\uD83D\uDCE5") || DOWNLOADABLE_FILE_URL_PATTERN.test(url.toLowerCase());
};

const decodeEscapedChatContent = (content: string): string => {
  let source = repairTextForDisplay(String(content ?? ""));
  source = source
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "  ")
    .replace(/\\"/g, '"');

  if (
    source.length >= 2 &&
    source.startsWith('"') &&
    source.endsWith('"') &&
    (source.includes("\n") || source.includes("**"))
  ) {
    source = source.slice(1, -1);
  }

  return source.trim();
};

const normalizeStructuredKind = (label: string): StructuredSectionKind => {
  const normalized = label.toLowerCase();
  if (normalized.includes("хэштеги")) return "hashtags";
  if (normalized.includes("визуал")) return "visual";
  return "post";
};

const extractStructuredSections = (content: string): StructuredSection[] => {
  const matches = Array.from(content.matchAll(CONTENT_SECTION_PATTERN));
  if (matches.length === 0) return [];

  const sections: StructuredSection[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const label = String(match[1] ?? match[2] ?? "").trim();
    if (!label) continue;
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? content.length;
    const body = content.slice(start, end).trim();
    if (!body) continue;
    sections.push({
      kind: normalizeStructuredKind(label),
      label,
      content: body,
    });
  }

  return sections;
};

const renderRichText = (content: string, className = ""): ReactNode => {
  const source = decodeEscapedChatContent(content);
  if (!source.trim()) return null;

  const markdownTokenPattern = /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)/g;
  const tokens: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null = markdownTokenPattern.exec(source);

  while (match) {
    if (match.index > cursor) {
      tokens.push(source.slice(cursor, match.index));
    }

    const [fullMatch, imageAlt, imageSrc, linkText, linkHref] = match;
    const key = `chat-md-${match.index}-${fullMatch.length}`;

    if (imageSrc) {
      const src = String(imageSrc).trim();
      const alt = repairTextForDisplay(String(imageAlt ?? FALLBACK_IMAGE_ALT)).trim() || FALLBACK_IMAGE_ALT;
      tokens.push(
        <img
          key={key}
          src={src}
          alt={alt}
          className="mt-3 max-h-72 w-full rounded-2xl border border-red-200/10 bg-black/30 object-contain shadow-[0_12px_30px_rgba(0,0,0,0.35)]"
        />
      );
    } else if (linkHref) {
      const url = String(linkHref).trim();
      const text = repairTextForDisplay(String(linkText ?? "").trim() || url);
      const downloadable = isDownloadableLink(url, text);

      if (downloadable) {
        tokens.push(
          <a
            key={key}
            href={url}
            download={normalizeDownloadName(text)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-2 rounded-xl border border-red-400/35 bg-red-500/14 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-red-50 no-underline transition-all hover:bg-red-500/22"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={3}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
            {text}
          </a>
        );
      } else {
        tokens.push(
          <a
            key={key}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-red-400 hover:text-red-300 underline underline-offset-4 decoration-red-500/30"
          >
            {text}
          </a>
        );
      }
    }

    cursor = match.index + fullMatch.length;
    match = markdownTokenPattern.exec(source);
  }

  if (cursor < source.length) {
    tokens.push(source.slice(cursor));
  }

  return <div className={`whitespace-pre-wrap break-words ${className}`.trim()}>{tokens}</div>;
};

const renderHashtagSection = (content: string): ReactNode => {
  const source = decodeEscapedChatContent(content);
  const tags = Array.from(
    new Set(
      source
        .split(/[\s,]+/)
        .map((token) => token.trim())
        .filter((token) => /^#[^\s#]+/.test(token))
    )
  );

  if (tags.length === 0) {
    return renderRichText(source, "text-rose-50/82");
  }

  return (
    <div className="flex flex-wrap gap-2">
      {tags.map((tag) => (
        <span
          key={tag}
          className="rounded-full border border-red-300/18 bg-red-500/10 px-2.5 py-1 text-[11px] font-medium text-rose-100/88"
        >
          {tag}
        </span>
      ))}
    </div>
  );
};

const renderStructuredSection = (section: StructuredSection): ReactNode => {
  const labelClassName =
    section.kind === "post"
      ? "text-red-100"
      : section.kind === "hashtags"
        ? "text-amber-100"
        : "text-sky-100";
  const body =
    section.kind === "hashtags"
      ? renderHashtagSection(section.content)
      : renderRichText(
          section.content,
          section.kind === "visual" ? "text-rose-100/72 text-[13px]" : "text-rose-50/92"
        );

  return (
    <div
      key={`${section.kind}-${section.label}`}
      className={`rounded-2xl border px-4 py-3 ${
        section.kind === "post"
          ? "border-red-300/12 bg-white/[0.03]"
          : section.kind === "hashtags"
            ? "border-amber-300/12 bg-amber-500/[0.04]"
            : "border-sky-300/12 bg-sky-500/[0.04]"
      }`}
    >
      <div className={`mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] ${labelClassName}`}>
        {section.label}
      </div>
      {body}
    </div>
  );
};

const renderChatContent = (content: string): ReactNode => {
  const source = decodeEscapedChatContent(content);
  if (!source) return null;

  const sections = extractStructuredSections(source);
  if (sections.length > 0) {
    return <div className="space-y-3">{sections.map((section) => renderStructuredSection(section))}</div>;
  }

  return renderRichText(source, "text-rose-50/92");
};

export default function ChatPanel({
  messages,
  liveSteps = [],
  agents,
  activeOfficeId,
  activeOfficeName,
  threads,
  activeThreadId,
  threadLoading = false,
  loading,
  typingLabel,
  onSelectThread,
  onCreateThread,
  onOpenAgentInstructions,
  onSendMessage,
}: ChatPanelProps) {
  const [chatInput, setChatInput] = useState("");
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const [showEnvComposer, setShowEnvComposer] = useState(false);
  const [envServiceName, setEnvServiceName] = useState("");
  const [envKey, setEnvKey] = useState("");
  const [envValue, setEnvValue] = useState("");
  const [envDeployAfterSet, setEnvDeployAfterSet] = useState(true);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages, liveSteps, typingLabel, loading, activeThreadId]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || loading) return;
    onSendMessage(chatInput);
    setChatInput("");
  };

  const applyEnvCommand = () => {
    if (!envServiceName && !envKey) return;
    const deploySuffix = envDeployAfterSet ? " --deploy" : "";
    const command = `/railway env set ${envServiceName || "app"} ${envKey || "KEY"}=${envValue || "VALUE"}${deploySuffix}`;
    setChatInput(command);
    setShowEnvComposer(false);
  };

  const displayActiveOfficeName = repairTextForDisplay(activeOfficeName);
  const displayTypingLabel = typingLabel ? repairTextForDisplay(typingLabel) : null;

  return (
    <div className="flex flex-col h-full min-h-0 glass-card border-none bg-black/40 overflow-hidden">
      <div className="p-4 border-b border-red-200/10 flex flex-col gap-3 bg-black/20">
        <div className="flex items-center gap-3">
          <div className="status-indicator bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
          <h2 className="text-sm font-bold text-red-50 uppercase tracking-widest">{CHAT_TITLE}</h2>
          <div className="text-[10px] text-rose-100/30 font-mono">{activeOfficeId ?? "office"}</div>
        </div>
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex-1 min-w-0 overflow-x-auto custom-scrollbar">
            <div className="flex items-center gap-1.5">
              {threads.map((thread) => {
                const threadTitle = repairTextForDisplay(thread.title);
                return (
                  <button
                    key={thread.id}
                    type="button"
                    onClick={() => onSelectThread(thread.id)}
                    className={`shrink-0 rounded-lg border px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] transition-all ${
                      thread.id === activeThreadId
                        ? "border-red-400/60 bg-red-500/20 text-red-50"
                        : "border-red-200/20 bg-black/35 text-rose-100/55 hover:text-rose-100/90"
                    }`}
                    title={threadTitle}
                  >
                    {threadTitle}
                  </button>
                );
              })}
              {threads.length === 0 ? (
                <span className="text-[10px] text-rose-100/35 uppercase tracking-[0.14em] px-2">{EMPTY_HISTORY_LABEL}</span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onCreateThread}
            disabled={loading || threadLoading}
            className="shrink-0 rounded-lg border border-red-400/35 bg-black/45 px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-red-100/85 hover:text-red-50 disabled:opacity-40"
          >
            {NEW_CHAT_LABEL}
          </button>
          <button
            type="button"
            onClick={onOpenAgentInstructions}
            className="shrink-0 rounded-lg border border-red-400/35 bg-black/45 px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-red-100/85 hover:text-red-50"
          >
            {INSTRUCTIONS_LABEL}
          </button>
        </div>
        <div className="text-[10px] text-rose-100/40 font-mono">{displayActiveOfficeName}</div>
      </div>

      <div ref={chatScrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 chat-scroll custom-scrollbar">
        {liveSteps.length > 0 ? (
          <div className="space-y-2 rounded-2xl border border-red-300/15 bg-black/35 p-3">
            <div className="text-[10px] uppercase tracking-[0.18em] text-rose-100/40">{LIVE_ACTIVITY_LABEL}</div>
            <div className="space-y-2">
              {liveSteps.map((step) => (
                <div
                  key={step.id}
                  className={`rounded-xl border px-3 py-2 text-[11px] ${
                    step.tone === "error"
                      ? "border-red-500/40 bg-red-500/10 text-red-100"
                      : step.tone === "ok"
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
                        : step.tone === "warn"
                          ? "border-amber-500/30 bg-amber-500/10 text-amber-100"
                          : "border-red-200/10 bg-black/35 text-rose-100/70"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold uppercase tracking-[0.12em]">{repairTextForDisplay(step.label)}</span>
                    <span className="text-[10px] opacity-60">{step.time}</span>
                  </div>
                  <div className="mt-1 whitespace-pre-wrap break-words opacity-85">{repairTextForDisplay(step.detail)}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((item) => {
          const displayAgentName = repairTextForDisplay(item.agentName || item.role || AGENT_LABEL);
          const displayContent = repairTextForDisplay(item.content);
          const displayThoughtTrace = item.thoughtTrace ? repairTextForDisplay(item.thoughtTrace) : null;

          return (
            <div
              key={item.id}
              className={`flex ${item.sender === "user" ? "justify-end" : "justify-start"} items-start gap-3`}
            >
              {item.sender === "agent" ? (
                <div className="shrink-0 h-8 w-8 rounded-lg flex items-center justify-center bg-black/40 border border-red-200/20 text-red-500/60 shadow-inner">
                  <IconUser />
                </div>
              ) : null}

              <div
                className={`max-w-[88%] rounded-[22px] px-4 py-3.5 text-sm leading-relaxed shadow-[0_18px_40px_rgba(0,0,0,0.28)] ${
                  item.sender === "user"
                    ? "rounded-tr-none border border-red-500/35 bg-gradient-to-br from-red-600/20 to-violet-600/16 text-red-50"
                    : "rounded-tl-none border border-red-200/10 bg-black/55 text-rose-100 backdrop-blur-[2px]"
                }`}
              >
                <div className="mb-2 flex items-center gap-2 opacity-60">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.16em]">
                    {item.sender === "user" ? ADMIN_LABEL : displayAgentName}
                  </span>
                </div>
                <div className="text-rose-50/90 selection:bg-red-500/30">{renderChatContent(displayContent)}</div>
                {displayThoughtTrace ? (
                  <details className="mt-2 group">
                    <summary className="text-[10px] text-rose-100/40 cursor-pointer list-none flex items-center gap-1 hover:text-rose-100/70 transition-colors">
                      <span className="group-open:rotate-90 transition-transform">▸</span> {THOUGHT_TRACE_LABEL}
                    </summary>
                    <pre className="mt-2 text-[11px] p-2 bg-black/40 rounded border border-red-200/5 whitespace-pre-wrap text-rose-100/50 italic font-mono selection:bg-violet-500/30">
                      {displayThoughtTrace}
                    </pre>
                  </details>
                ) : null}
              </div>
            </div>
          );
        })}

        {displayTypingLabel ? (
          <div className="flex justify-start items-center gap-2 px-4 py-2 bg-black/40 rounded-xl border border-red-200/10 text-xs text-rose-100/50 animate-pulse">
            <IconSpinner /> {displayTypingLabel}
          </div>
        ) : null}
      </div>

      <div className="p-4 bg-black/40 border-t border-red-200/10 space-y-3">
        {showEnvComposer ? (
          <div className="p-3 bg-black/40 rounded-xl border border-red-200/20 space-y-3 animate-in fade-in slide-in-from-bottom-2">
            <div className="grid grid-cols-3 gap-2">
              <input
                placeholder="Service"
                value={envServiceName}
                onChange={(e) => setEnvServiceName(e.target.value)}
                className="bg-black/40 border border-red-200/10 rounded-lg p-2 text-xs text-white outline-none focus:border-red-500/40"
              />
              <input
                placeholder="KEY"
                value={envKey}
                onChange={(e) => setEnvKey(e.target.value)}
                className="bg-black/40 border border-red-200/10 rounded-lg p-2 text-xs text-white outline-none focus:border-red-500/40"
              />
              <input
                placeholder="VALUE"
                value={envValue}
                onChange={(e) => setEnvValue(e.target.value)}
                className="bg-black/40 border border-red-200/10 rounded-lg p-2 text-xs text-white outline-none focus:border-red-500/40"
              />
            </div>
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-[10px] text-rose-100/50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={envDeployAfterSet}
                  onChange={(e) => setEnvDeployAfterSet(e.target.checked)}
                  className="accent-red-500 opacity-60"
                />{" "}
                {AUTO_DEPLOY_LABEL}
              </label>
              <button
                type="button"
                onClick={applyEnvCommand}
                className="text-[10px] uppercase font-bold text-red-500 hover:text-red-400"
              >
                {APPLY_LABEL}
              </button>
            </div>
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowEnvComposer(!showEnvComposer)}
            className={`shrink-0 w-10 h-10 flex items-center justify-center rounded-xl border border-red-200/20 transition-all font-bold text-[10px] ${
              showEnvComposer
                ? "bg-red-500/20 border-red-500/50 text-red-50 shadow-[0_0_15px_rgba(232,0,30,0.1)]"
                : "bg-black/40 text-rose-100/40 hover:text-rose-100/80"
            }`}
          >
            ENV
          </button>
          <input
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            disabled={loading}
            placeholder={CHAT_PLACEHOLDER}
            className="flex-1 bg-black/40 border border-red-200/20 rounded-xl px-4 py-2 text-sm text-white placeholder:text-rose-100/20 outline-none focus:border-red-500/40 transition-all"
          />
          <button
            type="submit"
            disabled={!chatInput.trim() || loading}
            className="shrink-0 w-10 h-10 flex items-center justify-center rounded-xl bg-gradient-to-br from-red-600 to-violet-600 border border-red-500/40 text-white shadow-lg shadow-red-900/20 disabled:grayscale disabled:opacity-50 hover:scale-105 active:scale-95 transition-all"
          >
            <IconSend />
          </button>
        </form>
      </div>

      <style jsx global>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
          height: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(194, 21, 90, 0.2);
          border-radius: 10px;
        }
      `}</style>
    </div>
  );
}

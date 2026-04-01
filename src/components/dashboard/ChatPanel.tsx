"use client";

import React, { useRef, useState, useEffect, FormEvent, ReactNode } from "react";
import { IconSend, IconSpinner, IconUser } from "@/components/icons";
import { ChatMessage, Agent } from "@/app/dashboard/types";

interface ChatPanelProps {
  messages: ChatMessage[];
  agents: Agent[];
  activeOfficeId: string | null;
  activeOfficeName: string;
  loading: boolean;
  typingLabel: string | null;
  onSendMessage: (content: string) => void;
}

const DOWNLOADABLE_FILE_URL_PATTERN = /\.(pdf|mp4|xlsx|xls|csv|docx?|zip|jpe?g|png|webp)(\?|#|$)/i;

const normalizeDownloadName = (value: string) => {
  const normalized = value.replace(/📥/g, "").trim();
  return normalized.length > 0 ? normalized : "artifact";
};

const isDownloadableLink = (url: string, label: string) => {
  return label.includes("📥") || DOWNLOADABLE_FILE_URL_PATTERN.test(url.toLowerCase());
};

const renderChatContent = (content: string): ReactNode => {
  const source = String(content ?? "");
  if (!source.trim()) return null;

  // Basic regex for markdown-like links and images
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
      const alt = String(imageAlt ?? "Изображение").trim() || "Изображение";
      tokens.push(
        <img
          key={key}
          src={src}
          alt={alt}
          className="max-w-full h-auto rounded-lg shadow-sm border border-red-200/10 mt-2 max-h-64 object-contain bg-black/20"
        />
      );
    } else if (linkHref) {
      const url = String(linkHref).trim();
      const text = String(linkText ?? "").trim() || url;
      const downloadable = isDownloadableLink(url, text);

      if (downloadable) {
        tokens.push(
          <a
            key={key}
            href={url}
            download={normalizeDownloadName(text)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-3 py-1.5 mt-1 bg-red-600/20 border border-red-500/40 text-red-50 rounded-lg hover:bg-red-600/40 transition-all no-underline text-[11px] font-bold uppercase tracking-wider"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
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

  return <div className="whitespace-pre-wrap break-words">{tokens}</div>;
};

export default function ChatPanel({
  messages,
  agents,
  activeOfficeName,
  loading,
  typingLabel,
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
  }, [messages, typingLabel, loading]);

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

  return (
    <div className="flex flex-col h-full glass-card border-none bg-black/40 overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-red-200/10 flex items-center justify-between bg-black/20">
        <div className="flex items-center gap-3">
          <div className="status-indicator bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
          <h2 className="text-sm font-bold text-red-50 uppercase tracking-widest">Оперативный чат</h2>
        </div>
        <div className="text-[10px] text-rose-100/40 font-mono">{activeOfficeName}</div>
      </div>

      {/* Messages */}
      <div 
        ref={chatScrollRef}
        className="flex-1 overflow-y-auto p-4 space-y-4 chat-scroll custom-scrollbar"
      >
        {messages.map((item) => (
          <div key={item.id} className={`flex ${item.sender === "user" ? "justify-end" : "justify-start"} items-start gap-3`}>
            {item.sender === "agent" && (
              <div className="shrink-0 h-8 w-8 rounded-lg flex items-center justify-center bg-black/40 border border-red-200/20 text-red-500/60 shadow-inner">
                <IconUser />
              </div>
            )}
            
            <div 
              className={`max-w-[85%] px-4 py-3 rounded-2xl text-sm leading-relaxed shadow-lg ${
                item.sender === "user" 
                  ? "bg-gradient-to-br from-red-600/20 to-violet-600/20 border border-red-500/40 text-red-50 rounded-tr-none" 
                  : "bg-black/60 border border-red-200/10 text-rose-100 rounded-tl-none"
              }`}
            >
              <div className="flex items-center gap-2 mb-1 opacity-60">
                <span className="text-[10px] font-bold uppercase tracking-tighter">
                  {item.sender === "user" ? "Администратор" : (item.agentName || item.role || "Агент")}
                </span>
              </div>
              <div className="text-rose-50/90 selection:bg-red-500/30">
                {renderChatContent(item.content)}
              </div>
              {item.thoughtTrace && (
                <details className="mt-2 group">
                  <summary className="text-[10px] text-rose-100/40 cursor-pointer list-none flex items-center gap-1 hover:text-rose-100/70 transition-colors">
                    <span className="group-open:rotate-90 transition-transform">▶</span> Ход мыслей
                  </summary>
                  <pre className="mt-2 text-[11px] p-2 bg-black/40 rounded border border-red-200/5 whitespace-pre-wrap text-rose-100/50 italic font-mono selection:bg-violet-500/30">
                    {item.thoughtTrace}
                  </pre>
                </details>
              )}
            </div>
          </div>
        ))}
        {typingLabel && (
          <div className="flex justify-start items-center gap-2 px-4 py-2 bg-black/40 rounded-xl border border-red-200/10 text-xs text-rose-100/50 animate-pulse">
            <IconSpinner /> {typingLabel}
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="p-4 bg-black/40 border-t border-red-200/10 space-y-3">
        {showEnvComposer && (
          <div className="p-3 bg-black/40 rounded-xl border border-red-200/20 space-y-3 animate-in fade-in slide-in-from-bottom-2">
             <div className="grid grid-cols-3 gap-2">
                <input 
                  placeholder="Service" 
                  value={envServiceName} 
                  onChange={e => setEnvServiceName(e.target.value)}
                  className="bg-black/40 border border-red-200/10 rounded-lg p-2 text-xs text-white outline-none focus:border-red-500/40"
                />
                <input 
                  placeholder="KEY" 
                  value={envKey} 
                  onChange={e => setEnvKey(e.target.value)}
                  className="bg-black/40 border border-red-200/10 rounded-lg p-2 text-xs text-white outline-none focus:border-red-500/40"
                />
                <input 
                  placeholder="VALUE" 
                  value={envValue} 
                  onChange={e => setEnvValue(e.target.value)}
                  className="bg-black/40 border border-red-200/10 rounded-lg p-2 text-xs text-white outline-none focus:border-red-500/40"
                />
             </div>
             <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-[10px] text-rose-100/50 cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={envDeployAfterSet} 
                    onChange={e => setEnvDeployAfterSet(e.target.checked)}
                    className="accent-red-500 opacity-60"
                  /> Авто-деплой
                </label>
                <button 
                  onClick={applyEnvCommand}
                  className="text-[10px] uppercase font-bold text-red-500 hover:text-red-400"
                >
                  Применить
                </button>
             </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex gap-2">
          <button 
            type="button"
            onClick={() => setShowEnvComposer(!showEnvComposer)}
            className={`shrink-0 w-10 h-10 flex items-center justify-center rounded-xl border border-red-200/20 transition-all font-bold text-[10px] ${
              showEnvComposer ? "bg-red-500/20 border-red-500/50 text-red-50 shadow-[0_0_15px_rgba(232,0,30,0.1)]" : "bg-black/40 text-rose-100/40 hover:text-rose-100/80"
            }`}
          >
            ENV
          </button>
          <input 
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            disabled={loading}
            placeholder="Запросить действие или отчет..."
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
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(194, 21, 90, 0.2); border-radius: 10px; }
        @keyframes pulse {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}

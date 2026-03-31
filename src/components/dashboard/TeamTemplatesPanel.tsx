"use client";

import { FormEvent, useState } from "react";

export interface DashboardTeamTemplate {
  id: string;
  name: string;
  description?: string | null;
  rolesJson: Array<{
    roleKey: string;
    displayName: string;
    runtimeRole: "PM" | "Developer" | "QA" | "DevOps";
    skills: string[];
  }>;
}

interface TeamTemplatesPanelProps {
  officeName: string;
  templates: DashboardTeamTemplate[];
  isLoading: boolean;
  isHiringTemplateId: string | null;
  isSaving: boolean;
  onHireTemplate: (templateId: string) => void;
  onSaveCurrentTeam: (name: string, description: string) => void;
}

export default function TeamTemplatesPanel({
  officeName,
  templates,
  isLoading,
  isHiringTemplateId,
  isSaving,
  onHireTemplate,
  onSaveCurrentTeam,
}: TeamTemplatesPanelProps) {
  const [templateName, setTemplateName] = useState("");
  const [templateDescription, setTemplateDescription] = useState("");

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const normalizedName = templateName.trim();
    if (!normalizedName) return;
    onSaveCurrentTeam(normalizedName, templateDescription.trim());
    setTemplateName("");
    setTemplateDescription("");
  };

  return (
    <section
      className="rounded-xl px-4 py-4"
      style={{
        background: "rgba(8,2,6,0.76)",
        border: "1px solid rgba(194,21,90,0.24)",
        backdropFilter: "blur(12px)",
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-rose-100/55">
            Командные пресеты
          </div>
          <div className="mt-1 text-sm text-rose-50">
            Сохраните текущую комнату как пресет и нанимайте ее в другой офис в один клик.
          </div>
        </div>
        <div className="text-[11px] text-rose-100/60">
          Активный офис: {officeName}
        </div>
      </div>

      <form onSubmit={handleSubmit} className="mt-4 grid gap-2 lg:grid-cols-[1.1fr_1.4fr_auto]">
        <input
          type="text"
          value={templateName}
          onChange={(event) => setTemplateName(event.target.value)}
          placeholder="Название пресета"
          className="rounded-lg bg-black/35 px-3 py-2.5 text-sm text-white outline-none placeholder:text-rose-100/30"
          style={{ border: "1px solid rgba(194,21,90,0.22)" }}
        />
        <input
          type="text"
          value={templateDescription}
          onChange={(event) => setTemplateDescription(event.target.value)}
          placeholder="Короткое описание"
          className="rounded-lg bg-black/35 px-3 py-2.5 text-sm text-white outline-none placeholder:text-rose-100/30"
          style={{ border: "1px solid rgba(194,21,90,0.22)" }}
        />
        <button
          type="submit"
          disabled={isSaving}
          className="rounded-lg px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
          style={{
            background: "linear-gradient(135deg,#E8001E 0%,#C2155A 55%,#7B2FBE 100%)",
            border: "1px solid rgba(194,21,90,0.42)",
            color: "#fff",
          }}
        >
          {isSaving ? "Сохранение..." : "Сохранить текущую команду"}
        </button>
      </form>

      <div className="mt-4 grid gap-3 xl:grid-cols-2">
        {isLoading && (
          <div
            className="rounded-lg px-3 py-4 text-sm text-rose-100/60"
            style={{ background: "rgba(8,2,6,0.58)", border: "1px dashed rgba(194,21,90,0.22)" }}
          >
            Загружаю пресеты...
          </div>
        )}

        {!isLoading && templates.length === 0 && (
          <div
            className="rounded-lg px-3 py-4 text-sm text-rose-100/60"
            style={{ background: "rgba(8,2,6,0.58)", border: "1px dashed rgba(194,21,90,0.22)" }}
          >
            Пока нет сохраненных пресетов команд.
          </div>
        )}

        {templates.map((template) => (
          <div
            key={template.id}
            className="rounded-xl px-3 py-3"
            style={{
              background: "rgba(0,0,0,0.42)",
              border: "1px solid rgba(194,21,90,0.22)",
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-rose-50">{template.name}</div>
                <div className="mt-1 text-xs text-rose-100/62">
                  {template.description || "Переиспользуемый пресет комнаты"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onHireTemplate(template.id)}
                disabled={isHiringTemplateId === template.id}
                className="rounded-md px-3 py-1.5 text-[10px] uppercase tracking-[0.16em] disabled:opacity-50"
                style={{
                  background: "rgba(194,21,90,0.16)",
                  border: "1px solid rgba(194,21,90,0.32)",
                  color: "rgba(255,220,228,0.92)",
                }}
              >
                {isHiringTemplateId === template.id ? "Нанимаю..." : "Нанять в комнату"}
              </button>
            </div>

            <div className="mt-3 grid gap-2">
              {template.rolesJson.map((role) => (
                <div
                  key={`${template.id}-${role.roleKey}-${role.runtimeRole}`}
                  className="rounded-lg px-2.5 py-2"
                  style={{ background: "rgba(8,2,6,0.58)", border: "1px solid rgba(194,21,90,0.18)" }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-rose-50">{role.displayName}</div>
                    <div className="text-[10px] uppercase tracking-[0.16em] text-rose-100/60">
                      {role.runtimeRole}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {role.skills.length > 0 ? (
                      role.skills.map((skill) => (
                        <span
                          key={`${template.id}-${role.roleKey}-${skill}`}
                          className="rounded-md px-2 py-1 text-[10px] uppercase tracking-[0.14em]"
                          style={{
                            background: "rgba(194,21,90,0.10)",
                            border: "1px solid rgba(194,21,90,0.20)",
                            color: "rgba(255,220,228,0.86)",
                          }}
                        >
                          {skill}
                        </span>
                      ))
                    ) : (
                      <span className="text-[11px] text-rose-100/45">Скиллы не привязаны</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import PixelAgentSprite from "@/components/PixelAgentSprite";

interface Skill {
  id: string;
  name: string;
  description: string | null;
}

interface HireModalProps {
  isOpen: boolean;
  onClose: () => void;
  officeId: string | null;
  onSuccess: (agent: { name: string; role: string }) => void;
}

export default function HireModal({ isOpen, onClose, officeId, onSuccess }: HireModalProps) {
  const [name, setName] = useState("");
  const [profession, setProfession] = useState("");
  const [avatarIndex, setAvatarIndex] = useState(0);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [saveAsPreset, setSaveAsPreset] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [isLoadingSkills, setIsLoadingSkills] = useState(false);
  const [isHiring, setIsHiring] = useState(false);

  useEffect(() => {
    if (isOpen) {
      void loadSkills();
    }
  }, [isOpen]);

  const loadSkills = async () => {
    setIsLoadingSkills(true);
    try {
      const response = await fetch("/api/skills");
      const data = await response.json();
      if (data.skills) {
        setSkills(data.skills);
      }
    } catch (error) {
      console.error("Failed to load skills:", error);
    } finally {
      setIsLoadingSkills(false);
    }
  };

  const handleHire = async () => {
    if (!name || !profession || !officeId || isHiring) return;

    setIsHiring(true);
    try {
      const response = await fetch("/api/agents/hire-custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          officeId,
          name,
          profession,
          avatarIndex,
          skills: selectedSkills,
          saveAsPreset,
        }),
      });

      const data = await response.json();
      if (response.ok && data.success) {
        onSuccess(data.agent);
        onClose();
        // Reset form
        setName("");
        setProfession("");
        setAvatarIndex(0);
        setSelectedSkills([]);
        setSaveAsPreset(false);
      } else {
        alert(data.error || "Ошибка при найме сотрудника");
      }
    } catch (error) {
      console.error("Hire failed:", error);
      alert("Не удалось нанять сотрудника");
    } finally {
      setIsHiring(false);
    }
  };

  const toggleSkill = (skillId: string) => {
    setSelectedSkills((prev) =>
      prev.includes(skillId) ? prev.filter((id) => id !== skillId) : [...prev, skillId]
    );
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/65 backdrop-blur-sm p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 20 }}
          className="relative w-full max-w-2xl max-h-[90vh] overflow-hidden rounded-[28px] border border-red-200/20 bg-[#0e0708] shadow-[0_24px_48px_rgba(0,0,0,0.5)] flex flex-col"
        >
          {/* Header */}
          <div className="p-6 border-b border-red-200/10 flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold text-red-50">Визуальный Конструктор Сотрудников</h2>
              <p className="mt-1 text-sm text-rose-100/50">Создайте уникального агента под ваши задачи</p>
            </div>
            <button
              onClick={onClose}
              className="rounded-full p-2 hover:bg-white/10 text-rose-100/60 transition-colors"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
            {/* Name & Profession */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-[10px] uppercase tracking-[0.2em] text-rose-100/50 block">Имя сотрудника</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Напр. Иван"
                  className="w-full rounded-xl bg-black/40 border border-red-200/20 px-4 py-3 text-sm text-white placeholder:text-rose-100/25 outline-none focus:border-red-500/50 transition-colors"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] uppercase tracking-[0.2em] text-rose-100/50 block">Профессия / Роль</label>
                <input
                  type="text"
                  value={profession}
                  onChange={(e) => setProfession(e.target.value)}
                  placeholder="Напр. СММ-менеджер"
                  className="w-full rounded-xl bg-black/40 border border-red-200/20 px-4 py-3 text-sm text-white placeholder:text-rose-100/25 outline-none focus:border-red-500/50 transition-colors"
                />
              </div>
            </div>

            {/* Avatar Picker */}
            <div className="space-y-4">
              <label className="text-[10px] uppercase tracking-[0.2em] text-rose-100/50 block">Выбор аватара</label>
              <div className="flex items-center justify-center space-x-6 py-4 bg-black/20 rounded-2xl border border-red-200/5">
                {[0, 1, 2, 3, 4, 5].map((idx) => (
                  <button
                    key={idx}
                    onClick={() => setAvatarIndex(idx)}
                    className={`relative p-2 rounded-xl border-2 transition-all group ${
                      avatarIndex === idx 
                        ? "border-red-500 bg-red-500/10 scale-110 shadow-[0_0_15px_rgba(232,0,30,0.3)]" 
                        : "border-transparent bg-white/5 hover:bg-white/10"
                    }`}
                  >
                    <PixelAgentSprite
                      role={profession || "Agent"}
                      mode="watching_tv"
                      paletteIndex={idx}
                      direction="down"
                    />
                    {avatarIndex === idx && (
                      <motion.div 
                        layoutId="active-avatar"
                        className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-4 h-1 bg-red-500 rounded-full"
                      />
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Skills Market */}
            <div className="space-y-4">
              <label className="text-[10px] uppercase tracking-[0.2em] text-rose-100/50 block">Каталог навыков</label>
              {isLoadingSkills ? (
                <div className="text-center py-8 text-rose-100/40 text-sm">Загрузка скиллов...</div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {skills.map((skill) => (
                    <div
                      key={skill.id}
                      onClick={() => toggleSkill(skill.id)}
                      className={`cursor-pointer rounded-xl border p-4 transition-all hover:scale-[1.02] active:scale-[0.98] ${
                        selectedSkills.includes(skill.id)
                          ? "bg-red-500/10 border-red-500/40 shadow-[inset_0_0_12px_rgba(232,0,30,0.1)]"
                          : "bg-black/40 border-red-200/10 hover:border-red-200/30"
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="font-semibold text-sm text-red-50">{skill.name}</div>
                        <div className={`mt-0.5 h-4 w-4 rounded border transition-colors flex items-center justify-center ${
                          selectedSkills.includes(skill.id) ? "bg-red-500 border-red-500" : "bg-black/40 border-red-200/20"
                        }`}>
                          {selectedSkills.includes(skill.id) && (
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4">
                              <path d="M20 6L9 17l-5-5" />
                            </svg>
                          )}
                        </div>
                      </div>
                      {skill.description && (
                        <p className="mt-1.5 text-xs text-rose-100/60 leading-relaxed">
                          {skill.description}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Save as Preset */}
            <div className="flex items-center space-x-3 p-4 rounded-xl bg-black/20 border border-red-200/5">
              <input
                id="savePreset"
                type="checkbox"
                checked={saveAsPreset}
                onChange={(e) => setSaveAsPreset(e.target.checked)}
                className="h-4 w-4 rounded border-red-200/20 bg-black/40 text-red-500 focus:ring-red-500/50"
              />
              <label htmlFor="savePreset" className="text-sm text-rose-100/80 cursor-pointer select-none">
                Сохранить как пресет (позволит нанять этого же сотрудника в другой офис в 1 клик)
              </label>
            </div>
          </div>

          {/* Footer */}
          <div className="p-6 border-t border-red-200/10 bg-black/20 flex items-center justify-end space-x-4">
            <button
              onClick={onClose}
              className="px-6 py-2.5 rounded-xl border border-red-200/10 text-rose-100/70 hover:bg-white/5 transition-colors text-sm font-medium"
            >
              Отмена
            </button>
            <button
              onClick={handleHire}
              disabled={!name || !profession || isHiring}
              className="px-8 py-2.5 rounded-xl text-white font-semibold text-sm shadow-xl shadow-red-900/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:scale-105 active:scale-95"
              style={{
                background: "linear-gradient(135deg,#E8001E 0%,#C2155A 55%,#7B2FBE 100%)",
              }}
            >
              {isHiring ? "Найм..." : "Нанять сотрудника"}
            </button>
          </div>
        </motion.div>

        <style jsx global>{`
          .custom-scrollbar::-webkit-scrollbar {
            width: 8px;
          }
          .custom-scrollbar::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.1);
          }
          .custom-scrollbar::-webkit-scrollbar-thumb {
            background: rgba(194, 21, 90, 0.2);
            border-radius: 4px;
          }
          .custom-scrollbar::-webkit-scrollbar-thumb:hover {
            background: rgba(194, 21, 90, 0.4);
          }
        `}</style>
      </div>
    </AnimatePresence>
  );
}

"use client";

import { LucideIcon, User, Code, CheckCircle, ShieldAlert } from "lucide-react";

interface AgentProps {
  agent: {
    name: string;
    role: string;
    status: 'idle' | 'working' | 'waiting' | 'monitoring';
    nickname: string;
  };
}

const roleIcons: Record<string, LucideIcon> = {
  'PM': User,
  'Developer': Code,
  'QA': CheckCircle,
  'DevOps': ShieldAlert
};

const statusColors = {
  'idle': 'bg-slate-400',
  'working': 'bg-emerald-400',
  'waiting': 'bg-amber-400',
  'monitoring': 'bg-sky-400'
};

export default function AgentCard({ agent }: AgentProps) {
  const Icon = roleIcons[agent.role] || User;

  return (
    <div className="glass-card p-6 flex flex-col items-center gap-4 hover:border-white/40 transition-all cursor-pointer group">
      <div className="relative">
        <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-slate-800 to-slate-900 border border-white/10 flex items-center justify-center group-hover:scale-110 transition-transform duration-500">
          <Icon className="w-10 h-10 text-slate-300" />
        </div>
        <div className={`absolute -top-1 -right-1 w-4 h-4 border-2 border-slate-900 rounded-full ${statusColors[agent.status]} animate-pulse`} />
      </div>
      
      <div className="text-center">
        <h3 className="text-lg font-semibold">{agent.name}</h3>
        <p className="text-slate-400 text-sm">{agent.role}</p>
        <code className="text-[10px] text-slate-500 mt-2 block">@{agent.nickname}</code>
      </div>

      <div className="w-full mt-4 bg-white/5 rounded-lg p-3 border border-white/5">
        <div className="flex justify-between text-[10px] text-slate-500 mb-1">
          <span>Current Task</span>
          <span>80%</span>
        </div>
        <div className="w-full h-1 bg-slate-800 rounded-full overflow-hidden">
          <div className="h-full bg-blue-500 rounded-full" style={{ width: '80%' }}></div>
        </div>
      </div>
    </div>
  );
}

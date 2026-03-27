"use client";

import { motion } from "framer-motion";

interface AgentProps {
  agent: {
    id: string;
    name: string;
    role: string;
    status?: string;
    avatar_url?: string;
    is_active?: boolean;
  };
  index: number;
}

const zoneCoords: Record<string, { x: string, y: string }> = {
  'PM': { x: '10%', y: '10%' },
  'Developer': { x: '75%', y: '10%' },
  'QA': { x: '10%', y: '65%' },
  'DevOps': { x: '75%', y: '65%' },
};

export default function AgentAvatar({ agent, index }: AgentProps) {
  // Determine target position based on role (could also be based on task status)
  const basePos = zoneCoords[agent.role] || { x: `${20 + index * 15}%`, y: '40%' };

  return (
    <motion.div
      initial={false}
      animate={{ 
        left: basePos.x, 
        top: basePos.y,
        y: [0, -5, 0], // Gentle hover
      }}
      transition={{ 
        left: { type: "spring", stiffness: 50, damping: 15 },
        top: { type: "spring", stiffness: 50, damping: 15 },
        y: { repeat: Infinity, duration: 2 + index, ease: "easeInOut" }
      }}
      className="absolute p-4 flex flex-col items-center gap-2 group z-20"
    >
      <div className="relative sm:w-16 sm:h-16 w-12 h-12 cursor-pointer">
        {/* Glow Ring */}
        <div className="absolute inset-[-4px] rounded-full bg-gradient-to-r from-blue-500 to-emerald-500 opacity-20 group-hover:opacity-100 blur-sm transition-opacity" />
        
        {/* Avatar Image */}
        <img 
          src={agent.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${agent.name}`} 
          alt={agent.name}
          className="w-full h-full rounded-2xl border border-white/20 bg-slate-900 object-cover relative z-10"
        />
        
        {/* Status Point */}
        <div
          className={`absolute -bottom-1 -right-1 w-4 h-4 border-2 border-[#020617] rounded-full z-20 shadow-lg ${
            agent.is_active ? "bg-emerald-500 animate-pulse" : "bg-slate-500"
          }`}
        />
      </div>

      <div className="text-center bg-black/40 backdrop-blur-md px-3 py-1 rounded-full border border-white/10 opacity-0 group-hover:opacity-100 transition-opacity">
        <span className="text-[10px] font-bold block leading-none">{agent.name}</span>
        <span className="text-[8px] text-slate-500 uppercase tracking-tighter">{agent.role}</span>
      </div>
      
      {/* Label always visible */}
      <span className="text-[10px] text-slate-400 font-mono mt-1 group-hover:hidden">
        @{agent.name.toLowerCase()}
      </span>
    </motion.div>
  );
}

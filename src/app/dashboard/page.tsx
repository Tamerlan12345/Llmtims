"use client";

import { useEffect, useState } from "react";
import { supabase, isMockMode } from "@/lib/supabase/client";
import AgentAvatar from "@/components/AgentAvatar";

const MOCK_AGENTS = [
  { id: '1', name: 'Alex', role: 'PM', status: 'thinking', avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Alex', is_active: true },
  { id: '2', name: 'John', role: 'Developer', status: 'coding', avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=John', is_active: true },
  { id: '3', name: 'Sara', role: 'QA', status: 'testing', avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Sara', is_active: false },
  { id: '4', name: 'Mike', role: 'DevOps', status: 'deploying', avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Mike', is_active: true },
];

export default function DashboardPage() {
  const [mounted, setMounted] = useState(false);
  const [agents, setAgents] = useState<any[]>(isMockMode ? MOCK_AGENTS : []);
  const [totalCost, setTotalCost] = useState(0.042);
  const [taskInput, setTaskInput] = useState("");
  const [isRunning, setIsRunning] = useState(false);

  const createTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskInput || isRunning) return;
    setIsRunning(true);

    try {
      if (isMockMode) {
        // Simulate for demo
        simulateWorkflow();
        setTimeout(() => setIsRunning(false), 3000);
        return;
      }

      // 1. Create task in Supabase
      const { data: task, error } = await supabase
        .from('tasks')
        .insert({ title: "New Task", description: taskInput, status: 'pending' })
        .select()
        .single();

      if (error) throw error;

      // 2. Trigger API
      await fetch('/api/agents/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id, input: taskInput }),
      });

      setTaskInput("");
    } catch (err) {
      console.error(err);
      alert("Error starting task. Check console/logs.");
    } finally {
      setIsRunning(false);
    }
  };

  useEffect(() => {
    if (isMockMode) return;

    const fetchData = async () => {
      const { data: agentsData } = await supabase.from('agents').select('*');
      if (agentsData) setAgents(agentsData);

      const { data: costData } = await supabase.from('token_logs').select('cost');
      if (costData) {
        setTotalCost(costData.reduce((acc, curr) => acc + Number(curr.cost), 0));
      }
    };

    fetchData();

    const channel = supabase
      .channel('schema-db-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agents' }, (payload) => {
        setAgents((prev) => prev.map(a => a.id === (payload.new as any).id ? payload.new : a));
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  if (!mounted) return <div className="min-h-screen bg-[#020617]" />;

  const simulateWorkflow = () => {
    setAgents(prev => prev.map(a => {
      // Rotate roles for simulation
      const roles = ['PM', 'Developer', 'QA', 'DevOps'];
      const currentIndex = roles.indexOf(a.role);
      const nextRole = roles[(currentIndex + 1) % roles.length];
      return { ...a, role: nextRole };
    }));
  };

  return (
    <main className="min-h-screen bg-[#020617] text-white p-4 overflow-hidden relative font-sans">
      {/* Dynamic Grid Background */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#1e293b_1px,transparent_1px),linear-gradient(to_bottom,#1e293b_1px,transparent_1px)] bg-[size:40px_40px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)] opacity-20" />

      {/* Header */}
      <div className="relative z-10 flex justify-between items-center px-6 py-4 border-b border-white/5 backdrop-blur-md bg-black/20">
        <div>
          <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-emerald-400">
            AuraTeam Office
          </h1>
          <p className="text-slate-500 text-xs tracking-widest uppercase">Autonomous AI Operations {isMockMode && "(DEMO MODE)"}</p>
        </div>
        <div className="flex gap-4 items-center">
          <button 
            onClick={simulateWorkflow}
            className="px-4 py-2 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-bold hover:bg-blue-500/20 transition-all"
          >
            Trigger Simulation
          </button>
          <div className="h-8 w-px bg-white/10" />
          <div className="text-right">
            <span className="text-[10px] text-slate-500 block">API CONSUMPTION</span>
            <span className="text-lg font-mono text-emerald-400">${totalCost.toFixed(4)}</span>
          </div>
          <div className="h-10 w-px bg-white/10" />
          <div className="text-right">
            <span className="text-[10px] text-slate-500 block">ACTIVE AGENTS</span>
            <span className="text-lg font-mono text-blue-400">{agents.filter(a => a.is_active).length}/{agents.length}</span>
          </div>
        </div>
      </div>

      {/* Task Creation Form */}
      <div className="relative z-10 px-6 py-4">
        <form onSubmit={createTask} className="flex gap-2 max-w-2xl mx-auto glass-card p-2 rounded-2xl border border-white/10">
          <input 
            type="text" 
            value={taskInput}
            onChange={(e) => setTaskInput(e.target.value)}
            placeholder="Assign a task to your AI team (e.g., 'Develop an auth module')..."
            className="flex-1 bg-transparent border-none outline-none px-4 text-sm placeholder:text-slate-500"
            disabled={isRunning}
          />
          <button 
            type="submit"
            disabled={isRunning}
            className={`px-6 py-2 rounded-xl text-xs font-bold transition-all ${
              isRunning ? 'bg-slate-700 text-slate-400' : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20'
            }`}
          >
            {isRunning ? 'Agents working...' : 'Deploy Team'}
          </button>
        </form>
      </div>

      {/* 2D Office Visualization Area */}
      <div className="relative h-[calc(100vh-180px)] mt-4 border border-white/5 rounded-3xl bg-slate-900/40 backdrop-blur-sm overflow-hidden">
        {/* Office Zones */}
        <div className="absolute top-10 left-10 w-40 h-40 border border-white/5 rounded-2xl flex items-center justify-center bg-blue-500/5">
          <span className="text-[10px] text-blue-400/50 uppercase font-bold">Planning Zone</span>
        </div>
        <div className="absolute top-10 right-10 w-40 h-40 border border-white/5 rounded-2xl flex items-center justify-center bg-emerald-500/5">
          <span className="text-[10px] text-emerald-400/50 uppercase font-bold">Coding Lab</span>
        </div>
        <div className="absolute bottom-10 left-10 w-40 h-40 border border-white/5 rounded-2xl flex items-center justify-center bg-amber-500/5">
          <span className="text-[10px] text-amber-400/50 uppercase font-bold">Testing Ground</span>
        </div>
        <div className="absolute bottom-10 right-10 w-40 h-40 border border-white/5 rounded-2xl flex items-center justify-center bg-sky-500/5">
          <span className="text-[10px] text-sky-400/50 uppercase font-bold">Cloud Control</span>
        </div>

        {/* Dynamic Agent Avatars */}
        {agents.map((agent, index) => (
          <AgentAvatar key={agent.id} agent={agent} index={index} />
        ))}
      </div>

      {/* Footer / Task Ticker */}
      <div className="fixed bottom-4 left-4 right-4 h-12 glass-card flex items-center px-6 gap-4 overflow-hidden">
        <div className="flex items-center gap-2 text-xs font-bold text-blue-400 whitespace-nowrap">
          <div className="w-2 h-2 bg-blue-400 rounded-full animate-ping" />
          SYSTEM LOG:
        </div>
        <div className="flex-1 text-xs text-slate-400 italic truncate animate-pulse">
          Agent @{agents.find(a => a.is_active)?.name.toLowerCase() || 'system'} is currently {isMockMode ? 'simulating workflow' : 'syncing with Supabase'}...
        </div>
      </div>
    </main>
  );
}

import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/auth/adminSession";

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getAdminSession();
  if (!session) {
    redirect("/");
  }

  return (
    <div className="relative min-h-screen bg-[#0d0308] text-rose-50 overflow-hidden selection:bg-red-500/30">
      <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-30">
        <div className="absolute -top-[20%] -left-[10%] h-[60%] w-[60%] rounded-full bg-red-900/20 blur-[120px]" />
        <div className="absolute -bottom-[20%] -right-[10%] h-[60%] w-[60%] rounded-full bg-violet-900/10 blur-[120px]" />
      </div>
      <div className="relative z-20">{children}</div>
    </div>
  );
}

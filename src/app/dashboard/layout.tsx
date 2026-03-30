import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/auth/adminSession";

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getAdminSession();
  if (!session) {
    redirect("/");
  }

  return children;
}

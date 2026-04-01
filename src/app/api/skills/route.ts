import { NextResponse } from "next/server";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import { getAdminSession } from "@/lib/auth/adminSession";

export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isServerSupabaseConfigured) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  try {
    const { data, error } = await supabase
      .from("skills_catalog")
      .select("id, name, description")
      .eq("is_active", true)
      .order("name", { ascending: true });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ skills: data });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

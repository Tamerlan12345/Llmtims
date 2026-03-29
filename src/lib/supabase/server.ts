import "server-only";

import { createClient } from "@supabase/supabase-js";
import { loadServerEnv } from "@/lib/config/serverEnv";
import { createMockSupabaseClient } from "./mock";

loadServerEnv();

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const supabaseServiceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isServerSupabaseConfigured = Boolean(supabaseUrl && supabaseServiceKey);

export const supabaseServer: any = isServerSupabaseConfigured
  ? createClient(supabaseUrl!, supabaseServiceKey!, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : createMockSupabaseClient();

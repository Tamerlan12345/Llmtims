"use client";

import { createClient } from "@supabase/supabase-js";
import { createMockSupabaseClient } from "./mock";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isMockMode = !(supabaseUrl && supabaseAnonKey);

export const supabase: any = isMockMode
  ? createMockSupabaseClient()
  : createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
      },
    });

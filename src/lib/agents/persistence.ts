import { PostgresSaver } from "@langchain/langgraph/checkpoint/postgres";
import { Pool } from "pg";

// Note: In a real Supabase environment, you would use the connection string 
// for the Transaction Pooler (port 6543) or Session Pooler (port 5432).
const connectionString = process.env.DATABASE_URL!;

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

export const checkpointer = new PostgresSaver(pool);

// The checkpointer needs to be initialized before use
// await checkpointer.setup();

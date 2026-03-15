import asyncio
import json
import os
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel

MODEL_PATH   = os.getenv("MODEL_PATH", "./models/Qwen2.5-3B-Instruct-Q4_K_M.gguf")
N_CTX        = int(os.getenv("N_CTX", "4096"))
# Optimization: For 4 parallel streams on 4 cores, each stream gets 1 thread
N_THREADS    = int(os.getenv("N_THREADS", "1"))
MAX_PARALLEL = int(os.getenv("MAX_PARALLEL", "4"))
MAX_TOKENS   = int(os.getenv("MAX_TOKENS", "1024"))
TEMPERATURE  = float(os.getenv("TEMPERATURE", "0.3"))
REPEAT_PEN   = float(os.getenv("REPEAT_PENALTY", "1.1"))

llm = None
semaphore = None
queue_stats = {"waiting": 0, "active": 0}

@asynccontextmanager
async def lifespan(app: FastAPI):
    global llm, semaphore
    print("[boot] Loading model: " + MODEL_PATH)
    print("[boot] n_ctx=" + str(N_CTX) + "  threads=" + str(N_THREADS) + "  max_parallel=" + str(MAX_PARALLEL))
    from llama_cpp import Llama
    llm = Llama(
        model_path=MODEL_PATH,
        n_ctx=N_CTX,
        n_threads=N_THREADS,
        n_gpu_layers=0,
        verbose=False,
        chat_format="chatml",
    )
    semaphore = asyncio.Semaphore(MAX_PARALLEL)
    print("[boot] Model ready")
    yield
    print("[boot] Shutdown")

app = FastAPI(lifespan=lifespan)

class Message(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    messages: list[Message]
    session_id: str = ""

def sse(data: dict) -> str:
    return "data: " + json.dumps(data, ensure_ascii=False) + "\n\n"

async def stream_response(messages: list[Message]) -> AsyncGenerator[str, None]:
    global queue_stats
    queue_stats["waiting"] += 1
    yield sse({"type": "queue", "waiting": queue_stats["waiting"]})

    async with semaphore:
        queue_stats["waiting"] = max(0, queue_stats["waiting"] - 1)
        queue_stats["active"] += 1
        yield sse({"type": "start"})

        try:
            loop = asyncio.get_event_loop()
            # System prompt to reduce hallucinations and ensure high quality Russian
            system_msg = {
                "role": "system", 
                "content": "Ты — профессиональный корпоративный ассистент. Отвечай вежливо, грамотно на русском языке. Всегда старайся давать точные и краткие ответы. Если ты чего-то не знаешь, так и скажи, не выдумывай факты. Соблюдай правила грамматики и пунктуации."
            }
            msgs = [system_msg] + [{"role": m.role, "content": m.content} for m in messages]

            def _generate():
                return llm.create_chat_completion(
                    messages=msgs,
                    max_tokens=MAX_TOKENS,
                    temperature=TEMPERATURE,
                    repeat_penalty=REPEAT_PEN,
                    stream=True,
                )

            stream = await loop.run_in_executor(None, _generate)
            full_text = ""

            for chunk in stream:
                delta = chunk["choices"][0]["delta"]
                token = delta.get("content", "")
                if token:
                    full_text += token
                    yield sse({"type": "token", "text": token})
                    await asyncio.sleep(0)

            yield sse({"type": "done", "full": full_text})

        except Exception as e:
            yield sse({"type": "error", "message": str(e)})
        finally:
            queue_stats["active"] = max(0, queue_stats["active"] - 1)


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    return StreamingResponse(
        stream_response(req.messages),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )

@app.get("/status")
async def status():
    return {
        "model":   os.path.basename(MODEL_PATH),
        "active":  queue_stats["active"],
        "waiting": queue_stats["waiting"],
        "slots":   MAX_PARALLEL,
    }

@app.get("/", response_class=HTMLResponse)
async def index():
    with open("index.html", encoding="utf-8") as f:
        return f.read()
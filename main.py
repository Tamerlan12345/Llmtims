import asyncio
import json
import os
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel
from huggingface_hub import hf_hub_download

MODEL_PATH   = os.getenv("MODEL_PATH", "./models/QVikhr-2.5-1.5B-Instruct-SMPO-Q4_K_M.gguf")
N_CTX        = int(os.getenv("N_CTX", "2048")) # Balanced context for speed on CPU
N_THREADS    = min(4, int(os.getenv("N_THREADS", str(os.cpu_count() or 2))))
MAX_PARALLEL = int(os.getenv("MAX_PARALLEL", "4"))
MAX_TOKENS   = int(os.getenv("MAX_TOKENS", "1024"))
TEMPERATURE  = float(os.getenv("TEMPERATURE", "0.3"))
REPEAT_PEN   = float(os.getenv("REPEAT_PENALTY", "1.1"))

llm = None
semaphore = None
queue_stats = {"waiting": 0, "active": 0}
boot_status = "starting" # "starting", "downloading", "loading", "ready", "error"
boot_error = ""

async def initialize_model():
    global llm, semaphore, boot_status, boot_error
    
    try:
        # 1. Automatic Download
        models_dir = os.path.dirname(MODEL_PATH) or "models"
        if not os.path.exists(MODEL_PATH):
            boot_status = "downloading"
            print(f"[boot] Model not found at {MODEL_PATH}. Downloading from HF...")
            os.makedirs(models_dir, exist_ok=True)
            repo_id = os.getenv("HF_REPO", "Vikhrmodels/QVikhr-2.5-1.5B-Instruct-SMPO_GGUF")
            filename = os.getenv("HF_FILE", "QVikhr-2.5-1.5B-Instruct-SMPO-Q4_K_M.gguf")
            
            hf_hub_download(
                repo_id=repo_id,
                filename=filename,
                local_dir=models_dir
            )
            print("[boot] Download successful.")

        boot_status = "loading"
        print(f"[boot] Checking model path: {MODEL_PATH}")
        
        if not os.path.exists(MODEL_PATH):
            raise FileNotFoundError(f"Model file NOT FOUND at {MODEL_PATH}")

        from llama_cpp import Llama
        llm = Llama(
            model_path=MODEL_PATH,
            n_ctx=N_CTX,
            n_threads=N_THREADS,
            n_gpu_layers=0,
            chat_format="qwen",
            use_mlock=False,
            use_mmap=True,
            verbose=False,
        )
        semaphore = asyncio.Semaphore(MAX_PARALLEL)
        boot_status = "ready"
        print("[boot] Model ready")
    except Exception as e:
        boot_status = "error"
        boot_error = str(e)
        print(f"[boot] CRITICAL BOOT ERROR: {e}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Start initialization in the background to not block Railway healthcheck
    asyncio.create_task(initialize_model())
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
    global queue_stats, boot_status
    
    if boot_status != "ready":
        yield sse({"type": "error", "message": f"Model is not ready. Status: {boot_status}"})
        return

    queue_stats["waiting"] += 1
    yield sse({"type": "queue", "waiting": queue_stats["waiting"]})

    async with semaphore:
        queue_stats["waiting"] = max(0, queue_stats["waiting"] - 1)
        queue_stats["active"] += 1
        yield sse({"type": "start"})

        try:
            loop = asyncio.get_event_loop()
            # Russian Assistant system prompt (Removed Gemini per user request)
            system_msg = {
                "role": "system", 
                "content": (
                    "Ты — полезный и вежливый AI-ассистент. "
                    "Твоя задача — отвечать максимально точно и только на русском языке. "
                    "Будь кратким и профессиональным. Не используй никаких тегов или разметки в ответе."
                )
            }
            msgs = [system_msg] + [{"role": m.role, "content": m.content} for m in messages]

            print(f"[chat] Starting generation for {len(msgs)} messages")
            
            # Use a queue to communicate between the generator thread and the async response
            token_queue = asyncio.Queue()
            loop = asyncio.get_event_loop()

            def _producer():
                try:
                    # Actually start the completion
                    stream = llm.create_chat_completion(
                        messages=msgs,
                        stream=True,
                        max_tokens=MAX_TOKENS,
                        temperature=TEMPERATURE,
                        repeat_penalty=REPEAT_PEN,
                    )
                    for chunk in stream:
                        delta = chunk["choices"][0]["delta"]
                        token = delta.get("content", "")
                        if token:
                            # Use threadsafe call because we are in a background thread
                            loop.call_soon_threadsafe(token_queue.put_nowait, token)
                    # Signal end of stream
                    loop.call_soon_threadsafe(token_queue.put_nowait, None)
                except Exception as e:
                    print(f"[chat] Error in producer: {e}")
                    loop.call_soon_threadsafe(token_queue.put_nowait, e)

            # Start the model in a background thread
            loop.run_in_executor(None, _producer)

            full_text = ""
            first_token_received = False
            
            while True:
                try:
                    # Wait for a token with a 2-second timeout
                    item = await asyncio.wait_for(token_queue.get(), timeout=2.0)
                    
                    if item is None: # End of stream
                        break
                    if isinstance(item, Exception):
                        raise item

                    if not first_token_received:
                        print("[chat] First token received!")
                        first_token_received = True

                    full_text += item
                    yield sse({"type": "token", "text": item})
                    
                except asyncio.TimeoutError:
                    # Send heartbeat while waiting for tokens (prefill or generation)
                    if not first_token_received:
                        print("[chat] ... model is still prefilling / thinking ...")
                    yield sse({"type": "heartbeat"})

            yield sse({"type": "done", "full": full_text})
            print(f"[chat] Generation finished. Length: {len(full_text)}")

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
        "status":  boot_status,
        "error":   boot_error,
        "model":   os.path.basename(MODEL_PATH),
        "active":  queue_stats["active"],
        "waiting": queue_stats["waiting"],
        "slots":   MAX_PARALLEL,
    }

@app.get("/", response_class=HTMLResponse)
async def index():
    with open("index.html", encoding="utf-8") as f:
        return f.read()
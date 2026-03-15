#!/usr/bin/env bash
set -e

# ── Локальный запуск (без Docker) ────────────────────────────────────────────

# Использование: ./start.sh

echo "=== Qwen-2.5-3B-it Chat :: локальный запуск ==="

# 1. Создаём папку для модели

mkdir -p models

# 2. Скачиваем модель если её ещё нет

MODEL="models/qwen2.5-3b-instruct-q4_k_m.gguf"
if [ ! -f "$MODEL" ]; then
echo "[download] Загрузка модели Qwen 2.5 3B (~2.2 GB) …"
pip install -q huggingface-hub
python3 - <<'EOF'
from huggingface_hub import hf_hub_download
path = hf_hub_download(
repo_id="bartowski/Qwen2.5-3B-Instruct-GGUF",
filename="Qwen2.5-3B-Instruct-Q4_K_M.gguf",
local_dir="models",
local_dir_use_symlinks=False,
)
print(f"Модель сохранена: {path}")
EOF
else
echo "[model] Уже скачана: $MODEL"
fi

# 3. Устанавливаем зависимости

echo "[pip] Установка зависимостей …"
CMAKE_ARGS="-DGGML_BLAS=OFF -DGGML_CUDA=OFF -DGGML_METAL=OFF"
FORCE_CMAKE=1   
pip install -q -r requirements.txt

# 4. Запускаем сервер

export MODEL_PATH="$MODEL"
export N_THREADS=${N_THREADS:-$(nproc)}
export MAX_PARALLEL=${MAX_PARALLEL:-4}
export PORT=${PORT:-8000}

echo ""
echo "  ✓ Сервер запускается на http://localhost:$PORT"
echo "  ✓ Параллельных потоков: $MAX_PARALLEL"
echo "  ✓ CPU потоков: $N_THREADS"
echo ""

uvicorn main:app \
  --host 0.0.0.0 \
  --port "$PORT" \
  --workers 1 \
  --loop asyncio \
  --timeout-keep-alive 120

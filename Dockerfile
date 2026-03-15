FROM python:3.11-slim

# Install build and runtime dependencies in one go
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git curl libgomp1 libstdc++6 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Upgrade pip and install requirements
COPY requirements.txt .
# Build llama-cpp-python with explicit AVX2 flags
ENV CMAKE_ARGS="-DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_AVX=ON -DGGML_NATIVE=OFF -DGGML_BLAS=OFF -DGGML_CUDA=OFF -DGGML_METAL=OFF"
ENV FORCE_CMAKE=1
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy app files
COPY main.py index.html entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Download model
RUN pip install --no-cache-dir huggingface_hub[cli] && \
    mkdir -p /app/models && \
    huggingface-cli download bartowski/ai-sage_GigaChat3-10B-A1.8B-GGUF \
    ai-sage_GigaChat3-10B-A1.8B-Q4_K_S.gguf \
    --local-dir /app/models --local-dir-use-symlinks False && \
    ls -lh /app/models/

# Environment defaults
ENV MODEL_PATH=/app/models/ai-sage_GigaChat3-10B-A1.8B-Q4_K_S.gguf
ENV N_CTX=2048
ENV N_THREADS=4
ENV MAX_PARALLEL=1
ENV MAX_TOKENS=1024
ENV TEMPERATURE=0.3
ENV REPEAT_PENALTY=1.1
ENV PORT=8000
ENV PYTHONUNBUFFERED=1

EXPOSE 8000

CMD ["/app/entrypoint.sh"]

FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
ENV EMBED_MODEL=BAAI/bge-small-en-v1.5
# Download the model at build time so the container works offline.
RUN python -c "from fastembed import TextEmbedding; TextEmbedding('BAAI/bge-small-en-v1.5')"
COPY app.py .
EXPOSE 7200
HEALTHCHECK --interval=10s --timeout=5s --retries=12 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:7200/health')"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7200"]

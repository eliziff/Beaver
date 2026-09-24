# word_python runs model programs, verification and the LibreOffice open check here.
# Build once and deploy WORD_PYTHON_CONTAINER_IMAGE by immutable digest. No Word installation.
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv libreoffice-writer fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/word_python/ /app/
RUN python3 -m venv /opt/word-python && /opt/word-python/bin/pip install --no-cache-dir -r /app/requirements.txt \
    && /opt/word-python/bin/python -I /app/probe.py
ENV PATH=/opt/word-python/bin:$PATH HOME=/tmp SAL_USE_VCLPLUGIN=svp PYTHONUNBUFFERED=1
WORKDIR /job
USER 65532:65532

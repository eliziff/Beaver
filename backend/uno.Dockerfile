# The trusted UNO bridge runs here, never model Python. Build/qualify once and
# deploy WORD_UNO_CONTAINER_IMAGE by immutable digest. No Word installation.
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer python3-uno fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/word_uno.py scripts/word_uno_console.py /app/
ENV HOME=/tmp SAL_USE_VCLPLUGIN=svp PYTHONUNBUFFERED=1
WORKDIR /work
USER 65532:65532

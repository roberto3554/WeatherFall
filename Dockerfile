FROM python:3.11-slim

# Prevent Python from writing .pyc files and enable unbuffered logging
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app:/app/backend

WORKDIR /app

# Install system dependencies required for PostgreSQL driver and spatial libraries (GEOS, PROJ, Rtree)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    libpq-dev \
    libgeos-dev \
    libproj-dev \
    libspatialindex-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies first to leverage Docker layer caching
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r /app/backend/requirements.txt

# Copy backend and frontend source code (secrets excluded via .dockerignore)
COPY backend/ /app/backend/
COPY frontend/ /app/frontend/

# Create a dedicated non-root system user and group for runtime container security
RUN groupadd --system --gid 10001 weatherfall && \
    useradd --system --uid 10001 --gid weatherfall --home-dir /app --no-create-home weatherfall && \
    mkdir -p /app/data && \
    chown -R weatherfall:weatherfall /app

WORKDIR /app/backend

USER weatherfall

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]


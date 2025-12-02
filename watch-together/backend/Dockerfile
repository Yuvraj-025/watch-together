# Use official Python slim
FROM python:3.11-slim

WORKDIR /app

# system deps (if needed)
RUN apt-get update && apt-get install -y build-essential gcc curl && rm -rf /var/lib/apt/lists/*

# Copy and install
COPY ./requirements.txt /app/requirements.txt
RUN python -m pip install --upgrade pip
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY . /app

# expose port
EXPOSE 8000

# Use uvicorn with 0.0.0.0 and proper workers
CMD ["uvicorn", "main:asgi_app", "--host", "0.0.0.0", "--port", "8000", "--loop", "uvloop", "--http", "h11"]

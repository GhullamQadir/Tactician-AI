FROM python:3.9-slim
WORKDIR /app
COPY . /app
RUN pip install --no-cache-dir -r requirements.txt
# Port 8080 zaroori hai Cloud Run ke liye
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]

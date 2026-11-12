# Tapnod phone-call agent, for LiveKit Cloud (lk agent deploy) or any Docker host.
FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN adduser --disabled-password --gecos "" --home /app --uid 10001 appuser
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY agent.py ./
RUN chown -R appuser:appuser /app
USER appuser
RUN python agent.py download-files
CMD ["python", "agent.py", "start"]

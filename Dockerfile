# Use the ultra-slim Trixie image (Debian 13)
FROM ghcr.io/astral-sh/uv:python3.13-trixie-slim

# Set the working directory
WORKDIR /app

# Copy uv binaries and your project files
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
COPY . /app/

# Environment setup
ENV UV_NO_DEV=1
# Ensure the database stays in the app directory for persistence
ENV PYTHONUNBUFFERED=1

# Synchronize the project (creates the .venv and installs dependencies)
RUN uv sync --frozen

# Expose the internal port (FastAPI default)
EXPOSE 30086

# Run the server using 'uv run'
CMD ["uv", "run", "python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "30086"]
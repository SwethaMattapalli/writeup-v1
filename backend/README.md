# WriteUp Backend

FastAPI backend for WriteUp with OpenRouter AI integration.

## Prerequisites

- Python 3.8+
- `OPENROUTER_API_KEY` environment variable set

## Setup

### 1. Create `.env` file

Copy `.env.example` to `.env` and fill in your API key:

```bash
cp .env.example .env
# Then edit .env and add your OPENROUTER_API_KEY
```

### 2. Running the Backend

#### Option 1: Cross-Platform Python Script (Recommended)

Works on **Windows, Linux, and macOS**:

```bash
python start.py [port]
```

Examples:
```bash
python start.py              # Uses default port 8000
python start.py 5000         # Uses port 5000
```

#### Option 2: Platform-Specific Scripts

**Linux/macOS:**
```bash
./start.sh [port]
```

**Windows:**
```bash
start.bat [port]
```

Or double-click `start.bat` to use default port 8000.

## What the Startup Script Does

1. Checks for `.env` file and loads `OPENROUTER_API_KEY`
2. Creates a Python virtual environment (`venv/`) if it doesn't exist
3. Installs dependencies from `requirements.txt`
4. Starts the FastAPI server on `http://localhost:{port}`

## API Endpoints

Once running, the API is available at:

- **API Base:** `http://localhost:8000`
- **Interactive Docs:** `http://localhost:8000/docs`
- **Alternative Docs:** `http://localhost:8000/redoc`

## Requirements

See `requirements.txt` for dependencies:

- FastAPI
- Uvicorn
- OpenAI (for OpenRouter)
- Python-dotenv
- Pydantic

## Development

### Manual Setup (if you prefer not to use startup scripts)

```bash
# Create and activate virtual environment
python -m venv venv

# Windows
venv\Scripts\activate.bat

# Linux/macOS
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run server
uvicorn main:app --host 127.0.0.1 --port 8000
```

### Using different ports

All startup methods support specifying a port:

```bash
python start.py 3000      # Python script
./start.sh 3000           # Bash (Linux/macOS)
start.bat 3000            # Batch (Windows)
```

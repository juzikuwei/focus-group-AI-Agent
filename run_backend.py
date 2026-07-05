import os

import uvicorn


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5173"))
    uvicorn.run("backend.main:app", host=host, port=port, reload=False)


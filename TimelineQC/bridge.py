import sys
import os
import json
import traceback

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.join(PLUGIN_DIR, "backend")

if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from main import handle_request


def read_cli_params():
    if len(sys.argv) <= 2:
        return {}

    if sys.argv[2] in ("--stdin", "-"):
        payload = sys.stdin.read()
        return json.loads(payload) if payload.strip() else {}

    if sys.argv[2].startswith("@"):
        with open(sys.argv[2][1:], "r", encoding="utf-8") as f:
            payload = f.read()
        return json.loads(payload) if payload.strip() else {}

    return json.loads(sys.argv[2])


def on_resolve_event(event_type, event_data):
    try:
        data = json.loads(event_data) if isinstance(event_data, str) else event_data
        action = data.get("action", "")
        params = data.get("params", {})
        result = handle_request(action, params)
        return json.dumps(result, ensure_ascii=False)
    except Exception as e:
        error_result = {
            "error": str(e),
            "traceback": traceback.format_exc(),
        }
        return json.dumps(error_result, ensure_ascii=False)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        try:
            action = sys.argv[1]
            params = read_cli_params()
            result = handle_request(action, params)
            print(json.dumps(result, ensure_ascii=False))
        except Exception as e:
            print(json.dumps({
                "error": str(e),
                "traceback": traceback.format_exc(),
            }, ensure_ascii=False))

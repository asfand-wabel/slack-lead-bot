import json
import os

STORE_PATH = os.path.join(os.path.dirname(__file__), 'user-tokens.json')


def _load():
    try:
        with open(STORE_PATH) as f:
            return json.load(f)
    except Exception:
        return {}


def get(user_id):
    return _load().get(user_id)


def set_token(user_id, token):
    all_tokens = _load()
    all_tokens[user_id] = token
    with open(STORE_PATH, 'w') as f:
        json.dump(all_tokens, f, indent=2)

"""Explicit loopback entry point. No configuration, server or DB on import."""
import os
import sys

from .app import create_app
from .settings import load_settings


def main():
    try:
        if len(sys.argv) != 1:
            raise ValueError()
        settings = load_settings(os.environ['IFPMIC_API_CONFIG'])
        port = int(os.environ.get('IFPMIC_API_PORT', '8768'))
        if not 1 <= port <= 65535:
            raise ValueError()
        app = create_app(settings)
    except Exception:
        print('SETTINGS_INVALID', file=sys.stderr)
        return 2
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=port, access_log=False, proxy_headers=False, server_header=False)
    return 0


if __name__ == '__main__':
    sys.exit(main())

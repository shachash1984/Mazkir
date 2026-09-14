"""Atomically install an uploaded .env while preserving the existing database key."""
import os
import re
from pathlib import Path

root = Path('/opt/mazkir')
current = root / '.env'
incoming = root / '.env.incoming'

def encryption_key(path):
    match = re.search(r'^ENCRYPTION_KEY=(.*)$', path.read_text(), re.MULTILINE)
    value = match.group(1).strip().strip('\"\'') if match else ''
    if not re.fullmatch(r'[a-fA-F0-9]{64}', value):
        raise SystemExit('Invalid encryption key; existing configuration preserved.')
    return value.lower()

os.chmod(incoming, 0o600)
if encryption_key(current) != encryption_key(incoming):
    raise SystemExit('Encryption key changed; existing configuration preserved.')
os.replace(incoming, current)
print('Configuration updated; existing encryption key preserved.')

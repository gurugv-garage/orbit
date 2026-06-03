// Generate a self-signed dev cert into certs/ so the station serves HTTPS.
// Uses openssl (present on macOS/Linux). HTTP is the fallback if you skip this.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const dir = fileURLToPath(new URL('../certs/', import.meta.url));
mkdirSync(dir, { recursive: true });
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', join(dir, 'key.pem'),
  '-out', join(dir, 'cert.pem'),
  '-days', '825',
  '-subj', '/CN=orbit-station.local',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
], { stdio: 'inherit' });
console.log('wrote certs/key.pem + certs/cert.pem');

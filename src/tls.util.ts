import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP_DATA_DIR } from './config';

const CERTS_DIR = path.join(APP_DATA_DIR, 'certs');
const CA_KEY_PATH = path.join(CERTS_DIR, 'ca.key');
const CA_CERT_PATH = path.join(CERTS_DIR, 'ca.crt');
const SERVER_KEY_PATH = path.join(CERTS_DIR, 'server.key');
const SERVER_CSR_PATH = path.join(CERTS_DIR, 'server.csr');
const SERVER_CERT_PATH = path.join(CERTS_DIR, 'server.crt');
const EXT_FILE_PATH = path.join(CERTS_DIR, 'server.ext');
const IPS_STAMP_PATH = path.join(CERTS_DIR, 'san_ips.txt');

export interface TlsMaterials {
  caCert: Buffer;
  key: Buffer;
  cert: Buffer;
  caCertPath: string;
}

export function ensureTlsCertificates(lanIps: string[]): TlsMaterials | null {
  try {
    fs.mkdirSync(CERTS_DIR, { recursive: true });
    const sortedIps = Array.from(new Set(['127.0.0.1', ...lanIps])).sort();
    const stampContent = sortedIps.join(',');

    // 1. Ensure Root CA exists
    if (!fs.existsSync(CA_KEY_PATH) || !fs.existsSync(CA_CERT_PATH)) {
      execFileSync('openssl', [
        'req',
        '-x509',
        '-new',
        '-nodes',
        '-newkey',
        'rsa:2048',
        '-keyout',
        CA_KEY_PATH,
        '-sha256',
        '-days',
        '3650',
        '-out',
        CA_CERT_PATH,
        '-subj',
        '/C=LU/O=Garmin Dish Logger/CN=Garmin Dish Logger Local Root CA',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-addext',
        'keyUsage=critical,keyCertSign,cRLSign',
      ]);
    }

    // 2. Ensure Server Certificate exists and includes current LAN IPs
    const existingStamp = fs.existsSync(IPS_STAMP_PATH)
      ? fs.readFileSync(IPS_STAMP_PATH, 'utf-8').trim()
      : '';

    if (
      !fs.existsSync(SERVER_KEY_PATH) ||
      !fs.existsSync(SERVER_CERT_PATH) ||
      existingStamp !== stampContent
    ) {
      execFileSync('openssl', [
        'req',
        '-new',
        '-nodes',
        '-newkey',
        'rsa:2048',
        '-keyout',
        SERVER_KEY_PATH,
        '-out',
        SERVER_CSR_PATH,
        '-subj',
        `/C=LU/O=Garmin Dish Logger/CN=${lanIps[0] || 'localhost'}`,
      ]);

      const sanEntries = [
        'DNS.1 = localhost',
        'DNS.2 = fedora',
        'DNS.3 = fedora.local',
        ...sortedIps.map((ip, idx) => `IP.${idx + 1} = ${ip}`),
      ].join('\n');

      const extContent = [
        'authorityKeyIdentifier=keyid,issuer',
        'basicConstraints=CA:FALSE',
        'keyUsage = digitalSignature, nonRepudiation, keyEncipherment, dataEncipherment',
        'extendedKeyUsage = serverAuth',
        'subjectAltName = @alt_names',
        '',
        '[alt_names]',
        sanEntries,
        '',
      ].join('\n');

      fs.writeFileSync(EXT_FILE_PATH, extContent);

      execFileSync('openssl', [
        'x509',
        '-req',
        '-in',
        SERVER_CSR_PATH,
        '-CA',
        CA_CERT_PATH,
        '-CAkey',
        CA_KEY_PATH,
        '-CAcreateserial',
        '-out',
        SERVER_CERT_PATH,
        '-days',
        '825',
        '-sha256',
        '-extfile',
        EXT_FILE_PATH,
      ]);

      fs.writeFileSync(IPS_STAMP_PATH, stampContent);
    }

    return {
      caCert: fs.readFileSync(CA_CERT_PATH),
      key: fs.readFileSync(SERVER_KEY_PATH),
      cert: fs.readFileSync(SERVER_CERT_PATH),
      caCertPath: CA_CERT_PATH,
    };
  } catch (err) {
    console.error('Warning: failed to generate TLS certificates:', err);
    return null;
  }
}

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSettings } from './config';

export const BEACON_GIST_ID = '1d47f9c40ee2ac4743ff81b62351ddad';

let tunnelProcess: ChildProcess | null = null;
let publicHttpsTunnelUrl: string | null = null;
let lastPublishedTunnelUrl: string | null = null;
let retryTimer: NodeJS.Timeout | null = null;

function findCloudflaredBinary(): string | null {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'cloudflared'),
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function getPublicTunnelUrl(): string | null {
  return publicHttpsTunnelUrl;
}

function getLanUrls(localPort: number): string[] {
  const interfaces = os.networkInterfaces();
  const lanUrls: string[] = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs || name.startsWith('docker') || name.startsWith('veth') || name.startsWith('br-')) {
      continue;
    }
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        lanUrls.push(`http://${addr.address}:${localPort}`);
      }
    }
  }
  return lanUrls;
}

export async function publishTunnelBeacon(tunnelUrl: string, localPort: number): Promise<boolean> {
  if (!tunnelUrl || tunnelUrl.includes('api.trycloudflare.com')) {
    return false;
  }

  const settings = loadSettings();
  const token = settings.githubGistToken;
  if (!token) {
    console.warn('No GITHUB_GIST_TOKEN in .env; cannot publish tunnel beacon.');
    return false;
  }

  const beaconContent = JSON.stringify(
    {
      tunnelUrl,
      lanUrls: getLanUrls(localPort),
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  );

  try {
    const res = await fetch(`https://api.github.com/gists/${BEACON_GIST_ID}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'garmin-dish-logger',
      },
      body: JSON.stringify({
        files: {
          'garmin-dish-logger-beacon.json': {
            content: beaconContent,
          },
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`GitHub API ${res.status}: ${errText.slice(0, 160)}`);
    }

    lastPublishedTunnelUrl = tunnelUrl;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    console.log(`   • 📡 Published live tunnel URL to Gist beacon (${BEACON_GIST_ID}): ${tunnelUrl}`);
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Could not update Gist beacon (${msg}) — retrying in 10s...`);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (publicHttpsTunnelUrl) {
        void publishTunnelBeacon(publicHttpsTunnelUrl, localPort);
      }
    }, 10000);
    return false;
  }
}

export function startCloudflareTunnel(localPort: number): void {
  if (process.env.NODE_ENV === 'test' || process.env.DISABLE_TUNNEL === '1') {
    return;
  }

  const bin = findCloudflaredBinary();
  if (!bin) {
    return;
  }

  const launch = () => {
    try {
      const child = spawn(
        bin,
        ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${localPort}`],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      tunnelProcess = child;

      const handleOutput = (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        // Match only generated quick-tunnel subdomains (which always contain hyphens, never api.trycloudflare.com)
        const matches = text.match(/https:\/\/(?!api\.)[a-z0-9]+-[a-z0-9-]+\.trycloudflare\.com/gi);
        if (matches && matches.length > 0) {
          const url = matches[matches.length - 1];
          if (url && publicHttpsTunnelUrl !== url) {
            publicHttpsTunnelUrl = url;
            console.log(`   • 🌍 Public HTTPS PWA URL (Android WebAPK Ready): ${publicHttpsTunnelUrl}`);
            void publishTunnelBeacon(publicHttpsTunnelUrl, localPort);
          }
        }
      };

      child.stdout?.on('data', handleOutput);
      child.stderr?.on('data', handleOutput);

      child.on('exit', () => {
        tunnelProcess = null;
        setTimeout(launch, 5000);
      });
    } catch (err) {
      console.warn('Failed to start cloudflared tunnel:', err);
    }
  };

  launch();

  // Periodic self-healing check every 60s to ensure Gist beacon always matches the live tunnel URL
  setInterval(async () => {
    if (!publicHttpsTunnelUrl) return;
    if (lastPublishedTunnelUrl !== publicHttpsTunnelUrl) {
      await publishTunnelBeacon(publicHttpsTunnelUrl, localPort);
    }
  }, 60000).unref();

  const cleanup = () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (tunnelProcess) {
      try {
        tunnelProcess.kill('SIGTERM');
      } catch {
        // Ignore
      }
      tunnelProcess = null;
    }
  };

  process.once('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  process.once('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.once('exit', cleanup);
}

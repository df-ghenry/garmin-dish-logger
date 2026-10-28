import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { loadSettings, PROJECT_ROOT, saveSettings } from './config';
import { GarminService, type MealName, todayString } from './garmin.service';
import {
  analyzeDishWithGemini,
  type DishAnalysisResult,
  refineDishWithGemini,
  testGeminiApiKey,
} from './gemini.service';
import { addHistoryItem, deleteHistoryItem, loadHistory } from './history.service';
import { ensureTlsCertificates, type TlsMaterials } from './tls.util';
import { BEACON_GIST_ID, getPublicTunnelUrl, startCloudflareTunnel } from './tunnel.service';

const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const garmin = new GarminService();

function getLocalLanIps(): string[] {
  const interfaces = os.networkInterfaces();
  const ips: string[] = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    if (name.startsWith('docker') || name.startsWith('veth') || name.startsWith('br-')) {
      continue;
    }
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.push(addr.address);
      }
    }
  }
  return ips;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody<T>(req: http.IncomingMessage, maxBytes = 15 * 1024 * 1024): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Payload too large (max 15MB)'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve((raw ? JSON.parse(raw) : {}) as T);
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

export function createRequestHandler(tlsMaterials: TlsMaterials | null, httpsPort: number) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const urlObj = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const pathname = urlObj.pathname;
      const method = (req.method ?? 'GET').toUpperCase();

      if (method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }

      // Serve downloadable Root CA certificate for Android HTTPS trust
      if (method === 'GET' && pathname === '/ca.crt' && tlsMaterials) {
        res.writeHead(200, {
          'Content-Type': 'application/x-x509-ca-cert',
          'Content-Disposition': 'attachment; filename="garmin-dish-logger-ca.crt"',
          'Cache-Control': 'no-store',
        });
        res.end(tlsMaterials.caCert);
        return;
      }

      // 1. GET /api/status
      if (method === 'GET' && pathname === '/api/status') {
        const settings = loadSettings();
        const garminStatus = await garmin.getStatus();
        const lanIps = getLocalLanIps();
        const primaryIp = lanIps[0] ?? 'localhost';
        const httpUrl = `http://${primaryIp}:${settings.port}`;
        const httpsUrl = `https://${primaryIp}:${httpsPort}`;
        const tunnelUrl = getPublicTunnelUrl();
        const permanentPwaUrl = 'https://df-ghenry.github.io/garmin-dish-logger/';
        const installableUrl = permanentPwaUrl;

        let qrSvg = '';
        let httpsQrSvg = '';
        try {
          qrSvg = await QRCode.toString(installableUrl, {
            type: 'svg',
            margin: 1,
            color: { dark: '#10b981', light: '#0b0f17' },
          });
          httpsQrSvg = await QRCode.toString(httpsUrl, {
            type: 'svg',
            margin: 1,
            color: { dark: '#38bdf8', light: '#0b0f17' },
          });
        } catch {
          // Ignore QR generation failure
        }

        sendJson(res, 200, {
          garmin: garminStatus,
          gemini: {
            configured: Boolean(settings.geminiApiKey),
            maskedKey: settings.geminiApiKey
              ? `${settings.geminiApiKey.slice(0, 6)}...${settings.geminiApiKey.slice(-4)}`
              : '',
            model: settings.geminiModel,
          },
          network: {
            port: settings.port,
            httpsPort,
            lanUrls: lanIps.map((ip) => `http://${ip}:${settings.port}`),
            primaryUrl: installableUrl,
            permanentPwaUrl,
            lanHttpUrl: httpUrl,
            tunnelUrl,
            beaconGistId: BEACON_GIST_ID,
            httpsUrl,
            qrSvg,
            httpsQrSvg,
            hasHttps: Boolean(tlsMaterials),
          },
        });
        return;
      }

      // 2. POST /api/settings
      if (method === 'POST' && pathname === '/api/settings') {
        const body = await readJsonBody<{
          geminiApiKey?: string;
          geminiModel?: string;
          testKey?: boolean;
        }>(req);

        if (body.testKey) {
          const settings = loadSettings();
          const keyToTest =
            body.geminiApiKey !== undefined && body.geminiApiKey.trim() !== ''
              ? body.geminiApiKey.trim()
              : settings.geminiApiKey;
          const modelToTest = body.geminiModel || settings.geminiModel || 'gemini-3.8-flash';
          const result = await testGeminiApiKey(keyToTest, modelToTest);
          if (result.valid) {
            saveSettings({ geminiApiKey: keyToTest, geminiModel: result.model });
          }
          sendJson(res, 200, result);
          return;
        }

        const saved = saveSettings({
          geminiApiKey: body.geminiApiKey,
          geminiModel: body.geminiModel,
        });
        sendJson(res, 200, {
          ok: true,
          configured: Boolean(saved.geminiApiKey),
          maskedKey: saved.geminiApiKey
            ? `${saved.geminiApiKey.slice(0, 6)}...${saved.geminiApiKey.slice(-4)}`
            : '',
          model: saved.geminiModel,
        });
        return;
      }

      // 3. GET /api/nutrition?date=YYYY-MM-DD
      if (method === 'GET' && pathname === '/api/nutrition') {
        const date = urlObj.searchParams.get('date') || todayString();
        const overview = await garmin.getDailyNutritionOverview(date);
        sendJson(res, 200, overview);
        return;
      }

      // 3b. GET /api/garmin/tokens (allows phone to auto-import Garmin session when laptop is connected)
      if (method === 'GET' && pathname === '/api/garmin/tokens') {
        const tokens = garmin.getExportTokens();
        sendJson(res, 200, tokens);
        return;
      }

      // 4. POST /api/analyze
      if (method === 'POST' && pathname === '/api/analyze') {
        const body = await readJsonBody<{
          imageBase64?: string;
          mimeType?: string;
          userNotes?: string;
          demo?: boolean;
          demoPreset?: number;
        }>(req);

        const analysis = await analyzeDishWithGemini({
          imageBase64: body.imageBase64,
          mimeType: body.mimeType,
          userNotes: body.userNotes,
          demo: body.demo,
          demoPreset: body.demoPreset,
        });
        sendJson(res, 200, analysis);
        return;
      }

      // 5. POST /api/refine
      if (method === 'POST' && pathname === '/api/refine') {
        const body = await readJsonBody<{
          currentAnalysis: DishAnalysisResult;
          instruction: string;
        }>(req);

        if (!body.currentAnalysis || !body.instruction?.trim()) {
          sendJson(res, 400, { error: 'Both currentAnalysis and instruction are required' });
          return;
        }
        const refined = await refineDishWithGemini({
          currentAnalysis: body.currentAnalysis,
          instruction: body.instruction.trim(),
        });
        sendJson(res, 200, refined);
        return;
      }

      // 6. POST /api/garmin/log
      if (method === 'POST' && pathname === '/api/garmin/log') {
        const body = await readJsonBody<{
          name: string;
          calories: number;
          carbs: number;
          protein: number;
          fat: number;
          fiber?: number;
          totalGrams?: number;
          meal?: MealName;
          date?: string;
          time?: string;
          saveCustomFood?: boolean;
          ingredients?: DishAnalysisResult['ingredients'];
          thumbnailDataUrl?: string;
        }>(req);

        if (!body.name?.trim()) {
          sendJson(res, 400, { error: 'Dish name is required' });
          return;
        }

        const loggedDate = body.date || todayString();
        const result = await garmin.quickAddDish({
          name: body.name.trim(),
          calories: Number(body.calories) || 0,
          carbs: Number(body.carbs) || 0,
          protein: Number(body.protein) || 0,
          fat: Number(body.fat) || 0,
          fiber: Number(body.fiber) || 0,
          grams: Number(body.totalGrams) || 350,
          meal: body.meal,
          date: loggedDate,
          time: body.time,
          saveCustomFood: Boolean(body.saveCustomFood),
        });

        const historyEntry = addHistoryItem({
          loggedDate,
          garminLogId: result.logId,
          dishName: body.name.trim(),
          mealName: result.mealName,
          calories: Math.round(Number(body.calories) || 0),
          protein: Math.round(Number(body.protein) || 0),
          carbs: Math.round(Number(body.carbs) || 0),
          fat: Math.round(Number(body.fat) || 0),
          fiber: Math.round(Number(body.fiber) || 0),
          totalGrams: Math.round(Number(body.totalGrams) || 0),
          ingredients: body.ingredients ?? [],
          thumbnailDataUrl: body.thumbnailDataUrl,
        });

        sendJson(res, 200, {
          ok: true,
          logId: result.logId,
          mealName: result.mealName,
          mealTime: result.mealTime,
          customFoodId: result.customFoodId,
          overview: result.overview,
          historyEntry,
        });
        return;
      }

      // 7. DELETE /api/garmin/log/:date/:logId
      if (method === 'DELETE' && pathname.startsWith('/api/garmin/log/')) {
        const parts = pathname.replace('/api/garmin/log/', '').split('/');
        const date = decodeURIComponent(parts[0] ?? '');
        const logId = decodeURIComponent(parts[1] ?? '');
        if (!date || !logId) {
          sendJson(res, 400, { error: 'Both date and logId are required' });
          return;
        }
        const overview = await garmin.deleteFoodLogEntry(date, logId);
        sendJson(res, 200, { ok: true, overview });
        return;
      }

      // 8. GET /api/history & DELETE /api/history/:id
      if (method === 'GET' && pathname === '/api/history') {
        sendJson(res, 200, { items: loadHistory() });
        return;
      }
      if (method === 'DELETE' && pathname.startsWith('/api/history/')) {
        const id = decodeURIComponent(pathname.replace('/api/history/', ''));
        const items = deleteHistoryItem(id);
        sendJson(res, 200, { ok: true, items });
        return;
      }

      // Static files from public/
      const requestedPath = pathname === '/' ? '/index.html' : pathname;
      const safePath = path.normalize(requestedPath).replace(/^(\.\.(\/|\\|$))+/, '');
      const fullPath = path.join(PUBLIC_DIR, safePath);

      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const ext = path.extname(fullPath).toLowerCase();
        const isManifest = pathname === '/manifest.json';
        const isSw = pathname === '/sw.js';
        res.writeHead(200, {
          ...CORS_HEADERS,
          'Content-Type': isManifest
            ? 'application/manifest+json; charset=utf-8'
            : (MIME_TYPES[ext] ?? 'application/octet-stream'),
          'Cache-Control': 'no-cache',
          ...(isSw ? { 'Service-Worker-Allowed': '/' } : {}),
        });
        fs.createReadStream(fullPath).pipe(res);
        return;
      }

      // Fallback to index.html for SPA
      const indexHtml = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(indexHtml).pipe(res);
        return;
      }

      sendJson(res, 404, { error: 'Not Found' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Server error:', message);
      sendJson(res, 500, { error: message });
    }
  };
}

// Start HTTP + HTTPS servers
const settings = loadSettings();
const httpsPort = settings.port + 1; // 3457
const lanIps = getLocalLanIps();
const tlsMaterials = ensureTlsCertificates(lanIps);
const handler = createRequestHandler(tlsMaterials, httpsPort);

const httpServer = http.createServer(handler);
httpServer.listen(settings.port, '0.0.0.0', () => {
  console.log(`\n🍽️  Garmin Dish Logger running:`);
  console.log(`   • Local:       http://localhost:${settings.port}`);
  for (const ip of lanIps) {
    console.log(`   • Android HTTP:  http://${ip}:${settings.port}`);
  }
  startCloudflareTunnel(settings.port);
});

if (tlsMaterials) {
  const httpsServer = https.createServer(
    { key: tlsMaterials.key, cert: tlsMaterials.cert },
    handler,
  );
  httpsServer.listen(httpsPort, '0.0.0.0', () => {
    for (const ip of lanIps) {
      console.log(`   • Android HTTPS: https://${ip}:${httpsPort} (Installable PWA)`);
    }
  });
}

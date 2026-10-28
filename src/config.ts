import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const ENV_FILE_PATH = path.join(PROJECT_ROOT, '.env');
export const APP_DATA_DIR = path.join(os.homedir(), '.garmin-dish-logger');

export interface AppSettings {
  geminiApiKey: string;
  geminiModel: string;
  garminEmail: string;
  garminPassword: string;
  githubGistToken: string;
  port: number;
}

function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

const DEPRECATED_MODELS = new Set(['gemini-2.5-flash', 'gemini-2.0-flash']);

function normalizeModelName(model?: string): string {
  const clean = (model || '').trim();
  if (!clean || DEPRECATED_MODELS.has(clean)) {
    return 'gemini-3.8-flash';
  }
  return clean;
}

export function loadSettings(): AppSettings {
  let fileEnv: Record<string, string> = {};
  try {
    if (fs.existsSync(ENV_FILE_PATH)) {
      fileEnv = parseDotEnv(fs.readFileSync(ENV_FILE_PATH, 'utf-8'));
    }
  } catch {
    // Ignore read errors
  }

  return {
    geminiApiKey: fileEnv.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '',
    geminiModel: normalizeModelName(fileEnv.GEMINI_MODEL || process.env.GEMINI_MODEL),
    garminEmail: fileEnv.GARMIN_EMAIL || process.env.GARMIN_EMAIL || '',
    garminPassword: fileEnv.GARMIN_PASSWORD || process.env.GARMIN_PASSWORD || '',
    githubGistToken: fileEnv.GITHUB_GIST_TOKEN || process.env.GITHUB_GIST_TOKEN || '',
    port: Number(fileEnv.PORT || process.env.PORT || 3456),
  };
}

export function saveSettings(partial: Partial<AppSettings>): AppSettings {
  const current = loadSettings();
  const merged: AppSettings = {
    geminiApiKey:
      partial.geminiApiKey !== undefined
        ? partial.geminiApiKey.trim()
        : current.geminiApiKey,
    geminiModel:
      partial.geminiModel !== undefined
        ? normalizeModelName(partial.geminiModel)
        : current.geminiModel,
    garminEmail:
      partial.garminEmail !== undefined
        ? partial.garminEmail.trim()
        : current.garminEmail,
    garminPassword:
      partial.garminPassword !== undefined
        ? partial.garminPassword
        : current.garminPassword,
    githubGistToken:
      partial.githubGistToken !== undefined
        ? partial.githubGistToken.trim()
        : current.githubGistToken,
    port: partial.port ?? current.port,
  };

  const lines = [
    '# Garmin Dish Logger Configuration',
    `GEMINI_API_KEY=${merged.geminiApiKey}`,
    `GEMINI_MODEL=${merged.geminiModel}`,
    `GARMIN_EMAIL=${merged.garminEmail}`,
    `GARMIN_PASSWORD=${merged.garminPassword}`,
    `GITHUB_GIST_TOKEN=${merged.githubGistToken}`,
    `PORT=${merged.port}`,
    '',
  ];

  fs.writeFileSync(ENV_FILE_PATH, lines.join('\n'), { mode: 0o600 });
  return merged;
}

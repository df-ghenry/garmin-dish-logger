import fs from 'node:fs';
import path from 'node:path';
import { APP_DATA_DIR } from './config';
import { type MealName } from './garmin.service';
import { type AnalyzedIngredient } from './gemini.service';

const HISTORY_FILE = path.join(APP_DATA_DIR, 'history.json');
const MAX_HISTORY_ITEMS = 40;

export interface DishHistoryItem {
  id: string;
  createdAt: string;
  loggedDate: string;
  garminLogId: string | null;
  dishName: string;
  mealName: MealName;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  totalGrams: number;
  ingredients: AnalyzedIngredient[];
  thumbnailDataUrl?: string;
}

export function loadHistory(): DishHistoryItem[] {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function addHistoryItem(
  item: Omit<DishHistoryItem, 'id' | 'createdAt'>,
): DishHistoryItem {
  const history = loadHistory();
  const entry: DishHistoryItem = {
    ...item,
    id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
  };
  const updated = [entry, ...history].slice(0, MAX_HISTORY_ITEMS);
  try {
    fs.mkdirSync(APP_DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(updated, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('Failed to save dish history:', err);
  }
  return entry;
}

export function deleteHistoryItem(id: string): DishHistoryItem[] {
  const history = loadHistory().filter((h) => h.id !== id);
  try {
    fs.mkdirSync(APP_DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), { mode: 0o600 });
  } catch {
    // Ignore
  }
  return history;
}

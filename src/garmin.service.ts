import axios from 'axios';
import OAuth from 'oauth-1.0a';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OAUTH_CONSUMER_URL = 'https://thegarth.s3.amazonaws.com/oauth_consumer.json';
const GARMIN_CONNECT_API = 'https://connectapi.garmin.com';
const OAUTH_EXCHANGE = `${GARMIN_CONNECT_API}/oauth-service/oauth/exchange/user/2.0`;
const PROFILE_URL = `${GARMIN_CONNECT_API}/userprofile-service/socialProfile`;
const USER_AGENT_MOBILE = 'com.garmin.android.apps.connectmobile';

const PRIMARY_TOKEN_DIR = path.join(os.homedir(), '.garmin-mcp');
const FALLBACK_TOKEN_DIR = path.join(os.homedir(), '.garminconnect');

const TOKEN_EXPIRY_BUFFER_SECONDS = 60;

export type MealName = 'BREAKFAST' | 'LUNCH' | 'DINNER' | 'SNACKS';

interface OAuth1Token {
  oauth_token: string;
  oauth_token_secret: string;
}

interface OAuth2Token {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number;
  refresh_token_expires_in: number;
  refresh_token_expires_at: number;
}

interface OAuthConsumer {
  consumer_key: string;
  consumer_secret: string;
}

interface UserProfile {
  displayName: string;
  profileId: number;
  fullName?: string;
}

export interface GarminMealDefinition {
  mealId: number;
  mealIndex: number;
  mealName: MealName;
  startTime?: string;
  endTime?: string;
  goals?: {
    calories: number;
    adjustedCalories: number;
    carbs: number;
    adjustedCarbs: number;
    fat: number;
    adjustedFat: number;
    protein: number;
    adjustedProtein: number;
  };
}

export interface GarminLoggedFoodItem {
  logId: string;
  logTimestamp: string;
  logCategory: string;
  mealId: number;
  mealName: MealName;
  mealTime: string;
  name: string;
  calories: number;
  carbs: number;
  protein: number;
  fat: number;
}

export interface GarminDailyNutritionOverview {
  date: string;
  goals: {
    calories: number;
    adjustedCalories: number;
    carbs: number;
    adjustedCarbs: number;
    protein: number;
    adjustedProtein: number;
    fat: number;
    adjustedFat: number;
  };
  consumed: {
    calories: number;
    carbs: number;
    protein: number;
    fat: number;
    caloriesPercentage: number;
  };
  activity: {
    totalBurnedCalories: number | null;
    activeCalories: number | null;
    bmrCalories: number | null;
    steps: number | null;
  };
  meals: GarminMealDefinition[];
  loggedFoods: GarminLoggedFoodItem[];
}

export interface QuickAddDishInput {
  name: string;
  calories: number;
  carbs: number;
  protein: number;
  fat: number;
  fiber?: number;
  grams?: number;
  meal?: MealName;
  date?: string;
  time?: string;
  saveCustomFood?: boolean;
}

export function todayString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function suggestMealForCurrentTime(now = new Date()): MealName {
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes >= 5 * 60 && minutes < 10 * 60 + 30) return 'BREAKFAST';
  if (minutes >= 11 * 60 + 30 && minutes < 15 * 60) return 'LUNCH';
  if (minutes >= 17 * 60 + 30 && minutes < 21 * 60 + 30) return 'DINNER';
  return 'SNACKS';
}

export class GarminService {
  private consumer: OAuthConsumer | null = null;
  private oauth1Token: OAuth1Token | null = null;
  private oauth2Token: OAuth2Token | null = null;
  private profile: UserProfile | null = null;
  private activeTokenDir: string = PRIMARY_TOKEN_DIR;

  getExportTokens(): {
    oauth1: OAuth1Token | null;
    oauth2: OAuth2Token | null;
    profile: UserProfile | null;
  } {
    return {
      oauth1: this.oauth1Token,
      oauth2: this.oauth2Token,
      profile: this.profile,
    };
  }

  constructor() {
    this.loadTokens();
  }

  private loadTokens(): void {
    const dirs = [PRIMARY_TOKEN_DIR, FALLBACK_TOKEN_DIR];
    for (const dir of dirs) {
      try {
        const oauth1Path = path.join(dir, 'oauth1_token.json');
        const oauth2Path = path.join(dir, 'oauth2_token.json');
        if (fs.existsSync(oauth1Path) && fs.existsSync(oauth2Path)) {
          this.oauth1Token = JSON.parse(fs.readFileSync(oauth1Path, 'utf-8')) as OAuth1Token;
          this.oauth2Token = JSON.parse(fs.readFileSync(oauth2Path, 'utf-8')) as OAuth2Token;
          this.activeTokenDir = dir;
          const profilePath = path.join(dir, 'profile.json');
          if (fs.existsSync(profilePath)) {
            this.profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8')) as UserProfile;
          }
          return;
        }
      } catch {
        // Continue to next directory
      }
    }
  }

  private saveTokens(): void {
    try {
      fs.mkdirSync(this.activeTokenDir, { recursive: true });
      if (this.oauth1Token) {
        fs.writeFileSync(
          path.join(this.activeTokenDir, 'oauth1_token.json'),
          JSON.stringify(this.oauth1Token, null, 2),
        );
      }
      if (this.oauth2Token) {
        fs.writeFileSync(
          path.join(this.activeTokenDir, 'oauth2_token.json'),
          JSON.stringify(this.oauth2Token, null, 2),
        );
      }
      if (this.profile) {
        fs.writeFileSync(
          path.join(this.activeTokenDir, 'profile.json'),
          JSON.stringify(this.profile, null, 2),
        );
      }
    } catch (err) {
      console.error('Warning: failed to persist Garmin tokens:', err);
    }
  }

  private isOAuth2Valid(): boolean {
    if (!this.oauth2Token) return false;
    const now = Math.floor(Date.now() / 1000);
    return this.oauth2Token.expires_at > now + TOKEN_EXPIRY_BUFFER_SECONDS;
  }

  private createOAuth1Instance(): OAuth {
    return new OAuth({
      consumer: {
        key: this.consumer!.consumer_key,
        secret: this.consumer!.consumer_secret,
      },
      signature_method: 'HMAC-SHA1',
      hash_function(baseString: string, key: string) {
        return crypto.createHmac('sha1', key).update(baseString).digest('base64');
      },
    });
  }

  private async fetchConsumerCredentials(): Promise<void> {
    if (this.consumer) return;
    const response = await axios.get<OAuthConsumer>(OAUTH_CONSUMER_URL);
    this.consumer = response.data;
  }

  private async exchangeOAuth1ToOAuth2(): Promise<void> {
    if (!this.oauth1Token) {
      throw new Error('Garmin OAuth1 token not found in ~/.garmin-mcp/');
    }
    await this.fetchConsumerCredentials();
    const oauth = this.createOAuth1Instance();
    const token = {
      key: this.oauth1Token.oauth_token,
      secret: this.oauth1Token.oauth_token_secret,
    };

    const requestData = { url: OAUTH_EXCHANGE, method: 'POST' as const };
    const authHeader = oauth.toHeader(oauth.authorize(requestData, token));

    const response = await axios.post<OAuth2Token>(OAUTH_EXCHANGE, null, {
      headers: {
        ...authHeader,
        'User-Agent': USER_AGENT_MOBILE,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const now = Math.floor(Date.now() / 1000);
    this.oauth2Token = {
      ...response.data,
      expires_at: now + response.data.expires_in,
      refresh_token_expires_at: now + response.data.refresh_token_expires_in,
    };
    this.saveTokens();
  }

  async ensureAuthenticated(): Promise<void> {
    if (!this.oauth1Token) {
      this.loadTokens();
    }
    if (!this.oauth1Token) {
      throw new Error(
        'No Garmin Connect OAuth tokens found in ~/.garmin-mcp/ or ~/.garminconnect/',
      );
    }
    if (!this.isOAuth2Valid()) {
      await this.exchangeOAuth1ToOAuth2();
    }
    if (!this.profile) {
      try {
        const res = await axios.get<Record<string, unknown>>(PROFILE_URL, {
          headers: {
            Authorization: `Bearer ${this.oauth2Token!.access_token}`,
            'User-Agent': USER_AGENT_MOBILE,
          },
        });
        this.profile = {
          displayName: String(res.data.displayName ?? ''),
          profileId: Number(res.data.profileId ?? 0),
          fullName: String(res.data.fullName ?? res.data.userProfileFullName ?? ''),
        };
        this.saveTokens();
      } catch {
        // Non-fatal
      }
    }
  }

  async request<T>(
    endpoint: string,
    options?: { method?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<T> {
    await this.ensureAuthenticated();
    const url = endpoint.startsWith('http') ? endpoint : `${GARMIN_CONNECT_API}${endpoint}`;
    const method = (options?.method ?? 'GET').toUpperCase();

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.oauth2Token!.access_token}`,
          'User-Agent': USER_AGENT_MOBILE,
          ...options?.headers,
        };
        if (options?.body !== undefined && !headers['Content-Type']) {
          headers['Content-Type'] = 'application/json';
        }
        const response = await axios<T>({
          url,
          method,
          headers,
          data: options?.body,
        });
        return response.data;
      } catch (err: unknown) {
        if (axios.isAxiosError(err) && err.response?.status === 401 && attempt === 0) {
          await this.exchangeOAuth1ToOAuth2();
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Garmin API request failed: ${endpoint}`);
  }

  async getStatus(): Promise<{
    connected: boolean;
    displayName: string;
    tokenDir: string;
    error?: string;
  }> {
    try {
      await this.ensureAuthenticated();
      return {
        connected: true,
        displayName: this.profile?.fullName || this.profile?.displayName || 'Garmin User',
        tokenDir: this.activeTokenDir,
      };
    } catch (err) {
      return {
        connected: false,
        displayName: '',
        tokenDir: this.activeTokenDir,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getDailyNutritionOverview(date?: string): Promise<GarminDailyNutritionOverview> {
    const resolvedDate = date ?? todayString();
    await this.ensureAuthenticated();

    const [foodLogRaw, summaryRaw] = await Promise.all([
      this.request<Record<string, unknown>>(`/nutrition-service/food/logs/${resolvedDate}`),
      this.request<Record<string, unknown>>(
        `/usersummary-service/usersummary/daily/${this.profile?.displayName}?calendarDate=${resolvedDate}`,
      ).catch(() => null),
    ]);

    const rawGoals = (foodLogRaw?.dailyNutritionGoals ?? {}) as Record<string, number>;
    const rawContent = (foodLogRaw?.dailyNutritionContent ?? {}) as Record<string, number>;
    const rawMealDetails = (foodLogRaw?.mealDetails ?? []) as Array<Record<string, unknown>>;

    const meals: GarminMealDefinition[] = [];
    const loggedFoods: GarminLoggedFoodItem[] = [];

    for (const md of rawMealDetails) {
      const mealObj = (md.meal ?? {}) as Record<string, unknown>;
      const mealId = Number(mealObj.mealId ?? 0);
      const mealName = String(mealObj.mealName ?? 'LUNCH') as MealName;
      meals.push({
        mealId,
        mealIndex: Number(mealObj.mealIndex ?? 0),
        mealName,
        startTime: mealObj.startTime ? String(mealObj.startTime) : undefined,
        endTime: mealObj.endTime ? String(mealObj.endTime) : undefined,
        goals: mealObj.goals as GarminMealDefinition['goals'],
      });

      const items = (md.loggedFoods ?? []) as Array<Record<string, unknown>>;
      for (const item of items) {
        const meta = (item.foodMetaData ?? {}) as Record<string, unknown>;
        const nutr = (item.nutritionContent ?? {}) as Record<string, number>;
        loggedFoods.push({
          logId: String(item.logId ?? ''),
          logTimestamp: String(item.logTimestamp ?? ''),
          logCategory: String(item.logCategory ?? 'QUICK_ADD'),
          mealId: Number(item.mealId ?? mealId),
          mealName,
          mealTime: String(item.mealTime ?? ''),
          name: String(meta.foodName ?? item.name ?? 'Logged Food'),
          calories: Math.round(Number(nutr.calories ?? 0)),
          carbs: Math.round(Number(nutr.carbs ?? 0)),
          protein: Math.round(Number(nutr.protein ?? 0)),
          fat: Math.round(Number(nutr.fat ?? 0)),
        });
      }
    }

    // Calculate consumed totals either from dailyNutritionContent or sum of loggedFoods
    const sumCalories = loggedFoods.reduce((acc, f) => acc + f.calories, 0);
    const sumCarbs = loggedFoods.reduce((acc, f) => acc + f.carbs, 0);
    const sumProtein = loggedFoods.reduce((acc, f) => acc + f.protein, 0);
    const sumFat = loggedFoods.reduce((acc, f) => acc + f.fat, 0);

    const targetCalories = Number(rawGoals.adjustedCalories ?? rawGoals.calories ?? 2000);
    const consumedCalories = Number(rawContent.calories ?? sumCalories);

    return {
      date: resolvedDate,
      goals: {
        calories: Number(rawGoals.calories ?? 2000),
        adjustedCalories: targetCalories,
        carbs: Number(rawGoals.carbs ?? 220),
        adjustedCarbs: Number(rawGoals.adjustedCarbs ?? rawGoals.carbs ?? 220),
        protein: Number(rawGoals.protein ?? 140),
        adjustedProtein: Number(rawGoals.adjustedProtein ?? rawGoals.protein ?? 140),
        fat: Number(rawGoals.fat ?? 65),
        adjustedFat: Number(rawGoals.adjustedFat ?? rawGoals.fat ?? 65),
      },
      consumed: {
        calories: consumedCalories,
        carbs: Number(rawContent.carbs ?? sumCarbs),
        protein: Number(rawContent.protein ?? sumProtein),
        fat: Number(rawContent.fat ?? sumFat),
        caloriesPercentage:
          targetCalories > 0 ? Math.round((consumedCalories / targetCalories) * 100) : 0,
      },
      activity: {
        totalBurnedCalories:
          summaryRaw?.totalKilocalories != null ? Number(summaryRaw.totalKilocalories) : null,
        activeCalories:
          summaryRaw?.activeKilocalories != null ? Number(summaryRaw.activeKilocalories) : null,
        bmrCalories:
          summaryRaw?.bmrKilocalories != null ? Number(summaryRaw.bmrKilocalories) : null,
        steps: summaryRaw?.totalSteps != null ? Number(summaryRaw.totalSteps) : null,
      },
      meals,
      loggedFoods,
    };
  }

  private async resolveMealAndTime(
    date: string,
    requestedMeal?: MealName,
    requestedTime?: string,
  ): Promise<{ mealId: number; mealTime: string; mealName: MealName }> {
    const mealsRes = await this.request<{
      meals?: Array<{ mealId: number; mealName: MealName; startTime?: string; endTime?: string }>;
    }>(`/nutrition-service/meals/${date}`);

    const meals = mealsRes?.meals ?? [];
    if (meals.length === 0) {
      throw new Error(
        `No nutrition meals found in Garmin Connect for ${date}. Open Garmin Connect app > Nutrition once to initialize meals.`,
      );
    }

    const padTime = (t: string): string => {
      const clean = t.trim();
      return clean.length === 5 ? `${clean}:00` : clean;
    };

    const within = (
      m: { startTime?: string; endTime?: string },
      t: string,
    ): boolean => Boolean(m.startTime && m.endTime && padTime(m.startTime) <= t && t <= padTime(m.endTime));

    const addMinute = (t: string): string => {
      const [h, m] = t.split(':').map(Number) as [number, number];
      const total = Math.min(h * 60 + m + 1, 23 * 60 + 59);
      return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00`;
    };

    const mealName: MealName = requestedMeal ?? suggestMealForCurrentTime();
    const chosen = meals.find((m) => m.mealName === mealName) ?? meals[0]!;
    const others = meals.filter((m) => m !== chosen);

    // Garmin enforces that SNACKS time must NOT fall inside BREAKFAST, LUNCH, or DINNER windows
    const fitsChosen = (t: string): boolean => {
      if (chosen.mealName === 'SNACKS') {
        return !others.some((m) => m.mealName !== 'SNACKS' && within(m, t));
      }
      return chosen.startTime && chosen.endTime ? within(chosen, t) : true;
    };

    if (requestedTime) {
      const formatted = padTime(requestedTime);
      if (fitsChosen(formatted)) {
        return { mealId: chosen.mealId, mealTime: formatted, mealName: chosen.mealName };
      }
    }

    // Pick a valid time inside the chosen meal window (or outside B/L/D for SNACKS)
    const ownStart = chosen.startTime ? [padTime(chosen.startTime)] : [];
    const gapsAfterMeals = others
      .filter((m) => m.endTime)
      .map((m) => addMinute(padTime(m.endTime!)))
      .sort();

    const candidates =
      chosen.mealName === 'SNACKS'
        ? ['15:30:00', '10:30:00', ...gapsAfterMeals, ...ownStart]
        : [...ownStart, '12:30:00', '19:00:00', '08:00:00'];

    const picked = candidates.find((t) => fitsChosen(t)) ?? ownStart[0] ?? '12:30:00';
    return { mealId: chosen.mealId, mealTime: picked, mealName: chosen.mealName };
  }

  async quickAddDish(input: QuickAddDishInput): Promise<{
    logId: string | null;
    mealName: MealName;
    mealTime: string;
    customFoodId?: string;
    overview: GarminDailyNutritionOverview;
  }> {
    const resolvedDate = input.date ?? todayString();
    const cleanName = input.name.trim() || 'Logged Dish';
    const calories = Math.max(0, Math.round(Number(input.calories) || 0));
    const carbs = Math.max(0, Math.round(Number(input.carbs) || 0));
    const protein = Math.max(0, Math.round(Number(input.protein) || 0));
    const fat = Math.max(0, Math.round(Number(input.fat) || 0));

    const { mealId, mealTime, mealName } = await this.resolveMealAndTime(
      resolvedDate,
      input.meal,
      input.time,
    );

    const logTimestamp = `${new Date().toISOString().slice(0, 19)}.000Z`;

    await this.request('/nutrition-service/food/logs/quickAdd', {
      method: 'PUT',
      body: {
        mealDate: resolvedDate,
        quickAddItems: [
          {
            name: cleanName,
            logId: null,
            logTimestamp,
            logSource: 'GCW',
            logCategory: 'QUICK_ADD',
            mealTime,
            mealId,
            action: 'ADD',
            calories: String(calories),
            carbs: String(carbs),
            protein: String(protein),
            fat: String(fat),
          },
        ],
      },
    });

    let customFoodId: string | undefined;
    if (input.saveCustomFood) {
      try {
        const serving: Record<string, string> = {
          servingUnit: 'G',
          numberOfUnits: String(Math.max(1, Math.round(input.grams ?? 350))),
          calories: String(calories),
          carbs: String(carbs),
          protein: String(protein),
          fat: String(fat),
        };
        if (typeof input.fiber === 'number' && input.fiber >= 0) {
          serving.fiber = String(Math.round(input.fiber));
        }
        const customRes = await this.request<Record<string, unknown>>(
          '/nutrition-service/customFood',
          {
            method: 'PUT',
            body: {
              foodMetaData: {
                foodName: cleanName,
                foodType: 'GENERIC',
                source: 'GARMIN',
                regionCode: 'US',
                languageCode: 'en',
              },
              nutritionContents: [serving],
            },
          },
        );
        const meta = (customRes?.foodMetaData ?? {}) as Record<string, unknown>;
        if (meta.foodId) customFoodId = String(meta.foodId);
      } catch (err) {
        console.error('Optional custom food creation failed:', err);
      }
    }

    const overview = await this.getDailyNutritionOverview(resolvedDate);
    const matchingLogs = overview.loggedFoods.filter(
      (f) => f.name === cleanName && f.mealId === mealId && f.calories === calories,
    );
    const newestLog = matchingLogs[matchingLogs.length - 1] ?? null;

    return {
      logId: newestLog?.logId ?? null,
      mealName,
      mealTime,
      customFoodId,
      overview,
    };
  }

  async deleteFoodLogEntry(
    date: string,
    logId: string,
  ): Promise<GarminDailyNutritionOverview> {
    await this.request(`/nutrition-service/food/logs/${date}`, {
      method: 'DELETE',
      body: { logIds: [logId] },
    });
    return this.getDailyNutritionOverview(date);
  }
}

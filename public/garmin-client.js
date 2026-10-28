/**
 * Garmin Connect Direct Client for Mobile & Browser
 * Runs directly on Android (via CapacitorHttp, bypassing CORS) without requiring any server.
 */

const OAUTH_CONSUMER_URL = 'https://thegarth.s3.amazonaws.com/oauth_consumer.json';
const SSO_EMBED = 'https://sso.garmin.com/sso/embed';
const SSO_SIGNIN = 'https://sso.garmin.com/sso/signin';
const SSO_ORIGIN = 'https://sso.garmin.com';
const SSO_VERIFY_MFA = 'https://sso.garmin.com/sso/verifyMFA/loginEnterMfaCode';
const GARMIN_CONNECT_API = 'https://connectapi.garmin.com';
const OAUTH_PREAUTHORIZED = `${GARMIN_CONNECT_API}/oauth-service/oauth/preauthorized`;
const OAUTH_EXCHANGE = `${GARMIN_CONNECT_API}/oauth-service/oauth/exchange/user/2.0`;
const PROFILE_URL = `${GARMIN_CONNECT_API}/userprofile-service/socialProfile`;

const SSO_CLIENT_ID = 'GarminConnect';
const SSO_LOCALE = 'en';
const SSO_WIDGET_ID = 'gauth-widget';

const USER_AGENT_MOBILE = 'com.garmin.android.apps.connectmobile';
const USER_AGENT_BROWSER =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

const CSRF_REGEX = /name="_csrf"\s+value="(.+?)"/;
const TICKET_REGEX = /ticket=([^"&]+)/;
const TITLE_REGEX = /<title>(.+?)<\/title>/;

// Storage keys
const KEY_OAUTH1 = 'gdl_garmin_oauth1';
const KEY_OAUTH2 = 'gdl_garmin_oauth2';
const KEY_PROFILE = 'gdl_garmin_profile';
const KEY_CONSUMER = 'gdl_garmin_consumer';

// Helper: HTTP request using CapacitorHttp if available, otherwise fetch
async function httpReq(options) {
  const method = (options.method || 'GET').toUpperCase();
  const url = options.url;
  const headers = options.headers || {};
  const data = options.data;
  const params = options.params;

  // 1. Capacitor Native HTTP (bypasses CORS on Android)
  if (window.Capacitor?.Plugins?.CapacitorHttp) {
    try {
      const res = await window.Capacitor.Plugins.CapacitorHttp.request({
        method,
        url,
        headers,
        data,
        params,
      });
      return {
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        headers: res.headers || {},
        data: res.data,
      };
    } catch (err) {
      console.warn('CapacitorHttp failed, falling back to fetch:', err);
    }
  }

  // 2. Standard Fetch fallback
  let fullUrl = url;
  if (params && Object.keys(params).length > 0) {
    const sp = new URLSearchParams(params);
    fullUrl += (fullUrl.includes('?') ? '&' : '?') + sp.toString();
  }

  let body = undefined;
  if (data !== undefined && method !== 'GET' && method !== 'HEAD') {
    if (typeof data === 'string') {
      body = data;
    } else if (headers['Content-Type']?.includes('x-www-form-urlencoded')) {
      body = new URLSearchParams(data).toString();
    } else {
      body = JSON.stringify(data);
    }
  }

  const res = await fetch(fullUrl, {
    method,
    headers,
    body,
  });

  const contentType = res.headers.get('content-type') || '';
  let resData;
  if (contentType.includes('application/json')) {
    resData = await res.json();
  } else {
    resData = await res.text();
  }

  const resHeaders = {};
  res.headers.forEach((val, key) => {
    resHeaders[key] = val;
  });

  return {
    status: res.status,
    ok: res.ok,
    headers: resHeaders,
    data: resData,
  };
}

// Web Crypto HMAC-SHA1
async function hmacSha1Base64(keyStr, dataStr) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(keyStr),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(dataStr));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

// OAuth 1.0a signer
async function generateOAuth1Header(method, url, consumer, token = null, extraParams = {}) {
  const urlObj = new URL(url);
  const baseUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;

  const oauthParams = {
    oauth_consumer_key: consumer.consumer_key,
    oauth_nonce: Math.random().toString(36).substring(2) + Date.now().toString(36),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: '1.0',
    ...extraParams,
  };

  if (token?.oauth_token) {
    oauthParams.oauth_token = token.oauth_token;
  }

  // Include existing query params in signature
  urlObj.searchParams.forEach((val, key) => {
    oauthParams[key] = val;
  });

  // Sort and encode parameters
  const sortedKeys = Object.keys(oauthParams).sort();
  const paramPairs = sortedKeys.map(
    (k) => `${encodeURIComponent(k)}=${encodeURIComponent(oauthParams[k])}`
  );
  const paramString = paramPairs.join('&');

  const baseString = `${method.toUpperCase()}&${encodeURIComponent(baseUrl)}&${encodeURIComponent(paramString)}`;
  const signingKey = `${encodeURIComponent(consumer.consumer_secret)}&${encodeURIComponent(token?.oauth_token_secret || '')}`;

  const signature = await hmacSha1Base64(signingKey, baseString);
  oauthParams.oauth_signature = signature;

  // Format Authorization header
  const headerPairs = Object.keys(oauthParams)
    .filter((k) => k.startsWith('oauth_'))
    .sort()
    .map((k) => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`);

  return {
    Authorization: `OAuth ${headerPairs.join(', ')}`,
    oauthParams,
  };
}

class DirectGarminClient {
  constructor() {
    this.consumer = null;
    this.oauth1Token = null;
    this.oauth2Token = null;
    this.profile = null;
    this.pendingMfaState = null;
    this.loadFromStorage();
  }

  loadFromStorage() {
    try {
      this.oauth1Token = JSON.parse(localStorage.getItem(KEY_OAUTH1) || 'null');
      this.oauth2Token = JSON.parse(localStorage.getItem(KEY_OAUTH2) || 'null');
      this.profile = JSON.parse(localStorage.getItem(KEY_PROFILE) || 'null');
      this.consumer = JSON.parse(localStorage.getItem(KEY_CONSUMER) || 'null');
    } catch {
      // Ignore
    }
  }

  saveToStorage() {
    try {
      if (this.oauth1Token) localStorage.setItem(KEY_OAUTH1, JSON.stringify(this.oauth1Token));
      else localStorage.removeItem(KEY_OAUTH1);

      if (this.oauth2Token) localStorage.setItem(KEY_OAUTH2, JSON.stringify(this.oauth2Token));
      else localStorage.removeItem(KEY_OAUTH2);

      if (this.profile) localStorage.setItem(KEY_PROFILE, JSON.stringify(this.profile));
      else localStorage.removeItem(KEY_PROFILE);

      if (this.consumer) localStorage.setItem(KEY_CONSUMER, JSON.stringify(this.consumer));
    } catch {
      // Ignore
    }
  }

  isConnected() {
    return Boolean(this.oauth1Token && this.oauth2Token);
  }

  getProfile() {
    return this.profile;
  }

  logout() {
    this.oauth1Token = null;
    this.oauth2Token = null;
    this.profile = null;
    this.saveToStorage();
  }

  importTokens(oauth1, oauth2, profile) {
    this.oauth1Token = oauth1;
    this.oauth2Token = oauth2;
    this.profile = profile || null;
    this.saveToStorage();
  }

  async fetchConsumer() {
    if (this.consumer) return this.consumer;
    const res = await httpReq({ url: OAUTH_CONSUMER_URL });
    if (res.ok && res.data?.consumer_key) {
      this.consumer = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
      this.saveToStorage();
      return this.consumer;
    }
    throw new Error('Failed to fetch Garmin OAuth consumer credentials');
  }

  isOAuth2Valid() {
    if (!this.oauth2Token?.expires_at) return false;
    const now = Math.floor(Date.now() / 1000);
    return this.oauth2Token.expires_at > now + 60;
  }

  async exchangeOAuth1ForOAuth2() {
    if (!this.oauth1Token) throw new Error('No OAuth1 token available');
    const consumer = await this.fetchConsumer();

    const { oauthParams } = await generateOAuth1Header(
      'POST',
      OAUTH_EXCHANGE,
      consumer,
      this.oauth1Token
    );

    const queryParams = new URLSearchParams();
    for (const [k, v] of Object.entries(oauthParams)) {
      queryParams.set(k, String(v));
    }

    const exchangeUrl = `${OAUTH_EXCHANGE}?${queryParams.toString()}`;
    const res = await httpReq({
      method: 'POST',
      url: exchangeUrl,
      headers: {
        'User-Agent': USER_AGENT_MOBILE,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!res.ok) {
      throw new Error(`OAuth2 exchange failed (${res.status}): ${JSON.stringify(res.data)}`);
    }

    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    const now = Math.floor(Date.now() / 1000);
    this.oauth2Token = {
      ...data,
      expires_at: now + (data.expires_in || 3600),
      refresh_token_expires_at: now + (data.refresh_token_expires_in || 86400 * 30),
    };
    this.saveToStorage();
  }

  async ensureAuthenticated() {
    if (!this.oauth1Token) {
      throw new Error('Garmin account not connected. Please log in in Settings.');
    }
    if (!this.isOAuth2Valid()) {
      await this.exchangeOAuth1ForOAuth2();
    }
    if (!this.profile) {
      await this.fetchProfile();
    }
  }

  async fetchProfile() {
    const res = await httpReq({
      url: PROFILE_URL,
      headers: {
        Authorization: `Bearer ${this.oauth2Token.access_token}`,
        'User-Agent': USER_AGENT_MOBILE,
      },
    });
    if (res.ok) {
      const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
      this.profile = {
        displayName: String(data.displayName || ''),
        profileId: Number(data.profileId || 0),
        fullName: String(data.fullName || data.userProfileFullName || data.displayName || ''),
      };
      this.saveToStorage();
      return this.profile;
    }
  }

  // Interactive Garmin Login via SSO with MFA support
  async loginWithCredentials(email, password, mfaCode = null) {
    const consumer = await this.fetchConsumer();

    // Helper to extract cookies from headers
    const cookieMap = {};
    const extractCookies = (headers) => {
      const setCookies =
        headers['set-cookie'] || headers['Set-Cookie'] || headers['SET-COOKIE'];
      if (!setCookies) return;
      const list = Array.isArray(setCookies) ? setCookies : [setCookies];
      for (const str of list) {
        const parts = String(str).split(';');
        const pair = parts[0]?.trim();
        if (pair && pair.includes('=')) {
          const [k, v] = pair.split('=');
          cookieMap[k.trim()] = v.trim();
        }
      }
    };
    const getCookieHeader = () =>
      Object.entries(cookieMap)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');

    // If resuming from MFA:
    if (mfaCode && this.pendingMfaState) {
      const state = this.pendingMfaState;
      Object.assign(cookieMap, state.cookieMap);

      const mfaParams = new URLSearchParams({
        'mfa-code': mfaCode.trim(),
        embed: 'true',
        _csrf: state.mfaCsrf,
        fromPage: 'setupEnterMfaCode',
      });

      const mfaRes = await httpReq({
        method: 'POST',
        url: SSO_VERIFY_MFA,
        params: state.signinParams,
        data: mfaParams.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT_BROWSER,
          Origin: SSO_ORIGIN,
          Referer: SSO_SIGNIN,
          Cookie: getCookieHeader(),
        },
      });

      extractCookies(mfaRes.headers);
      const html = typeof mfaRes.data === 'string' ? mfaRes.data : JSON.stringify(mfaRes.data);
      const ticketMatch = TICKET_REGEX.exec(html);
      if (!ticketMatch) {
        throw new Error('Invalid MFA verification code. Please check and try again.');
      }

      const ticket = ticketMatch[1];
      this.pendingMfaState = null;
      return await this.completeLoginWithTicket(ticket, consumer);
    }

    // Step 1: SSO Embed
    const embedRes = await httpReq({
      url: SSO_EMBED,
      params: { clientId: SSO_CLIENT_ID, locale: SSO_LOCALE, service: SSO_EMBED },
      headers: { 'User-Agent': USER_AGENT_BROWSER },
    });
    extractCookies(embedRes.headers);

    // Step 2: SSO Signin page to get CSRF
    const signinParams = {
      id: SSO_WIDGET_ID,
      embedWidget: 'true',
      locale: SSO_LOCALE,
      gauthHost: SSO_EMBED,
    };
    const signinPageRes = await httpReq({
      url: SSO_SIGNIN,
      params: signinParams,
      headers: {
        'User-Agent': USER_AGENT_BROWSER,
        Cookie: getCookieHeader(),
      },
    });
    extractCookies(signinPageRes.headers);

    const signinHtml =
      typeof signinPageRes.data === 'string'
        ? signinPageRes.data
        : JSON.stringify(signinPageRes.data);
    const csrfMatch = CSRF_REGEX.exec(signinHtml);
    if (!csrfMatch) {
      throw new Error('Unable to extract CSRF token from Garmin SSO. Please try again.');
    }
    const csrfToken = csrfMatch[1];

    // Step 3: Post credentials
    const loginData = new URLSearchParams({
      username: email.trim(),
      password,
      embed: 'true',
      _csrf: csrfToken,
    });

    const loginRes = await httpReq({
      method: 'POST',
      url: SSO_SIGNIN,
      params: {
        ...signinParams,
        clientId: SSO_CLIENT_ID,
        service: SSO_EMBED,
        source: SSO_EMBED,
        redirectAfterAccountLoginUrl: SSO_EMBED,
        redirectAfterAccountCreationUrl: SSO_EMBED,
      },
      data: loginData.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT_BROWSER,
        Origin: SSO_ORIGIN,
        Referer: SSO_SIGNIN,
        Cookie: getCookieHeader(),
      },
    });
    extractCookies(loginRes.headers);

    const responseHtml =
      typeof loginRes.data === 'string' ? loginRes.data : JSON.stringify(loginRes.data);
    const titleMatch = TITLE_REGEX.exec(responseHtml);
    const title = titleMatch?.[1] || '';

    // Check if 2-Factor Authentication (MFA) is required
    if (title.includes('MFA')) {
      const mfaCsrfMatch = CSRF_REGEX.exec(responseHtml);
      if (!mfaCsrfMatch) throw new Error('MFA required but unable to extract MFA token');
      this.pendingMfaState = {
        mfaCsrf: mfaCsrfMatch[1],
        signinParams,
        cookieMap,
      };
      return { mfaRequired: true, message: 'Please enter the MFA security code sent to your phone or email.' };
    }

    const ticketMatch = TICKET_REGEX.exec(responseHtml);
    if (!ticketMatch) {
      throw new Error('Garmin login failed. Please verify your email and password.');
    }

    const ticket = ticketMatch[1];
    return await this.completeLoginWithTicket(ticket, consumer);
  }

  async completeLoginWithTicket(ticket, consumer) {
    // Step 4: Exchange ticket for OAuth 1
    const preauthUrl = `${OAUTH_PREAUTHORIZED}?ticket=${encodeURIComponent(ticket)}&login-url=${encodeURIComponent(SSO_EMBED)}&accepts-mfa-tokens=true`;
    const { Authorization } = await generateOAuth1Header('GET', preauthUrl, consumer);

    const preauthRes = await httpReq({
      url: preauthUrl,
      headers: {
        Authorization,
        'User-Agent': USER_AGENT_MOBILE,
      },
    });

    if (!preauthRes.ok) {
      throw new Error(`Ticket exchange failed (${preauthRes.status})`);
    }

    const params = new URLSearchParams(String(preauthRes.data));
    const oauthToken = params.get('oauth_token');
    const oauthTokenSecret = params.get('oauth_token_secret');

    if (!oauthToken || !oauthTokenSecret) {
      throw new Error('Garmin did not return OAuth1 tokens');
    }

    this.oauth1Token = {
      oauth_token: oauthToken,
      oauth_token_secret: oauthTokenSecret,
    };

    // Step 5: Exchange OAuth 1 for OAuth 2
    await this.exchangeOAuth1ForOAuth2();

    // Step 6: Fetch Profile
    await this.fetchProfile();

    return {
      success: true,
      profile: this.profile,
    };
  }

  async request(endpoint, options = {}) {
    await this.ensureAuthenticated();
    const url = endpoint.startsWith('http') ? endpoint : `${GARMIN_CONNECT_API}${endpoint}`;
    const method = (options.method || 'GET').toUpperCase();

    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = {
        Authorization: `Bearer ${this.oauth2Token.access_token}`,
        'User-Agent': USER_AGENT_MOBILE,
        ...(options.headers || {}),
      };
      if (options.data !== undefined && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }

      const res = await httpReq({
        method,
        url,
        headers,
        data: options.data,
      });

      if (res.status === 401 && attempt === 0) {
        await this.exchangeOAuth1ForOAuth2();
        continue;
      }

      if (!res.ok) {
        throw new Error(`Garmin API error (${res.status}): ${JSON.stringify(res.data)}`);
      }

      return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    }
  }

  // Daily Nutrition Overview
  async getDailyNutrition(dateStr) {
    const today = new Date().toISOString().slice(0, 10);
    const resolvedDate = dateStr || today;

    const [foodLogRaw, summaryRaw] = await Promise.all([
      this.request(`/nutrition-service/food/logs/${resolvedDate}`).catch(() => null),
      this.request(
        `/usersummary-service/usersummary/daily/${this.profile?.displayName}?calendarDate=${resolvedDate}`
      ).catch(() => null),
    ]);

    const rawGoals = foodLogRaw?.dailyNutritionGoals || {};
    const rawContent = foodLogRaw?.dailyNutritionContent || {};
    const rawMealDetails = foodLogRaw?.mealDetails || [];

    const meals = [];
    const loggedFoods = [];

    for (const md of rawMealDetails) {
      const mealObj = md.meal || {};
      const mealId = Number(mealObj.mealId || 0);
      const mealName = String(mealObj.mealName || 'LUNCH');
      meals.push({
        mealId,
        mealIndex: Number(mealObj.mealIndex || 0),
        mealName,
        startTime: mealObj.startTime ? String(mealObj.startTime) : undefined,
        endTime: mealObj.endTime ? String(mealObj.endTime) : undefined,
        goals: mealObj.goals,
      });

      const items = md.loggedFoods || [];
      for (const item of items) {
        const meta = item.foodMetaData || {};
        const nutr = item.nutritionContent || {};
        loggedFoods.push({
          logId: String(item.logId || ''),
          logTimestamp: String(item.logTimestamp || ''),
          logCategory: String(item.logCategory || 'QUICK_ADD'),
          mealId: Number(item.mealId || mealId),
          mealName,
          mealTime: String(item.mealTime || ''),
          name: String(meta.foodName || item.name || 'Logged Food'),
          calories: Math.round(Number(nutr.calories || 0)),
          carbs: Math.round(Number(nutr.carbs || 0)),
          protein: Math.round(Number(nutr.protein || 0)),
          fat: Math.round(Number(nutr.fat || 0)),
        });
      }
    }

    const sumCalories = loggedFoods.reduce((acc, f) => acc + f.calories, 0);
    const sumCarbs = loggedFoods.reduce((acc, f) => acc + f.carbs, 0);
    const sumProtein = loggedFoods.reduce((acc, f) => acc + f.protein, 0);
    const sumFat = loggedFoods.reduce((acc, f) => acc + f.fat, 0);

    const targetCalories = Number(rawGoals.adjustedCalories || rawGoals.calories || 2000);
    const consumedCalories = Number(rawContent.calories || sumCalories);

    return {
      date: resolvedDate,
      goals: {
        calories: Number(rawGoals.calories || 2000),
        adjustedCalories: targetCalories,
        carbs: Number(rawGoals.carbs || 220),
        adjustedCarbs: Number(rawGoals.adjustedCarbs || rawGoals.carbs || 220),
        protein: Number(rawGoals.protein || 140),
        adjustedProtein: Number(rawGoals.adjustedProtein || rawGoals.protein || 140),
        fat: Number(rawGoals.fat || 65),
        adjustedFat: Number(rawGoals.adjustedFat || rawGoals.fat || 65),
      },
      consumed: {
        calories: consumedCalories,
        carbs: Number(rawContent.carbs || sumCarbs),
        protein: Number(rawContent.protein || sumProtein),
        fat: Number(rawContent.fat || sumFat),
        caloriesPercentage:
          targetCalories > 0 ? Math.round((consumedCalories / targetCalories) * 100) : 0,
      },
      activity: {
        totalBurnedCalories: summaryRaw?.totalKilocalories != null ? Number(summaryRaw.totalKilocalories) : null,
        activeCalories: summaryRaw?.activeKilocalories != null ? Number(summaryRaw.activeKilocalories) : null,
        bmrCalories: summaryRaw?.bmrKilocalories != null ? Number(summaryRaw.bmrKilocalories) : null,
        steps: summaryRaw?.totalSteps != null ? Number(summaryRaw.totalSteps) : null,
      },
      meals,
      loggedFoods,
    };
  }

  // Quick Add Dish directly to Garmin Connect
  async quickAddDish(input) {
    const resolvedDate = input.date || new Date().toISOString().slice(0, 10);
    const cleanName = (input.name || 'Logged Dish').trim();
    const calories = Math.max(0, Math.round(Number(input.calories) || 0));
    const carbs = Math.max(0, Math.round(Number(input.carbs) || 0));
    const protein = Math.max(0, Math.round(Number(input.protein) || 0));
    const fat = Math.max(0, Math.round(Number(input.fat) || 0));

    // Resolve meal windows
    const mealsRes = await this.request(`/nutrition-service/meals/${resolvedDate}`).catch(() => ({ meals: [] }));
    const meals = mealsRes?.meals || [];
    const chosen = meals.find((m) => m.mealName === (input.meal || 'LUNCH')) || meals[0] || { mealId: 1, mealName: 'LUNCH' };

    const mealTime = chosen.startTime ? `${chosen.startTime.slice(0, 5)}:00` : '12:30:00';
    const logTimestamp = `${new Date().toISOString().slice(0, 19)}.000Z`;

    await this.request('/nutrition-service/food/logs/quickAdd', {
      method: 'PUT',
      data: {
        mealDate: resolvedDate,
        quickAddItems: [
          {
            name: cleanName,
            logId: null,
            logTimestamp,
            logSource: 'GCW',
            logCategory: 'QUICK_ADD',
            mealTime,
            mealId: chosen.mealId,
            action: 'ADD',
            calories: String(calories),
            carbs: String(carbs),
            protein: String(protein),
            fat: String(fat),
          },
        ],
      },
    });

    // Optional save as custom food
    if (input.saveCustomFood) {
      try {
        await this.request('/nutrition-service/customFood', {
          method: 'PUT',
          data: {
            foodMetaData: {
              foodName: cleanName,
              foodType: 'GENERIC',
              source: 'GARMIN',
              regionCode: 'US',
              languageCode: 'en',
            },
            nutritionContents: [
              {
                servingUnit: 'G',
                numberOfUnits: String(Math.max(1, Math.round(input.grams || 350))),
                calories: String(calories),
                carbs: String(carbs),
                protein: String(protein),
                fat: String(fat),
              },
            ],
          },
        });
      } catch (err) {
        console.warn('Custom food creation ignored:', err);
      }
    }

    return await this.getDailyNutrition(resolvedDate);
  }

  // Delete logged entry
  async deleteFoodLogEntry(dateStr, logId) {
    await this.request(`/nutrition-service/food/logs/${dateStr}`, {
      method: 'DELETE',
      data: { logIds: [logId] },
    });
    return await this.getDailyNutrition(dateStr);
  }
}

export const directGarmin = new DirectGarminClient();

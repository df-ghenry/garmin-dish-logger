// Garmin Dish Logger Frontend Application

const BEACON_GIST_URL = 'https://api.github.com/gists/1d47f9c40ee2ac4743ff81b62351ddad';
const BEACON_RAW_URL =
  'https://gist.githubusercontent.com/df-ghenry/1d47f9c40ee2ac4743ff81b62351ddad/raw/garmin-dish-logger-beacon.json';

const state = {
  selectedDate: getLocalTodayString(),
  imageBase64: null,
  imageMimeType: null,
  thumbnailDataUrl: null,
  currentAnalysis: null,
  baseIngredients: [], // 1.0x reference ingredients
  portionMultiplier: 1.0,
  selectedMeal: 'LUNCH',
  garminOverview: null,
  historyItems: [],
  geminiConfigured: false,
  deferredInstallPrompt: null,
  primaryHttpUrl: window.location.origin,
  primaryHttpsUrl: null,
  tunnelUrl: null,
  apiBaseUrl: localStorage.getItem('gdl_api_base_url') || '',
  connected: false,
};

function updateLaptopBadge(status, details = '') {
  if (!els.laptopStatusBadge) return;
  if (status === 'connected') {
    els.laptopStatusBadge.className = 'badge badge-success';
    els.laptopStatusBadge.textContent = '● Laptop Online';
    els.laptopStatusBadge.title = `Connected to ${state.apiBaseUrl || 'local server'}`;
  } else if (status === 'connecting') {
    els.laptopStatusBadge.className = 'badge badge-warn';
    els.laptopStatusBadge.textContent = details ? `● ${details}` : '● Connecting...';
    els.laptopStatusBadge.title = 'Searching for laptop backend...';
  } else {
    els.laptopStatusBadge.className = 'badge badge-warn';
    els.laptopStatusBadge.textContent = '⚠️ Laptop Offline · Tap to Retry';
    els.laptopStatusBadge.title = 'Click to force search for your laptop backend';
  }
}

async function probeBackendUrl(baseUrl, timeoutMs = 3500) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${baseUrl}/api/status`, {
      signal: controller.signal,
      mode: 'cors',
      cache: 'no-store',
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      if (data?.garmin) {
        return true;
      }
    }
  } catch {
    // Probe failed
  }
  return false;
}

async function discoverLiveBackendUrl(forceProbe = false) {
  if (!forceProbe && state.connected && state.apiBaseUrl) {
    return state.apiBaseUrl;
  }

  // 1. If running on localhost or same host, probe local origin
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    if (await probeBackendUrl('', 2000)) {
      state.apiBaseUrl = '';
      state.connected = true;
      updateLaptopBadge('connected');
      return '';
    }
  }

  // 2. Fetch the Gist beacon (try API first, then raw URL)
  const candidateUrls = [];
  try {
    const res = await fetch(`${BEACON_GIST_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (res.ok) {
      const gist = await res.json();
      const content = gist?.files?.['garmin-dish-logger-beacon.json']?.content;
      if (content) {
        const parsed = JSON.parse(content);
        if (parsed?.tunnelUrl && !String(parsed.tunnelUrl).includes('api.trycloudflare.com')) {
          candidateUrls.push(String(parsed.tunnelUrl).replace(/\/+$/, ''));
        }
        if (Array.isArray(parsed?.lanUrls)) {
          for (const u of parsed.lanUrls) {
            candidateUrls.push(String(u).replace(/\/+$/, ''));
          }
        }
      }
    }
  } catch {
    // Fall through to raw URL
  }

  if (candidateUrls.length === 0) {
    try {
      const rawRes = await fetch(`${BEACON_RAW_URL}?t=${Date.now()}`, { cache: 'no-store' });
      if (rawRes.ok) {
        const parsed = await rawRes.json();
        if (parsed?.tunnelUrl && !String(parsed.tunnelUrl).includes('api.trycloudflare.com')) {
          candidateUrls.push(String(parsed.tunnelUrl).replace(/\/+$/, ''));
        }
        if (Array.isArray(parsed?.lanUrls)) {
          for (const u of parsed.lanUrls) {
            candidateUrls.push(String(u).replace(/\/+$/, ''));
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  // Also include previously stored URL as fallback candidate
  const stored = localStorage.getItem('gdl_api_base_url');
  if (stored && !candidateUrls.includes(stored)) {
    candidateUrls.push(stored);
  }

  // Probe candidates to find the one that is actually responding
  for (const candidate of candidateUrls) {
    // Don't mix HTTP LAN into HTTPS GitHub Pages (browser mixed content block)
    if (window.location.protocol === 'https:' && candidate.startsWith('http://')) {
      continue;
    }
    if (await probeBackendUrl(candidate, 3500)) {
      state.apiBaseUrl = candidate;
      state.tunnelUrl = candidate;
      state.connected = true;
      localStorage.setItem('gdl_api_base_url', candidate);
      updateLaptopBadge('connected');
      return candidate;
    }
  }

  state.connected = false;
  return null;
}

let connectionPromise = null;
async function initBackendConnection(maxRetries = 4) {
  if (connectionPromise) return connectionPromise;

  connectionPromise = (async () => {
    updateLaptopBadge('connecting', 'Connecting...');
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const url = await discoverLiveBackendUrl(true);
      if (url !== null) {
        return url;
      }
      if (attempt < maxRetries) {
        updateLaptopBadge('connecting', `Retrying (${attempt}/${maxRetries})...`);
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
    updateLaptopBadge('offline');
    return null;
  })();

  const result = await connectionPromise;
  connectionPromise = null;
  if (result !== null) {
    void flushOfflineGarminQueue();
  }
  return result;
}

async function apiFetch(path, options = {}) {
  if (!state.connected || !state.apiBaseUrl) {
    await initBackendConnection(1);
  }

  const base = state.apiBaseUrl || '';
  const url = `${base}${path}`;

  try {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs || 10000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      ...(base ? { mode: 'cors' } : {}),
    });
    clearTimeout(timer);

    if (res.status < 500 && res.status !== 404) {
      updateLaptopBadge('connected');
      return res;
    }
    throw new Error(`Server returned HTTP ${res.status}`);
  } catch (firstErr) {
    console.warn(`apiFetch to ${url} failed (${firstErr.message}), rediscovering backend...`);
    const newBase = await initBackendConnection(2);
    if (newBase !== null) {
      const retryUrl = `${newBase}${path}`;
      const retryRes = await fetch(retryUrl, {
        ...options,
        ...(newBase ? { mode: 'cors' } : {}),
      });
      if (retryRes.status < 500) {
        updateLaptopBadge('connected');
        return retryRes;
      }
    }
    updateLaptopBadge('offline');
    throw new Error('Could not reach Garmin Dish Logger server on your laptop. Tap "Laptop Offline" above to reconnect.');
  }
}

function getLocalTodayString() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shiftDateString(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  const ny = dt.getFullYear();
  const nm = String(dt.getMonth() + 1).padStart(2, '0');
  const nd = String(dt.getDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

// DOM Elements
const els = {
  laptopStatusBadge: document.getElementById('laptopStatusBadge'),
  garminStatusBadge: document.getElementById('garminStatusBadge'),
  geminiStatusBadge: document.getElementById('geminiStatusBadge'),
  apiKeyBanner: document.getElementById('apiKeyBanner'),
  bannerOpenSettingsBtn: document.getElementById('bannerOpenSettingsBtn'),
  openQrBtn: document.getElementById('openQrBtn'),
  openSettingsBtn: document.getElementById('openSettingsBtn'),

  cameraInput: document.getElementById('cameraInput'),
  galleryInput: document.getElementById('galleryInput'),
  dropZone: document.getElementById('dropZone'),
  captureButtonsView: document.getElementById('captureButtonsView'),
  snapCameraBtn: document.getElementById('snapCameraBtn'),
  pickGalleryBtn: document.getElementById('pickGalleryBtn'),
  photoPreviewContainer: document.getElementById('photoPreviewContainer'),
  photoPreviewImg: document.getElementById('photoPreviewImg'),
  photoSizeBadge: document.getElementById('photoSizeBadge'),
  clearPhotoBtn: document.getElementById('clearPhotoBtn'),

  userNotesInput: document.getElementById('userNotesInput'),
  voiceNoteBtn: document.getElementById('voiceNoteBtn'),
  analyzeBtn: document.getElementById('analyzeBtn'),
  analyzeBtnIcon: document.getElementById('analyzeBtnIcon'),
  analyzeBtnText: document.getElementById('analyzeBtnText'),

  previewCard: document.getElementById('previewCard'),
  previewDescription: document.getElementById('previewDescription'),
  confidenceBadge: document.getElementById('confidenceBadge'),
  healthTipBox: document.getElementById('healthTipBox'),
  healthTipText: document.getElementById('healthTipText'),
  dishNameInput: document.getElementById('dishNameInput'),
  mealSelector: document.getElementById('mealSelector'),
  portionSlider: document.getElementById('portionSlider'),
  portionMultiplierLabel: document.getElementById('portionMultiplierLabel'),
  totalWeightLabel: document.getElementById('totalWeightLabel'),

  totalCaloriesInput: document.getElementById('totalCaloriesInput'),
  totalProteinInput: document.getElementById('totalProteinInput'),
  totalCarbsInput: document.getElementById('totalCarbsInput'),
  totalFatInput: document.getElementById('totalFatInput'),
  ingredientsTableBody: document.getElementById('ingredientsTableBody'),
  addIngredientBtn: document.getElementById('addIngredientBtn'),
  refineInput: document.getElementById('refineInput'),
  refineBtn: document.getElementById('refineBtn'),
  saveCustomFoodCheckbox: document.getElementById('saveCustomFoodCheckbox'),
  cancelPreviewBtn: document.getElementById('cancelPreviewBtn'),
  logToGarminBtn: document.getElementById('logToGarminBtn'),

  prevDateBtn: document.getElementById('prevDateBtn'),
  selectedDateInput: document.getElementById('selectedDateInput'),
  nextDateBtn: document.getElementById('nextDateBtn'),
  todayDateBtn: document.getElementById('todayDateBtn'),
  refreshGarminBtn: document.getElementById('refreshGarminBtn'),

  calorieRingCircle: document.getElementById('calorieRingCircle'),
  ringConsumedVal: document.getElementById('ringConsumedVal'),
  ringGoalVal: document.getElementById('ringGoalVal'),
  ringRemainingBadge: document.getElementById('ringRemainingBadge'),
  proConsumedVal: document.getElementById('proConsumedVal'),
  proGoalVal: document.getElementById('proGoalVal'),
  proProgressBar: document.getElementById('proProgressBar'),
  carbConsumedVal: document.getElementById('carbConsumedVal'),
  carbGoalVal: document.getElementById('carbGoalVal'),
  carbProgressBar: document.getElementById('carbProgressBar'),
  fatConsumedVal: document.getElementById('fatConsumedVal'),
  fatGoalVal: document.getElementById('fatGoalVal'),
  fatProgressBar: document.getElementById('fatProgressBar'),
  activeBurnVal: document.getElementById('activeBurnVal'),
  stepsVal: document.getElementById('stepsVal'),
  totalBurnVal: document.getElementById('totalBurnVal'),

  foodLogDateLabel: document.getElementById('foodLogDateLabel'),
  foodLogCountBadge: document.getElementById('foodLogCountBadge'),
  garminFoodLogList: document.getElementById('garminFoodLogList'),
  recentHistoryList: document.getElementById('recentHistoryList'),

  toastContainer: document.getElementById('toastContainer'),

  settingsModal: document.getElementById('settingsModal'),
  closeSettingsBtn: document.getElementById('closeSettingsBtn'),
  geminiKeyInput: document.getElementById('geminiKeyInput'),
  currentKeyHint: document.getElementById('currentKeyHint'),
  geminiModelSelect: document.getElementById('geminiModelSelect'),
  keyTestResultBox: document.getElementById('keyTestResultBox'),
  testKeyBtn: document.getElementById('testKeyBtn'),
  saveSettingsBtn: document.getElementById('saveSettingsBtn'),

  qrModal: document.getElementById('qrModal'),
  closeQrBtn: document.getElementById('closeQrBtn'),
  qrSvgContainer: document.getElementById('qrSvgContainer'),
  qrPrimaryUrl: document.getElementById('qrPrimaryUrl'),
  openTunnelUrlBtn: document.getElementById('openTunnelUrlBtn'),
  lanUrlLabel: document.getElementById('lanUrlLabel'),
  installPwaBtn: document.getElementById('installPwaBtn'),
  androidInstallBanner: document.getElementById('androidInstallBanner'),
  bannerInstallBtn: document.getElementById('bannerInstallBtn'),
  dismissInstallBannerBtn: document.getElementById('dismissInstallBannerBtn'),
  nativeInstallReadyBox: document.getElementById('nativeInstallReadyBox'),
  modalNativeInstallBtn: document.getElementById('modalNativeInstallBtn'),
  copyAppUrlBtn: document.getElementById('copyAppUrlBtn'),
  copyFlagUrlBtn: document.getElementById('copyFlagUrlBtn'),
  flagOriginValue: document.getElementById('flagOriginValue'),
  httpsInstallLink: document.getElementById('httpsInstallLink'),
};

// Toast Notifications
function showToast(message, options = {}) {
  const toast = document.createElement('div');
  toast.className = `toast ${options.isError ? 'toast-error' : ''}`;

  const span = document.createElement('span');
  span.textContent = message;
  toast.appendChild(span);

  if (options.undoAction) {
    const undoBtn = document.createElement('button');
    undoBtn.className = 'btn btn-xs btn-outline';
    undoBtn.textContent = 'Undo';
    undoBtn.addEventListener('click', async () => {
      toast.remove();
      await options.undoAction();
    });
    toast.appendChild(undoBtn);
  }

  els.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, options.duration || 6500);
}

// Client-side image compression
function compressImageFile(file, maxDim = 1280, quality = 0.84) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);

        // Also generate a small thumbnail for history
        const thumbCanvas = document.createElement('canvas');
        const thumbW = 160;
        const thumbH = Math.round((height * thumbW) / width);
        thumbCanvas.width = thumbW;
        thumbCanvas.height = thumbH;
        thumbCanvas.getContext('2d').drawImage(img, 0, 0, thumbW, thumbH);
        const thumbDataUrl = thumbCanvas.toDataURL('image/jpeg', 0.7);

        resolve({
          dataUrl,
          thumbDataUrl,
          mimeType: 'image/jpeg',
          width,
          height,
        });
      };
      img.onerror = () => reject(new Error('Could not decode image file'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

async function handleImageSelected(file) {
  if (!file || !file.type.startsWith('image/')) {
    showToast('Please select a valid image file.', { isError: true });
    return;
  }
  try {
    const compressed = await compressImageFile(file);
    state.imageBase64 = compressed.dataUrl;
    state.imageMimeType = compressed.mimeType;
    state.thumbnailDataUrl = compressed.thumbDataUrl;

    els.photoPreviewImg.src = compressed.dataUrl;
    const kb = Math.round((compressed.dataUrl.length * 0.75) / 1024);
    els.photoSizeBadge.textContent = `✓ Optimized (${compressed.width}×${compressed.height} · ${kb} KB)`;
    els.captureButtonsView.classList.add('hidden');
    els.photoPreviewContainer.classList.remove('hidden');
  } catch (err) {
    showToast(err.message || 'Failed to load photo', { isError: true });
  }
}

function clearSelectedPhoto() {
  state.imageBase64 = null;
  state.imageMimeType = null;
  state.thumbnailDataUrl = null;
  els.cameraInput.value = '';
  els.galleryInput.value = '';
  els.photoPreviewImg.src = '';
  els.photoPreviewContainer.classList.add('hidden');
  els.captureButtonsView.classList.remove('hidden');
}

// Fetch App Status (Garmin + Gemini + QR)
async function fetchAppStatus() {
  try {
    const res = await apiFetch('/api/status');
    const data = await res.json();

    if (data.garmin?.connected) {
      els.garminStatusBadge.className = 'badge badge-success';
      els.garminStatusBadge.textContent = `● Garmin Connected · ${data.garmin.displayName}`;
    } else {
      els.garminStatusBadge.className = 'badge badge-warn';
      els.garminStatusBadge.textContent = '⚠️ Garmin Disconnected';
    }

    state.geminiConfigured = Boolean(data.gemini?.configured);
    if (data.gemini?.clientKey) {
      localStorage.setItem('gdl_gemini_key', data.gemini.clientKey);
    }
    if (data.gemini?.model) {
      localStorage.setItem('gdl_gemini_model', data.gemini.model);
    }
    if (state.geminiConfigured) {
      els.geminiStatusBadge.className = 'badge badge-success';
      els.geminiStatusBadge.textContent = `● ${data.gemini.model}`;
      els.apiKeyBanner.classList.add('hidden');
      els.currentKeyHint.textContent = `Active key: ${data.gemini.maskedKey}`;
    } else {
      els.geminiStatusBadge.className = 'badge badge-warn';
      els.geminiStatusBadge.textContent = '🔑 Set Gemini Key';
      els.apiKeyBanner.classList.remove('hidden');
      els.currentKeyHint.textContent = 'No API key saved yet.';
    }

    if (data.gemini?.model) {
      els.geminiModelSelect.value = data.gemini.model;
    }

    if (data.network?.qrSvg) {
      els.qrSvgContainer.innerHTML = data.network.qrSvg;
    }
    if (data.network?.tunnelUrl) {
      state.tunnelUrl = data.network.tunnelUrl;
      state.apiBaseUrl = data.network.tunnelUrl;
      localStorage.setItem('gdl_api_base_url', data.network.tunnelUrl);
    } else {
      // Tunnel takes ~3-5s on startup; re-check once if not yet populated
      setTimeout(async () => {
        try {
          const r2 = await apiFetch('/api/status');
          const d2 = await r2.json();
          if (d2.network?.tunnelUrl) {
            state.tunnelUrl = d2.network.tunnelUrl;
            state.apiBaseUrl = d2.network.tunnelUrl;
            localStorage.setItem('gdl_api_base_url', d2.network.tunnelUrl);
            els.qrPrimaryUrl.textContent = d2.network.tunnelUrl;
            if (d2.network.qrSvg) els.qrSvgContainer.innerHTML = d2.network.qrSvg;
            if (els.openTunnelUrlBtn) els.openTunnelUrlBtn.href = d2.network.tunnelUrl;
          }
        } catch {
          // Ignore
        }
      }, 4500);
    }

    if (data.network?.primaryUrl) {
      state.primaryHttpUrl = data.network.lanHttpUrl || data.network.primaryUrl;
      els.qrPrimaryUrl.textContent = data.network.primaryUrl;
      if (els.openTunnelUrlBtn) {
        els.openTunnelUrlBtn.href = data.network.primaryUrl;
      }
      if (els.lanUrlLabel) {
        els.lanUrlLabel.textContent = data.network.lanHttpUrl || data.network.primaryUrl;
      }
    }
    const httpsUrl = data.network?.httpsUrl || data.network?.primaryHttpsUrl;
    if (httpsUrl) {
      state.primaryHttpsUrl = httpsUrl;
      if (els.httpsInstallLink) {
        els.httpsInstallLink.href = httpsUrl;
        els.httpsInstallLink.textContent = `🔒 Open Secure HTTPS App (${httpsUrl})`;
      }
    }
  } catch (err) {
    console.error('Status check failed:', err);
  }
}

// Fetch Live Garmin Nutrition for Selected Date
async function fetchGarminNutrition(dateStr = state.selectedDate) {
  els.refreshGarminBtn.disabled = true;
  try {
    const res = await apiFetch(`/api/nutrition?date=${encodeURIComponent(dateStr)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to fetch Garmin nutrition');
    state.garminOverview = data;
    renderGarminDashboard(data);
  } catch (err) {
    showToast(`Garmin sync error: ${err.message}`, { isError: true });
  } finally {
    els.refreshGarminBtn.disabled = false;
  }
}

function renderGarminDashboard(overview) {
  if (!overview) return;

  const isToday = overview.date === getLocalTodayString();
  els.foodLogDateLabel.textContent = isToday ? 'Today' : overview.date;

  const consumedCal = Math.round(overview.consumed.calories || 0);
  const goalCal = Math.round(overview.goals.adjustedCalories || overview.goals.calories || 1950);
  const remainingCal = goalCal - consumedCal;

  els.ringConsumedVal.textContent = String(consumedCal);
  els.ringGoalVal.textContent = String(goalCal);

  if (remainingCal >= 0) {
    els.ringRemainingBadge.textContent = `${remainingCal} kcal left`;
    els.ringRemainingBadge.style.color = '#34d399';
  } else {
    els.ringRemainingBadge.textContent = `${Math.abs(remainingCal)} kcal over`;
    els.ringRemainingBadge.style.color = '#fbbf24';
  }

  const circumference = 2 * Math.PI * 58; // ~364.4
  const ratio = Math.min(1, Math.max(0, goalCal > 0 ? consumedCal / goalCal : 0));
  const dashOffset = circumference * (1 - ratio);
  els.calorieRingCircle.style.strokeDashoffset = String(dashOffset);

  // Macros
  const proC = Math.round(overview.consumed.protein || 0);
  const proG = Math.round(overview.goals.adjustedProtein || overview.goals.protein || 140);
  els.proConsumedVal.textContent = String(proC);
  els.proGoalVal.textContent = String(proG);
  els.proProgressBar.style.width = `${Math.min(100, proG > 0 ? (proC / proG) * 100 : 0)}%`;

  const carbC = Math.round(overview.consumed.carbs || 0);
  const carbG = Math.round(overview.goals.adjustedCarbs || overview.goals.carbs || 210);
  els.carbConsumedVal.textContent = String(carbC);
  els.carbGoalVal.textContent = String(carbG);
  els.carbProgressBar.style.width = `${Math.min(100, carbG > 0 ? (carbC / carbG) * 100 : 0)}%`;

  const fatC = Math.round(overview.consumed.fat || 0);
  const fatG = Math.round(overview.goals.adjustedFat || overview.goals.fat || 61);
  els.fatConsumedVal.textContent = String(fatC);
  els.fatGoalVal.textContent = String(fatG);
  els.fatProgressBar.style.width = `${Math.min(100, fatG > 0 ? (fatC / fatG) * 100 : 0)}%`;

  // Activity burn
  els.activeBurnVal.textContent =
    overview.activity?.activeCalories != null ? String(Math.round(overview.activity.activeCalories)) : '—';
  els.stepsVal.textContent =
    overview.activity?.steps != null ? overview.activity.steps.toLocaleString() : '—';
  els.totalBurnVal.textContent =
    overview.activity?.totalBurnedCalories != null
      ? String(Math.round(overview.activity.totalBurnedCalories))
      : '—';

  // Render Logged Foods list
  const items = overview.loggedFoods || [];
  els.foodLogCountBadge.textContent = `${items.length} ${items.length === 1 ? 'item' : 'items'}`;

  if (items.length === 0) {
    els.garminFoodLogList.innerHTML = `<div class="empty-state">No meals logged in Garmin Connect for ${overview.date} yet.</div>`;
    return;
  }

  const mealIcons = {
    BREAKFAST: '🌅 Breakfast',
    LUNCH: '☀️ Lunch',
    DINNER: '🌙 Dinner',
    SNACKS: '🍎 Snacks',
  };

  const grouped = {};
  for (const item of items) {
    if (!grouped[item.mealName]) grouped[item.mealName] = [];
    grouped[item.mealName].push(item);
  }

  els.garminFoodLogList.innerHTML = '';
  for (const mealKey of ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACKS']) {
    const groupItems = grouped[mealKey];
    if (!groupItems || groupItems.length === 0) continue;

    const mealTotalCal = groupItems.reduce((s, i) => s + i.calories, 0);
    const header = document.createElement('div');
    header.className = 'meal-group-header';
    header.innerHTML = `<span>${mealIcons[mealKey] || mealKey}</span><span>${mealTotalCal} kcal</span>`;
    els.garminFoodLogList.appendChild(header);

    for (const food of groupItems) {
      const row = document.createElement('div');
      row.className = 'food-log-item';
      row.innerHTML = `
        <div class="food-item-main">
          <span class="food-item-title">${escapeHtml(food.name)}</span>
          <span class="food-item-sub">P: ${food.protein}g · C: ${food.carbs}g · F: ${food.fat}g ${food.mealTime ? `· ${food.mealTime.slice(0, 5)}` : ''}</span>
        </div>
        <div class="food-item-right">
          <span class="food-item-kcal">${food.calories} kcal</span>
          <button type="button" class="icon-btn-sm delete-log-btn" title="Delete from Garmin Connect">🗑️</button>
        </div>
      `;
      row.querySelector('.delete-log-btn').addEventListener('click', () => {
        deleteGarminFoodEntry(overview.date, food.logId, food.name);
      });
      els.garminFoodLogList.appendChild(row);
    }
  }
}

async function deleteGarminFoodEntry(dateStr, logId, foodName) {
  try {
    const res = await apiFetch(
      `/api/garmin/log/${encodeURIComponent(dateStr)}/${encodeURIComponent(logId)}`,
      { method: 'DELETE' },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete entry');
    state.garminOverview = data.overview;
    renderGarminDashboard(data.overview);
    showToast(`Removed "${foodName}" from Garmin Connect.`);
  } catch (err) {
    showToast(`Delete failed: ${err.message}`, { isError: true });
  }
}

async function analyzeDirectlyOnPhoneWithGemini(userNotes) {
  const apiKey = localStorage.getItem('gdl_gemini_key');
  const model = localStorage.getItem('gdl_gemini_model') || 'gemini-3.8-flash';
  if (!apiKey) {
    throw new Error('Could not reach laptop server and no cached Gemini key on phone.');
  }

  const parts = [];
  if (state.imageBase64) {
    const cleanBase64 = state.imageBase64.replace(/^data:[^;]+;base64,/, '');
    parts.push({
      inlineData: {
        mimeType: state.imageMimeType || 'image/jpeg',
        data: cleanBase64,
      },
    });
  }
  const hour = new Date().getHours();
  const defaultMeal = hour < 11 ? 'BREAKFAST' : hour < 15 ? 'LUNCH' : hour < 18 ? 'SNACKS' : 'DINNER';
  parts.push({
    text: `Analyze this dish photo and notes ("${userNotes || 'none'}"). Return strict JSON with keys: dishName (string), description (string), confidence ("high"|"medium"|"low"), suggestedMeal ("${defaultMeal}"), totalGrams (number), calories (number), protein (number), carbs (number), fat (number), fiber (number), healthTip (string), ingredients (array of {name, grams, calories, protein, carbs, fat, fiber}).`,
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || 'Direct Gemini API call failed');
  }
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  const parsed = JSON.parse(rawText);
  parsed.ingredients = (parsed.ingredients || []).map((ing, i) => ({
    ...ing,
    id: `ing-direct-${i + 1}`,
    included: true,
  }));
  return parsed;
}

// Analyze Dish Photo / Notes
async function runDishAnalysis(options = {}) {
  const isDemo = Boolean(options.demo);
  const userNotes = els.userNotesInput.value.trim();

  if (!isDemo && !state.imageBase64 && !userNotes) {
    showToast('Please snap/select a dish photo or enter a meal description first.', {
      isError: true,
    });
    return;
  }

  els.analyzeBtn.disabled = true;
  els.analyzeBtnIcon.textContent = '⏳';
  els.analyzeBtnText.textContent = isDemo
    ? 'Loading Sample Dish...'
    : 'Gemini is analyzing dish & computing macros...';

  try {
    let data;
    try {
      const res = await apiFetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: state.imageBase64,
          mimeType: state.imageMimeType,
          userNotes,
          demo: isDemo,
          demoPreset: options.demoPreset ?? 0,
        }),
      });
      data = await res.json();
      if (!res.ok) {
        if (String(data.error || '').includes('GEMINI_API_KEY_MISSING')) {
          els.settingsModal.classList.remove('hidden');
        }
        throw new Error(data.error || 'Analysis failed');
      }
    } catch (serverErr) {
      if (!isDemo && localStorage.getItem('gdl_gemini_key')) {
        data = await analyzeDirectlyOnPhoneWithGemini(userNotes);
        showToast('Analyzed directly via Gemini on your phone!');
      } else {
        throw serverErr;
      }
    }

    loadAnalysisIntoPreview(data);
  } catch (err) {
    showToast(err.message, { isError: true });
  } finally {
    els.analyzeBtn.disabled = false;
    els.analyzeBtnIcon.textContent = '✨';
    els.analyzeBtnText.textContent = 'Compute Calories & Macros with Gemini';
  }
}

function loadAnalysisIntoPreview(analysis) {
  state.currentAnalysis = JSON.parse(JSON.stringify(analysis));
  state.baseIngredients = JSON.parse(JSON.stringify(analysis.ingredients || []));
  state.portionMultiplier = 1.0;

  els.portionSlider.value = '1';
  updatePortionButtonsUI(1.0);

  els.dishNameInput.value = analysis.dishName || 'Logged Dish';
  els.previewDescription.textContent = analysis.description || '';

  const conf = analysis.confidence || 'high';
  els.confidenceBadge.textContent = analysis.isDemo
    ? 'Sample Dish Preview'
    : `${conf.charAt(0).toUpperCase() + conf.slice(1)} Confidence`;

  if (analysis.healthTip) {
    els.healthTipText.textContent = analysis.healthTip;
    els.healthTipBox.classList.remove('hidden');
  } else {
    els.healthTipBox.classList.add('hidden');
  }

  setMealSelection(analysis.suggestedMeal || 'LUNCH');
  renderIngredientsTable();
  recalculateTotalsFromIngredients();

  els.previewCard.classList.remove('hidden');
  els.previewCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setMealSelection(mealName) {
  state.selectedMeal = mealName;
  for (const btn of els.mealSelector.querySelectorAll('.meal-pill')) {
    btn.classList.toggle('active', btn.dataset.meal === mealName);
  }
}

function updatePortionButtonsUI(mult) {
  els.portionMultiplierLabel.textContent = `${Number(mult).toFixed(2)}×`;
  for (const btn of document.querySelectorAll('.portion-btn')) {
    btn.classList.toggle('active', Math.abs(Number(btn.dataset.mult) - mult) < 0.01);
  }
}

function applyPortionMultiplier(mult) {
  state.portionMultiplier = mult;
  els.portionSlider.value = String(mult);
  updatePortionButtonsUI(mult);

  state.currentAnalysis.ingredients = state.baseIngredients.map((baseIng, idx) => {
    const currentIng = state.currentAnalysis.ingredients[idx] || baseIng;
    return {
      ...baseIng,
      included: currentIng.included,
      grams: Math.max(1, Math.round(baseIng.grams * mult)),
      calories: Math.round(baseIng.calories * mult),
      protein: Math.round(baseIng.protein * mult * 10) / 10,
      carbs: Math.round(baseIng.carbs * mult * 10) / 10,
      fat: Math.round(baseIng.fat * mult * 10) / 10,
      fiber: Math.round((baseIng.fiber || 0) * mult * 10) / 10,
    };
  });

  renderIngredientsTable();
  recalculateTotalsFromIngredients();
}

function renderIngredientsTable() {
  els.ingredientsTableBody.innerHTML = '';
  const ingredients = state.currentAnalysis?.ingredients || [];

  ingredients.forEach((ing, idx) => {
    const tr = document.createElement('tr');
    if (!ing.included) tr.className = 'ing-row-excluded';

    tr.innerHTML = `
      <td>
        <input type="checkbox" class="ing-check" ${ing.included ? 'checked' : ''} />
      </td>
      <td>
        <input type="text" class="ing-name-input" value="${escapeHtml(ing.name)}" />
      </td>
      <td>
        <input type="number" class="ing-gram-input" min="1" step="5" value="${Math.round(ing.grams)}" />
      </td>
      <td>
        <strong class="ing-cal-cell">${Math.round(ing.calories)}</strong>
      </td>
      <td>
        <span class="ing-macros-pill">${Math.round(ing.protein)}P · ${Math.round(ing.carbs)}C · ${Math.round(ing.fat)}F</span>
      </td>
      <td>
        <button type="button" class="icon-btn-sm ing-del-btn" title="Remove">×</button>
      </td>
    `;

    const checkEl = tr.querySelector('.ing-check');
    const nameEl = tr.querySelector('.ing-name-input');
    const gramEl = tr.querySelector('.ing-gram-input');
    const calCell = tr.querySelector('.ing-cal-cell');
    const macrosPill = tr.querySelector('.ing-macros-pill');
    const delBtn = tr.querySelector('.ing-del-btn');

    checkEl.addEventListener('change', () => {
      ing.included = checkEl.checked;
      tr.classList.toggle('ing-row-excluded', !ing.included);
      recalculateTotalsFromIngredients();
    });

    nameEl.addEventListener('input', () => {
      ing.name = nameEl.value;
      if (state.baseIngredients[idx]) state.baseIngredients[idx].name = nameEl.value;
    });

    gramEl.addEventListener('input', () => {
      const newGrams = Math.max(1, Number(gramEl.value) || 1);
      const oldGrams = Math.max(1, ing.grams || 1);
      const ratio = newGrams / oldGrams;
      ing.grams = newGrams;
      ing.calories = Math.round(ing.calories * ratio);
      ing.protein = Math.round(ing.protein * ratio * 10) / 10;
      ing.carbs = Math.round(ing.carbs * ratio * 10) / 10;
      ing.fat = Math.round(ing.fat * ratio * 10) / 10;
      ing.fiber = Math.round((ing.fiber || 0) * ratio * 10) / 10;

      calCell.textContent = String(Math.round(ing.calories));
      macrosPill.textContent = `${Math.round(ing.protein)}P · ${Math.round(ing.carbs)}C · ${Math.round(ing.fat)}F`;
      recalculateTotalsFromIngredients();
    });

    delBtn.addEventListener('click', () => {
      state.currentAnalysis.ingredients.splice(idx, 1);
      state.baseIngredients.splice(idx, 1);
      renderIngredientsTable();
      recalculateTotalsFromIngredients();
    });

    els.ingredientsTableBody.appendChild(tr);
  });
}

function recalculateTotalsFromIngredients() {
  if (!state.currentAnalysis) return;
  const active = (state.currentAnalysis.ingredients || []).filter((i) => i.included);
  const totalGrams = Math.round(active.reduce((s, i) => s + (Number(i.grams) || 0), 0));
  const calories = Math.round(active.reduce((s, i) => s + (Number(i.calories) || 0), 0));
  const protein = Math.round(active.reduce((s, i) => s + (Number(i.protein) || 0), 0));
  const carbs = Math.round(active.reduce((s, i) => s + (Number(i.carbs) || 0), 0));
  const fat = Math.round(active.reduce((s, i) => s + (Number(i.fat) || 0), 0));
  const fiber = Math.round(active.reduce((s, i) => s + (Number(i.fiber) || 0), 0));

  state.currentAnalysis.totalGrams = totalGrams;
  state.currentAnalysis.calories = calories;
  state.currentAnalysis.protein = protein;
  state.currentAnalysis.carbs = carbs;
  state.currentAnalysis.fat = fat;
  state.currentAnalysis.fiber = fiber;

  els.totalWeightLabel.textContent = `(${totalGrams} g total)`;
  els.totalCaloriesInput.value = String(calories);
  els.totalProteinInput.value = String(protein);
  els.totalCarbsInput.value = String(carbs);
  els.totalFatInput.value = String(fat);
}

// Log Confirmed Dish to Garmin Connect
async function logCurrentDishToGarmin() {
  if (!state.currentAnalysis) return;

  const dishName = els.dishNameInput.value.trim() || 'Logged Dish';
  const calories = Math.max(0, Math.round(Number(els.totalCaloriesInput.value) || 0));
  const protein = Math.max(0, Math.round(Number(els.totalProteinInput.value) || 0));
  const carbs = Math.max(0, Math.round(Number(els.totalCarbsInput.value) || 0));
  const fat = Math.max(0, Math.round(Number(els.totalFatInput.value) || 0));

  els.logToGarminBtn.disabled = true;
  const originalText = els.logToGarminBtn.innerHTML;
  els.logToGarminBtn.innerHTML = '<span>⏳ Pushing to Garmin Connect...</span>';

  try {
    const res = await apiFetch('/api/garmin/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: dishName,
        calories,
        protein,
        carbs,
        fat,
        fiber: state.currentAnalysis.fiber || 0,
        totalGrams: state.currentAnalysis.totalGrams || 350,
        meal: state.selectedMeal,
        date: state.selectedDate,
        saveCustomFood: els.saveCustomFoodCheckbox.checked,
        ingredients: state.currentAnalysis.ingredients,
        thumbnailDataUrl: state.thumbnailDataUrl,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to log to Garmin Connect');

    state.garminOverview = data.overview;
    renderGarminDashboard(data.overview);
    await fetchRecentHistory();

    els.previewCard.classList.add('hidden');
    clearSelectedPhoto();
    els.userNotesInput.value = '';

    showToast(
      `✓ Logged "${dishName}" (${calories} kcal · ${protein}g P, ${carbs}g C, ${fat}g F) to Garmin Connect (${data.mealName})!`,
      {
        undoAction: data.logId
          ? async () => {
              await deleteGarminFoodEntry(state.selectedDate, data.logId, dishName);
            }
          : null,
      },
    );
  } catch (err) {
    const isOffline = !state.connected || String(err.message).includes('laptop') || String(err.message).includes('reach');
    if (isOffline) {
      const queuedMeal = {
        id: `offline-${Date.now()}`,
        name: dishName,
        calories,
        protein,
        carbs,
        fat,
        fiber: state.currentAnalysis.fiber || 0,
        totalGrams: state.currentAnalysis.totalGrams || 350,
        meal: state.selectedMeal,
        date: state.selectedDate,
        saveCustomFood: els.saveCustomFoodCheckbox.checked,
        ingredients: state.currentAnalysis.ingredients,
        thumbnailDataUrl: state.thumbnailDataUrl,
        queuedAt: new Date().toISOString(),
      };
      saveToOfflineQueue(queuedMeal);
      els.previewCard.classList.add('hidden');
      clearSelectedPhoto();
      els.userNotesInput.value = '';
      showToast(`⏳ Saved offline (${dishName})! Will sync to Garmin Connect automatically when your laptop is online.`);
      renderRecentHistory();
      return;
    }
    showToast(`Garmin log error: ${err.message}`, { isError: true });
  } finally {
    els.logToGarminBtn.disabled = false;
    els.logToGarminBtn.innerHTML = originalText;
  }
}

function getOfflineQueue() {
  try {
    return JSON.parse(localStorage.getItem('gdl_offline_queue') || '[]');
  } catch {
    return [];
  }
}

function saveToOfflineQueue(item) {
  const queue = getOfflineQueue();
  queue.push(item);
  localStorage.setItem('gdl_offline_queue', JSON.stringify(queue));
}

async function flushOfflineGarminQueue() {
  if (!state.connected || !state.apiBaseUrl) return;
  const queue = getOfflineQueue();
  if (queue.length === 0) return;

  let syncedCount = 0;
  const remaining = [];

  for (const item of queue) {
    try {
      const res = await apiFetch('/api/garmin/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
      });
      if (res.ok) {
        syncedCount++;
      } else {
        remaining.push(item);
      }
    } catch {
      remaining.push(item);
    }
  }

  localStorage.setItem('gdl_offline_queue', JSON.stringify(remaining));

  if (syncedCount > 0) {
    showToast(`✓ Synced ${syncedCount} offline meal(s) to Garmin Connect!`);
    fetchGarminNutrition(state.selectedDate);
    fetchRecentHistory();
  }
}

// Recent Dishes History
async function fetchRecentHistory() {
  try {
    const res = await apiFetch('/api/history');
    const data = await res.json();
    state.historyItems = data.items || [];
    renderRecentHistory();
  } catch {
    // Even if backend history fails, still render offline queued items
    renderRecentHistory();
  }
}

function renderRecentHistory() {
  const offlineQueue = getOfflineQueue();
  const items = state.historyItems;

  if (offlineQueue.length === 0 && (!items || items.length === 0)) {
    els.recentHistoryList.innerHTML =
      '<div class="empty-state">Dishes you log will appear here for 1-tap re-logging.</div>';
    return;
  }

  els.recentHistoryList.innerHTML = '';

  // Render offline queued items first
  for (const q of offlineQueue) {
    const row = document.createElement('div');
    row.className = 'history-item';
    row.style.borderColor = 'rgba(251, 191, 36, 0.4)';
    row.innerHTML = `
      <div class="food-item-main">
        <span class="food-item-title">${escapeHtml(q.name)} <span class="badge badge-warn" style="font-size:0.65rem;">⏳ Queued Offline</span></span>
        <span class="food-item-sub">${q.calories} kcal · P: ${q.protein}g · C: ${q.carbs}g · F: ${q.fat}g · Syncs when laptop connects</span>
      </div>
      <div class="food-item-right">
        <button type="button" class="btn btn-xs btn-outline relog-preview-btn">Preview</button>
      </div>
    `;
    row.querySelector('.relog-preview-btn').addEventListener('click', () => {
      loadAnalysisIntoPreview({
        dishName: q.name,
        description: `Queued offline (${q.date})`,
        confidence: 'high',
        suggestedMeal: q.meal || 'LUNCH',
        totalGrams: q.totalGrams || 350,
        calories: q.calories,
        protein: q.protein,
        carbs: q.carbs,
        fat: q.fat,
        fiber: q.fiber || 0,
        healthTip: '',
        ingredients: q.ingredients || [],
      });
    });
    els.recentHistoryList.appendChild(row);
  }

  for (const item of items.slice(0, 8)) {
    const row = document.createElement('div');
    row.className = 'history-item';
    row.innerHTML = `
      <div class="food-item-main">
        <span class="food-item-title">${escapeHtml(item.dishName)}</span>
        <span class="food-item-sub">${item.calories} kcal · P: ${item.protein}g · C: ${item.carbs}g · F: ${item.fat}g</span>
      </div>
      <div class="food-item-right">
        <button type="button" class="btn btn-xs btn-outline relog-preview-btn">Preview / Log</button>
      </div>
    `;
    row.querySelector('.relog-preview-btn').addEventListener('click', () => {
      loadAnalysisIntoPreview({
        dishName: item.dishName,
        description: `Loaded from recent history (${item.loggedDate})`,
        confidence: 'high',
        suggestedMeal: item.mealName || 'LUNCH',
        totalGrams: item.totalGrams || 350,
        calories: item.calories,
        protein: item.protein,
        carbs: item.carbs,
        fat: item.fat,
        fiber: item.fiber || 0,
        healthTip: '',
        ingredients:
          item.ingredients && item.ingredients.length > 0
            ? item.ingredients
            : [
                {
                  id: 'hist-ing-1',
                  name: item.dishName,
                  grams: item.totalGrams || 350,
                  calories: item.calories,
                  protein: item.protein,
                  carbs: item.carbs,
                  fat: item.fat,
                  fiber: item.fiber || 0,
                  included: true,
                },
              ],
      });
    });
    els.recentHistoryList.appendChild(row);
  }
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Event Listeners Setup
function initEventListeners() {
  // Date Navigation
  els.selectedDateInput.value = state.selectedDate;
  els.selectedDateInput.addEventListener('change', () => {
    if (els.selectedDateInput.value) {
      state.selectedDate = els.selectedDateInput.value;
      fetchGarminNutrition(state.selectedDate);
    }
  });
  els.prevDateBtn.addEventListener('click', () => {
    state.selectedDate = shiftDateString(state.selectedDate, -1);
    els.selectedDateInput.value = state.selectedDate;
    fetchGarminNutrition(state.selectedDate);
  });
  els.nextDateBtn.addEventListener('click', () => {
    state.selectedDate = shiftDateString(state.selectedDate, 1);
    els.selectedDateInput.value = state.selectedDate;
    fetchGarminNutrition(state.selectedDate);
  });
  els.todayDateBtn.addEventListener('click', () => {
    state.selectedDate = getLocalTodayString();
    els.selectedDateInput.value = state.selectedDate;
    fetchGarminNutrition(state.selectedDate);
  });
  els.refreshGarminBtn.addEventListener('click', () => {
    fetchGarminNutrition(state.selectedDate);
  });

  // Camera & Gallery Inputs
  els.snapCameraBtn.addEventListener('click', () => els.cameraInput.click());
  els.pickGalleryBtn.addEventListener('click', () => els.galleryInput.click());
  els.cameraInput.addEventListener('change', (e) => {
    if (e.target.files?.[0]) handleImageSelected(e.target.files[0]);
  });
  els.galleryInput.addEventListener('change', (e) => {
    if (e.target.files?.[0]) handleImageSelected(e.target.files[0]);
  });
  els.clearPhotoBtn.addEventListener('click', clearSelectedPhoto);

  // Drag & Drop + Clipboard Paste
  els.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.dropZone.classList.add('dragover');
  });
  els.dropZone.addEventListener('dragleave', () => {
    els.dropZone.classList.remove('dragover');
  });
  els.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.dropZone.classList.remove('dragover');
    if (e.dataTransfer?.files?.[0]) {
      handleImageSelected(e.dataTransfer.files[0]);
    }
  });
  window.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) handleImageSelected(file);
        break;
      }
    }
  });

  // Quick Context Chips
  for (const chip of document.querySelectorAll('.chip[data-note]')) {
    chip.addEventListener('click', () => {
      const note = chip.dataset.note;
      const cur = els.userNotesInput.value.trim();
      els.userNotesInput.value = cur ? `${cur}, ${note}` : note;
    });
  }

  // Demo Presets
  for (const demoBtn of document.querySelectorAll('.chip-demo')) {
    demoBtn.addEventListener('click', () => {
      runDishAnalysis({ demo: true, demoPreset: Number(demoBtn.dataset.preset || 0) });
    });
  }

  // Voice Note (Web Speech API)
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onstart = () => els.voiceNoteBtn.classList.add('recording');
    recognition.onend = () => els.voiceNoteBtn.classList.remove('recording');
    recognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript || '';
      if (transcript) {
        const cur = els.userNotesInput.value.trim();
        els.userNotesInput.value = cur ? `${cur} ${transcript}` : transcript;
      }
    };
    els.voiceNoteBtn.addEventListener('click', () => {
      try {
        recognition.start();
      } catch {
        recognition.stop();
      }
    });
  } else {
    els.voiceNoteBtn.addEventListener('click', () => {
      showToast('Voice dictation is supported in Chrome on Android/Desktop.', { isError: true });
    });
  }

  // Primary Analyze Button
  els.analyzeBtn.addEventListener('click', () => runDishAnalysis({ demo: false }));

  // Meal Selector Pills
  for (const pill of els.mealSelector.querySelectorAll('.meal-pill')) {
    pill.addEventListener('click', () => setMealSelection(pill.dataset.meal));
  }

  // Portion Slider & Quick Multiplier Buttons
  els.portionSlider.addEventListener('input', () => {
    applyPortionMultiplier(Number(els.portionSlider.value));
  });
  for (const btn of document.querySelectorAll('.portion-btn')) {
    btn.addEventListener('click', () => {
      applyPortionMultiplier(Number(btn.dataset.mult));
    });
  }

  // Add Custom Ingredient Row
  els.addIngredientBtn.addEventListener('click', () => {
    if (!state.currentAnalysis) return;
    const newIng = {
      id: `ing-custom-${Date.now()}`,
      name: 'Olive Oil / Extra Item',
      grams: 10,
      calories: 88,
      protein: 0,
      carbs: 0,
      fat: 10,
      fiber: 0,
      included: true,
    };
    state.currentAnalysis.ingredients.push(newIng);
    state.baseIngredients.push({ ...newIng });
    renderIngredientsTable();
    recalculateTotalsFromIngredients();
  });

  // Refine with Gemini
  els.refineBtn.addEventListener('click', async () => {
    const instruction = els.refineInput.value.trim();
    if (!instruction || !state.currentAnalysis) return;
    els.refineBtn.disabled = true;
    els.refineBtn.textContent = '⏳ Refining...';
    try {
      const res = await apiFetch('/api/refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentAnalysis: state.currentAnalysis,
          instruction,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Refinement failed');
      els.refineInput.value = '';
      loadAnalysisIntoPreview(data);
      showToast('Updated dish breakdown.');
    } catch (err) {
      showToast(err.message, { isError: true });
    } finally {
      els.refineBtn.disabled = false;
      els.refineBtn.textContent = '✨ Refine';
    }
  });

  // Cancel Preview & Log to Garmin
  els.cancelPreviewBtn.addEventListener('click', () => {
    els.previewCard.classList.add('hidden');
  });
  els.logToGarminBtn.addEventListener('click', logCurrentDishToGarmin);

  // Modals: Settings & QR
  const openSettings = () => {
    els.keyTestResultBox.classList.add('hidden');
    els.settingsModal.classList.remove('hidden');
  };
  els.openSettingsBtn.addEventListener('click', openSettings);
  els.geminiStatusBadge.addEventListener('click', openSettings);
  els.bannerOpenSettingsBtn.addEventListener('click', openSettings);
  els.closeSettingsBtn.addEventListener('click', () => els.settingsModal.classList.add('hidden'));

  els.openQrBtn.addEventListener('click', () => els.qrModal.classList.remove('hidden'));
  els.closeQrBtn.addEventListener('click', () => els.qrModal.classList.add('hidden'));

  els.laptopStatusBadge?.addEventListener('click', async () => {
    showToast('Searching for laptop backend...');
    const url = await initBackendConnection(4);
    if (url !== null) {
      showToast('Connected to laptop!');
      fetchAppStatus();
      fetchGarminNutrition(state.selectedDate);
      fetchRecentHistory();
    } else {
      showToast('Could not reach laptop. Make sure it is powered on and awake.', { isError: true });
    }
  });

  // Android / PWA Install Buttons
  if (els.installPwaBtn) {
    els.installPwaBtn.addEventListener('click', () => triggerNativePwaInstall());
  }
  if (els.bannerInstallBtn) {
    els.bannerInstallBtn.addEventListener('click', () => triggerNativePwaInstall());
  }
  if (els.modalNativeInstallBtn) {
    els.modalNativeInstallBtn.addEventListener('click', () => triggerNativePwaInstall());
  }
  if (els.dismissInstallBannerBtn) {
    els.dismissInstallBannerBtn.addEventListener('click', () => {
      els.androidInstallBanner.classList.add('hidden');
      sessionStorage.setItem('pwaBannerDismissed', '1');
    });
  }
  if (els.copyAppUrlBtn) {
    els.copyAppUrlBtn.addEventListener('click', () => {
      copyToClipboard(state.primaryHttpUrl || window.location.origin, 'Copied app origin URL!');
    });
  }
  if (els.copyFlagUrlBtn) {
    els.copyFlagUrlBtn.addEventListener('click', () => {
      copyToClipboard(
        'chrome://flags/#unsafely-treat-insecure-origin-as-secure',
        'Copied Chrome flag URL! Paste it into a new Chrome tab address bar.',
      );
    });
  }

  // Test & Save Gemini API Key
  els.testKeyBtn.addEventListener('click', async () => {
    els.testKeyBtn.disabled = true;
    els.testKeyBtn.textContent = 'Testing...';
    try {
      const res = await apiFetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          geminiApiKey: els.geminiKeyInput.value.trim() || undefined,
          geminiModel: els.geminiModelSelect.value,
          testKey: true,
        }),
      });
      const data = await res.json();
      els.keyTestResultBox.classList.remove('hidden');
      if (data.valid) {
        els.keyTestResultBox.style.background = 'rgba(16, 185, 129, 0.16)';
        els.keyTestResultBox.style.color = '#34d399';
        els.keyTestResultBox.textContent = `✓ Connected to ${data.model} and saved API key!`;
        await fetchAppStatus();
      } else {
        els.keyTestResultBox.style.background = 'rgba(239, 68, 68, 0.18)';
        els.keyTestResultBox.style.color = '#fca5a5';
        els.keyTestResultBox.textContent = `✕ Key test failed: ${data.error}`;
      }
    } catch (err) {
      showToast(err.message, { isError: true });
    } finally {
      els.testKeyBtn.disabled = false;
      els.testKeyBtn.textContent = 'Test API Key';
    }
  });

  els.saveSettingsBtn.addEventListener('click', async () => {
    try {
      const payload = {
        geminiModel: els.geminiModelSelect.value,
      };
      if (els.geminiKeyInput.value.trim()) {
        payload.geminiApiKey = els.geminiKeyInput.value.trim();
      }
      const res = await apiFetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Failed to save settings');
      els.geminiKeyInput.value = '';
      els.settingsModal.classList.add('hidden');
      await fetchAppStatus();
      showToast('Settings saved.');
    } catch (err) {
      showToast(err.message, { isError: true });
    }
  });
}

function copyToClipboard(text, toastMessage) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(() => showToast(toastMessage || 'Copied to clipboard!'))
      .catch(() => fallbackCopyText(text, toastMessage));
  } else {
    fallbackCopyText(text, toastMessage);
  }
}

function fallbackCopyText(text, toastMessage) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
    showToast(toastMessage || 'Copied to clipboard!');
  } catch {
    showToast(`Copy manually: ${text}`);
  }
  document.body.removeChild(ta);
}

function isStandaloneApp() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

function isTrueHttpsOrLocalhost() {
  return (
    window.location.protocol === 'https:' ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1'
  );
}

async function triggerNativePwaInstall() {
  // If we are on a raw http:// LAN IP and the public HTTPS tunnel is available,
  // redirect the Android browser to the HTTPS tunnel URL so Google Play Services WebAPK minting succeeds!
  if (!isTrueHttpsOrLocalhost() && state.tunnelUrl && /Android/i.test(navigator.userAgent)) {
    showToast('Switching to secure HTTPS URL for Android app installation...');
    window.location.href = state.tunnelUrl;
    return;
  }

  if (state.deferredInstallPrompt) {
    try {
      state.deferredInstallPrompt.prompt();
      const choiceResult = await state.deferredInstallPrompt.userChoice;
      if (choiceResult?.outcome === 'accepted') {
        showToast('Installing Garmin Dish Logger on your phone...');
        state.deferredInstallPrompt = null;
        els.installPwaBtn?.classList.add('hidden');
        els.androidInstallBanner?.classList.add('hidden');
        els.nativeInstallReadyBox?.classList.add('hidden');
        els.qrModal?.classList.add('hidden');
      }
    } catch (err) {
      console.error('Install prompt error:', err);
    }
    return;
  }

  els.qrModal.classList.remove('hidden');
}

function initPwaAndInstall() {
  // Only register Service Worker on true HTTPS or localhost.
  // On raw http://192.168.x.x IPs (even with Chrome flags), Google Play Services' cloud WebAPK
  // server rejects private HTTP URLs with "Impossible to install the app".
  if ('serviceWorker' in navigator) {
    if (isTrueHttpsOrLocalhost()) {
      navigator.serviceWorker
        .register('./sw.js', { scope: './' })
        .then((reg) => {
          reg.update().catch(() => {});
        })
        .catch((err) => console.warn('Service worker registration skipped:', err));
    } else {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
    }
  }

  const isAndroid = /Android/i.test(navigator.userAgent);
  const standalone = isStandaloneApp();

  if (standalone) {
    els.installPwaBtn?.classList.add('hidden');
    els.androidInstallBanner?.classList.add('hidden');
    return;
  }

  // Show install banner on Android if not already installed or dismissed
  if (isAndroid && !sessionStorage.getItem('pwaBannerDismissed')) {
    els.androidInstallBanner?.classList.remove('hidden');
    if (!isTrueHttpsOrLocalhost() && els.bannerInstallBtn) {
      els.bannerInstallBtn.textContent = '🚀 Switch to HTTPS & Install';
    }
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    if (!isTrueHttpsOrLocalhost()) {
      // Prevent broken WebAPK attempt on raw HTTP private IP
      e.preventDefault();
      return;
    }
    e.preventDefault();
    state.deferredInstallPrompt = e;
    els.installPwaBtn?.classList.remove('hidden');
    els.nativeInstallReadyBox?.classList.remove('hidden');
    if (els.bannerInstallBtn) {
      els.bannerInstallBtn.textContent = '📲 Install App';
    }
    if (!sessionStorage.getItem('pwaBannerDismissed')) {
      els.androidInstallBanner?.classList.remove('hidden');
    }
  });

  window.addEventListener('appinstalled', () => {
    state.deferredInstallPrompt = null;
    els.installPwaBtn?.classList.add('hidden');
    els.androidInstallBanner?.classList.add('hidden');
    els.nativeInstallReadyBox?.classList.add('hidden');
    els.qrModal?.classList.add('hidden');
    showToast('✓ Garmin Dish Logger installed as an Android app!');
  });
}

async function handleUrlActionsAndShareTarget() {
  const params = new URLSearchParams(window.location.search);

  // Handle photo shared directly from Android Gallery / Google Photos via Web Share Target
  if (params.get('shared') === '1' && 'caches' in window) {
    try {
      const cache = await caches.open('garmin-dish-logger-v4');
      const sharedRes = await cache.match('/__shared_photo__');
      if (sharedRes) {
        const blob = await sharedRes.blob();
        const sharedNotes = sharedRes.headers.get('X-Shared-Notes') || '';
        await cache.delete('/__shared_photo__');
        if (sharedNotes) {
          els.userNotesInput.value = decodeURIComponent(sharedNotes);
        }
        const file = new File([blob], 'shared-dish.jpg', { type: blob.type || 'image/jpeg' });
        await handleImageSelected(file);
        showToast('Loaded shared dish photo! Tap Compute Calories & Macros.');
      }
    } catch (err) {
      console.warn('Failed to load shared photo:', err);
    }
    window.history.replaceState({}, '', '/');
  } else if (params.get('action') === 'log') {
    document.querySelector('.dashboard-col')?.scrollIntoView({ behavior: 'smooth' });
  }
}

// Initialize
async function startApp() {
  initEventListeners();
  initPwaAndInstall();
  await initBackendConnection();
  fetchAppStatus();
  fetchGarminNutrition(state.selectedDate);
  fetchRecentHistory();
  handleUrlActionsAndShareTarget();
}
startApp();

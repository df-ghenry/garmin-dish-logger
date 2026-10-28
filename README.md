# 🍽️ Garmin Dish Logger (`garmin-dish-logger`)

Mobile-first Web App / PWA that lets you snap a photo of any dish on your **Google Pixel phone** (or upload/paste on your **Fedora laptop**), computes the itemized ingredient weights, calories, and macronutrients (**Protein, Carbs, Fat, Fiber**) using **Google Gemini Vision**, lets you review/scale portions with a slider, and feeds the meal directly into **Garmin Connect Nutrition**.

---

## ✨ Features

1. **📸 Snap or Upload a Dish Photo**
   - Direct rear-camera capture on mobile (`capture="environment"`), photo gallery picker, drag-and-drop, or `Ctrl+V` clipboard paste on desktop.
   - Automatic client-side image compression (resizes high-res Pixel camera photos to `1280px` JPEG before sending).
   - Optional text or voice context notes (*"Half portion"*, *"Vegetarian"*, *"1 tbsp olive oil"*, or text-only meal descriptions without a photo).

2. **🔍 Interactive Preview & Adjustment Before Logging**
   - Itemized breakdown of every detected ingredient with weight (`g`), `kcal`, and `P / C / F` macros.
   - **Portion Multiplier Slider & Quick Buttons** (`0.5×`, `0.75×`, `1×`, `1.25×`, `1.5×`, `2×`) that dynamically scale all ingredients and totals.
   - Toggle individual ingredients on/off, edit gram weights directly, or ask Gemini in natural language to refine the estimate.
   - Auto-selects the target Garmin meal (`Breakfast`, `Lunch`, `Dinner`, `Snacks`) based on time of day, with smart non-overlapping timestamp resolution for `SNACKS`.

3. **⌚ Live Garmin Connect Two-Way Sync**
   - Reuses your authenticated Garmin Connect OAuth tokens in `~/.garmin-mcp/` with automatic token refresh.
   - Live calorie ring & macro progress bars (**Protein, Carbs, Fat**) + **Active Calories Burned** & **Steps** from your Garmin watch.
   - Full daily Garmin Food Log timeline with 1-click **Undo / Delete** (`DELETE /nutrition-service/food/logs/{date}`).
   - Optional checkbox to also save the dish to your Garmin Custom Foods catalog (`PUT /nutrition-service/customFood`).

4. **🧰 Bonus: MCP Server Integration (`garmin-connect-mcp`)**
   - Also adds `quick_add_food` and `delete_food_log` tools to `/home/geoffreyhenry/dev/garmin-connect-mcp`.

---

## 🚀 Usage & Service Management

The app runs as a user `systemd` service on port **3456**:

- **Laptop URL:** `http://localhost:3456`
- **Google Pixel Phone (same Wi-Fi):** Click **Pixel QR** in the top-right header to scan the LAN QR code and tap *"Add to Home Screen"* in Chrome.

```bash
# Check service status
systemctl --user status garmin-dish-logger.service

# Restart service
systemctl --user restart garmin-dish-logger.service

# Run tests
npm test
```

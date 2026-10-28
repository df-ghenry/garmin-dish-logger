import axios from 'axios';
import { loadSettings } from './config';
import { type MealName, suggestMealForCurrentTime } from './garmin.service';

export interface AnalyzedIngredient {
  id: string;
  name: string;
  grams: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  included: boolean;
}

export interface DishAnalysisResult {
  dishName: string;
  description: string;
  confidence: 'high' | 'medium' | 'low';
  suggestedMeal: MealName;
  totalGrams: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  healthTip: string;
  ingredients: AnalyzedIngredient[];
  modelUsed: string;
  isDemo?: boolean;
}

const DISH_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    dishName: {
      type: 'STRING',
      description: 'Concise, natural name of the dish for Garmin Connect food log (max 60 chars)',
    },
    description: {
      type: 'STRING',
      description: 'Brief 1-sentence description of the dish and cooking preparation observed',
    },
    confidence: {
      type: 'STRING',
      enum: ['high', 'medium', 'low'],
      description: 'Confidence level in the visual portion and macro estimation',
    },
    suggestedMeal: {
      type: 'STRING',
      enum: ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACKS'],
      description: 'Best matching Garmin Connect meal category',
    },
    healthTip: {
      type: 'STRING',
      description: 'Short, practical 1-sentence nutritional insight about this dish (macros/satiety/recovery)',
    },
    ingredients: {
      type: 'ARRAY',
      description: 'Breakdown of individual visible components/ingredients including cooking fats/sauces',
      items: {
        type: 'OBJECT',
        properties: {
          name: {
            type: 'STRING',
            description: 'Ingredient or component name',
          },
          grams: {
            type: 'NUMBER',
            description: 'Estimated weight of this component in grams',
          },
          calories: {
            type: 'NUMBER',
            description: 'Estimated kilocalories (kcal) for this component',
          },
          protein: {
            type: 'NUMBER',
            description: 'Protein in grams for this component',
          },
          carbs: {
            type: 'NUMBER',
            description: 'Total carbohydrates in grams for this component',
          },
          fat: {
            type: 'NUMBER',
            description: 'Total fat in grams for this component',
          },
          fiber: {
            type: 'NUMBER',
            description: 'Dietary fiber in grams for this component',
          },
        },
        required: ['name', 'grams', 'calories', 'protein', 'carbs', 'fat', 'fiber'],
      },
    },
  },
  required: [
    'dishName',
    'description',
    'confidence',
    'suggestedMeal',
    'healthTip',
    'ingredients',
  ],
};

function normalizeAnalysisResult(
  raw: Record<string, unknown>,
  modelUsed: string,
  isDemo = false,
): DishAnalysisResult {
  const rawIngredients = Array.isArray(raw.ingredients) ? raw.ingredients : [];
  const ingredients: AnalyzedIngredient[] = rawIngredients.map((item: unknown, idx: number) => {
    const obj = (item ?? {}) as Record<string, unknown>;
    return {
      id: String(obj.id || `ing-${ idx + 1 }-${ Date.now() }`),
      name: String(obj.name || `Ingredient ${ idx + 1 }`),
      grams: Math.max(1, Math.round(Number(obj.grams ?? 50))),
      calories: Math.max(0, Math.round(Number(obj.calories ?? 0))),
      protein: Math.max(0, Math.round(Number(obj.protein ?? 0) * 10) / 10),
      carbs: Math.max(0, Math.round(Number(obj.carbs ?? 0) * 10) / 10),
      fat: Math.max(0, Math.round(Number(obj.fat ?? 0) * 10) / 10),
      fiber: Math.max(0, Math.round(Number(obj.fiber ?? 0) * 10) / 10),
      included: obj.included !== false,
    };
  });

  const active = ingredients.filter((i) => i.included);
  const totalGrams = Math.round(active.reduce((sum, i) => sum + i.grams, 0));
  const calories = Math.round(active.reduce((sum, i) => sum + i.calories, 0));
  const protein = Math.round(active.reduce((sum, i) => sum + i.protein, 0));
  const carbs = Math.round(active.reduce((sum, i) => sum + i.carbs, 0));
  const fat = Math.round(active.reduce((sum, i) => sum + i.fat, 0));
  const fiber = Math.round(active.reduce((sum, i) => sum + i.fiber, 0));

  const validMeals = new Set<MealName>(['BREAKFAST', 'LUNCH', 'DINNER', 'SNACKS']);
  const rawMeal = String(raw.suggestedMeal ?? '').toUpperCase() as MealName;
  const suggestedMeal: MealName = validMeals.has(rawMeal)
    ? rawMeal
    : suggestMealForCurrentTime();

  const rawConf = String(raw.confidence ?? 'medium').toLowerCase();
  const confidence: 'high' | 'medium' | 'low' =
    rawConf === 'high' || rawConf === 'low' ? rawConf : 'medium';

  return {
    dishName: String(raw.dishName || 'Analyzed Dish').trim(),
    description: String(raw.description || '').trim(),
    confidence,
    suggestedMeal,
    totalGrams,
    calories,
    protein,
    carbs,
    fat,
    fiber,
    healthTip: String(raw.healthTip || '').trim(),
    ingredients,
    modelUsed,
    isDemo,
  };
}

export function getDemoDishAnalysis(presetIndex = 0, userNotes = ''): DishAnalysisResult {
  const presets: Array<Record<string, unknown>> = [
    {
      dishName: 'Mediterranean Quinoa & Grilled Halloumi Bowl',
      description:
        'Warm tri-color quinoa bowl topped with seared halloumi, roasted chickpeas, avocado, cherry tomatoes, and lemon-olive oil dressing.',
      confidence: 'high',
      suggestedMeal: suggestMealForCurrentTime(),
      healthTip:
        'Balanced vegetarian plate with complete plant + dairy protein (28g) and 11g fiber for steady afternoon energy.',
      ingredients: [
        { name: 'Cooked Tri-Color Quinoa', grams: 150, calories: 180, protein: 6.6, carbs: 32.0, fat: 2.9, fiber: 4.2 },
        { name: 'Grilled Halloumi Cheese', grams: 75, calories: 240, protein: 16.5, carbs: 1.5, fat: 18.8, fiber: 0 },
        { name: 'Roasted Spiced Chickpeas', grams: 65, calories: 108, protein: 5.8, carbs: 18.0, fat: 1.8, fiber: 4.9 },
        { name: 'Fresh Avocado Slices', grams: 50, calories: 80, protein: 1.0, carbs: 4.3, fat: 7.3, fiber: 3.4 },
        { name: 'Cherry Tomatoes, Cucumber & Greens', grams: 90, calories: 22, protein: 1.0, carbs: 4.5, fat: 0.2, fiber: 1.4 },
        { name: 'Extra Virgin Olive Oil & Lemon Dressing', grams: 10, calories: 88, protein: 0, carbs: 0.2, fat: 10.0, fiber: 0 },
      ],
    },
    {
      dishName: 'Wild Mushroom & Truffle Risotto',
      description:
        'Creamy Carnaroli rice risotto with sautéed porcini and chanterelle mushrooms, aged Parmigiano-Reggiano, and fresh parsley.',
      confidence: 'high',
      suggestedMeal: suggestMealForCurrentTime(),
      healthTip:
        'Rich in complex carbohydrates for endurance training replenishment; pair with a side salad to boost fiber.',
      ingredients: [
        { name: 'Carnaroli Rice (cooked in vegetable stock)', grams: 240, calories: 312, protein: 6.5, carbs: 67.2, fat: 0.9, fiber: 1.9 },
        { name: 'Sautéed Porcini & Chanterelle Mushrooms', grams: 110, calories: 48, protein: 3.8, carbs: 7.2, fat: 0.7, fiber: 2.8 },
        { name: 'Aged Parmigiano-Reggiano', grams: 30, calories: 120, protein: 10.7, carbs: 0.9, fat: 8.5, fiber: 0 },
        { name: 'Butter & Olive Oil Emulsion', grams: 14, calories: 108, protein: 0.1, carbs: 0, fat: 12.2, fiber: 0 },
      ],
    },
    {
      dishName: 'Skyr Berry & Toasted Walnut Bowl',
      description:
        'High-protein Icelandic Skyr topped with fresh blueberries, raspberries, toasted walnuts, chia seeds, and a drizzle of honey.',
      confidence: 'high',
      suggestedMeal: 'BREAKFAST',
      healthTip:
        'Excellent high-protein (29g) start with omega-3 fats from walnuts and antioxidants from mixed berries.',
      ingredients: [
        { name: 'Plain Icelandic Skyr (0% Fat)', grams: 220, calories: 140, protein: 24.2, carbs: 8.8, fat: 0.4, fiber: 0 },
        { name: 'Fresh Blueberries & Raspberries', grams: 85, calories: 46, protein: 0.8, carbs: 11.2, fat: 0.3, fiber: 4.1 },
        { name: 'Toasted Walnuts', grams: 20, calories: 131, protein: 3.0, carbs: 2.7, fat: 13.0, fiber: 1.3 },
        { name: 'Chia Seeds', grams: 10, calories: 49, protein: 1.7, carbs: 4.2, fat: 3.1, fiber: 3.4 },
        { name: 'Raw Acacia Honey', grams: 10, calories: 30, protein: 0, carbs: 8.2, fat: 0, fiber: 0 },
      ],
    },
  ];

  const chosen = presets[presetIndex % presets.length]!;
  const result = normalizeAnalysisResult(chosen, 'demo-simulation', true);
  if (userNotes.toLowerCase().includes('half') || userNotes.toLowerCase().includes('demi')) {
    result.ingredients = result.ingredients.map((i) => ({
      ...i,
      grams: Math.round(i.grams * 0.5),
      calories: Math.round(i.calories * 0.5),
      protein: Math.round(i.protein * 0.5 * 10) / 10,
      carbs: Math.round(i.carbs * 0.5 * 10) / 10,
      fat: Math.round(i.fat * 0.5 * 10) / 10,
      fiber: Math.round(i.fiber * 0.5 * 10) / 10,
    }));
    return normalizeAnalysisResult(
      { ...result, dishName: `${result.dishName} (Half Portion)` },
      'demo-simulation',
      true,
    );
  }
  return result;
}

export async function testGeminiApiKey(
  apiKey: string,
  model = 'gemini-3.8-flash',
): Promise<{ valid: boolean; model: string; error?: string }> {
  const cleanKey = apiKey.trim();
  if (!cleanKey) {
    return { valid: false, model, error: 'API key is empty' };
  }
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model,
    )}:generateContent?key=${encodeURIComponent(cleanKey)}`;
    const response = await axios.post(
      url,
      {
        contents: [{ role: 'user', parts: [{ text: 'Reply with OK' }] }],
        generationConfig: { maxOutputTokens: 10 },
      },
      { timeout: 12000 },
    );
    if (response.status === 200) {
      return { valid: true, model };
    }
    return { valid: false, model, error: `Unexpected status ${response.status}` };
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const apiMsg =
        (err.response?.data as { error?: { message?: string } })?.error?.message ||
        err.message;
      return { valid: false, model, error: apiMsg };
    }
    return {
      valid: false,
      model,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function analyzeDishWithGemini(params: {
  imageBase64?: string;
  mimeType?: string;
  userNotes?: string;
  demo?: boolean;
  demoPreset?: number;
}): Promise<DishAnalysisResult> {
  if (params.demo) {
    return getDemoDishAnalysis(params.demoPreset ?? 0, params.userNotes ?? '');
  }

  const settings = loadSettings();
  const apiKey = settings.geminiApiKey;
  const model = settings.geminiModel || 'gemini-3.8-flash';

  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY_MISSING: Please enter your Gemini API Key in Settings (or click "Try Demo Dish" to test without an API key).',
    );
  }

  const defaultMeal = suggestMealForCurrentTime();
  const nowTime = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const systemPrompt = [
    'You are an expert sports nutritionist and culinary macro estimator.',
    'Analyze the provided dish photo (and/or user description) with high accuracy.',
    '1. Identify all visible ingredients/components on the plate, including hidden cooking fats (e.g. olive oil, butter), sauces, or dressings.',
    '2. Estimate realistic portion weights in grams based on plate geometry, cutlery, or user notes.',
    '3. Compute accurate kilocalories (kcal), protein (g), carbohydrates (g), fat (g), and fiber (g) for each component.',
    '4. Ensure each component’s calories roughly align with its macros (4 kcal/g protein, 4 kcal/g carbs, 9 kcal/g fat).',
    `5. Current local time is ${nowTime} (default meal suggestion: ${defaultMeal}).`,
    '6. Match the language of user notes if provided in French or English (default to concise English or French dish name).',
  ].join('\n');

  const parts: Array<Record<string, unknown>> = [];

  if (params.imageBase64) {
    const cleanBase64 = params.imageBase64.replace(/^data:[^;]+;base64,/, '');
    parts.push({
      inlineData: {
        mimeType: params.mimeType || 'image/jpeg',
        data: cleanBase64,
      },
    });
  }

  const userText = params.userNotes?.trim()
    ? `Analyze this dish and compute its calories and macronutrients. User context / notes: "${params.userNotes.trim()}"`
    : 'Analyze this dish photo and compute its calories, macronutrients (protein, carbs, fat, fiber), and ingredient breakdown.';

  parts.push({ text: userText });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  try {
    const response = await axios.post(
      url,
      {
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [
          {
            role: 'user',
            parts,
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseSchema: DISH_RESPONSE_SCHEMA,
        },
      },
      { timeout: 45000 },
    );

    const textOutput =
      response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textOutput) {
      throw new Error('Gemini returned an empty response.');
    }

    const parsed = JSON.parse(textOutput) as Record<string, unknown>;
    return normalizeAnalysisResult(parsed, model, false);
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const msg =
        (err.response?.data as { error?: { message?: string } })?.error?.message ||
        err.message;
      throw new Error(`Gemini API Error: ${msg}`);
    }
    throw err;
  }
}

export async function refineDishWithGemini(params: {
  currentAnalysis: DishAnalysisResult;
  instruction: string;
}): Promise<DishAnalysisResult> {
  const settings = loadSettings();
  const apiKey = settings.geminiApiKey;
  const model = settings.geminiModel || 'gemini-3.8-flash';

  // If in demo mode or no API key, apply smart local heuristic refinement so it works offline/in demo too
  if (!apiKey || params.currentAnalysis.isDemo) {
    const instr = params.instruction.toLowerCase();
    const cloned = JSON.parse(JSON.stringify(params.currentAnalysis)) as DishAnalysisResult;
    if (instr.includes('half') || instr.includes('50%') || instr.includes('demi')) {
      cloned.ingredients = cloned.ingredients.map((i) => ({
        ...i,
        grams: Math.round(i.grams * 0.5),
        calories: Math.round(i.calories * 0.5),
        protein: Math.round(i.protein * 0.5 * 10) / 10,
        carbs: Math.round(i.carbs * 0.5 * 10) / 10,
        fat: Math.round(i.fat * 0.5 * 10) / 10,
        fiber: Math.round(i.fiber * 0.5 * 10) / 10,
      }));
    } else if (instr.includes('double') || instr.includes('2x')) {
      cloned.ingredients = cloned.ingredients.map((i) => ({
        ...i,
        grams: Math.round(i.grams * 2),
        calories: Math.round(i.calories * 2),
        protein: Math.round(i.protein * 2 * 10) / 10,
        carbs: Math.round(i.carbs * 2 * 10) / 10,
        fat: Math.round(i.fat * 2 * 10) / 10,
        fiber: Math.round(i.fiber * 2 * 10) / 10,
      }));
    } else if (instr.includes('no oil') || instr.includes('without oil') || instr.includes('sans huile')) {
      cloned.ingredients = cloned.ingredients.map((i) =>
        i.name.toLowerCase().includes('oil') || i.name.toLowerCase().includes('butter')
          ? { ...i, included: false }
          : i,
      );
    } else {
      cloned.description = `${cloned.description} (Adjusted: ${params.instruction})`;
    }
    return normalizeAnalysisResult(
      cloned as unknown as Record<string, unknown>,
      cloned.modelUsed,
      Boolean(cloned.isDemo),
    );
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const prompt = [
    'Here is the current nutritional breakdown of a dish:',
    JSON.stringify(params.currentAnalysis, null, 2),
    '',
    `The user requested this adjustment: "${params.instruction}"`,
    'Update the dishName (if appropriate), description, ingredients list, weights, calories, and macronutrients according to the user instruction.',
  ].join('\n');

  const response = await axios.post(
    url,
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: DISH_RESPONSE_SCHEMA,
      },
    },
    { timeout: 30000 },
  );

  const textOutput = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textOutput) {
    throw new Error('Gemini returned an empty response during refinement.');
  }

  const parsed = JSON.parse(textOutput) as Record<string, unknown>;
  return normalizeAnalysisResult(parsed, model, false);
}

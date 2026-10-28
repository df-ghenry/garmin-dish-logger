import assert from 'node:assert/strict';
import test from 'node:test';

const BASE_URL = process.env.TEST_URL || 'http://127.0.0.1:3456';

test('Garmin Dish Logger end-to-end API & Garmin Connect integration', async (t) => {
  await t.test('GET /api/status returns Garmin connected status and LAN QR', async () => {
    const res = await fetch(`${BASE_URL}/api/status`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.garmin.connected, true);
    assert.ok(data.network.qrSvg.includes('<svg'));
  });

  await t.test('GET /api/nutrition fetches live daily goals and meal windows from Garmin Connect', async () => {
    const res = await fetch(`${BASE_URL}/api/nutrition?date=2026-10-19`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.date, '2026-10-19');
    assert.ok(data.goals.calories > 0);
    assert.ok(Array.isArray(data.meals));
    assert.ok(data.meals.length >= 4);
  });

  let sampleAnalysis;
  await t.test('POST /api/analyze computes structured dish calories, macros, and ingredients', async () => {
    const res = await fetch(`${BASE_URL}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        demo: true,
        demoPreset: 0,
        userNotes: '',
      }),
    });
    assert.equal(res.status, 200);
    sampleAnalysis = await res.json();
    assert.ok(sampleAnalysis.dishName.includes('Halloumi'));
    assert.ok(sampleAnalysis.calories > 400);
    assert.ok(sampleAnalysis.protein > 20);
    assert.ok(Array.isArray(sampleAnalysis.ingredients));
    assert.ok(sampleAnalysis.ingredients.length >= 4);
  });

  await t.test('POST /api/refine adjusts portion macros by instruction', async () => {
    const res = await fetch(`${BASE_URL}/api/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentAnalysis: sampleAnalysis,
        instruction: 'half portion (50%)',
      }),
    });
    assert.equal(res.status, 200);
    const refined = await res.json();
    assert.ok(refined.calories < sampleAnalysis.calories);
  });

  await t.test('POST /api/garmin/log and DELETE /api/garmin/log/:date/:logId round-trip on Garmin Connect', async () => {
    const logRes = await fetch(`${BASE_URL}/api/garmin/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Automated E2E Test Dish',
        calories: 310,
        protein: 22,
        carbs: 34,
        fat: 9,
        meal: 'SNACKS',
        date: '2026-10-19',
      }),
    });
    assert.equal(logRes.status, 200);
    const logData = await logRes.json();
    assert.equal(logData.ok, true);
    assert.ok(logData.logId, 'Expected a Garmin logId to be returned');

    // Clean up both the Garmin food log entry and the local history entry
    const delRes = await fetch(
      `${BASE_URL}/api/garmin/log/2026-10-19/${encodeURIComponent(logData.logId)}`,
      { method: 'DELETE' },
    );
    assert.equal(delRes.status, 200);
    const delData = await delRes.json();
    assert.equal(delData.ok, true);

    if (logData.historyEntry?.id) {
      await fetch(`${BASE_URL}/api/history/${encodeURIComponent(logData.historyEntry.id)}`, {
        method: 'DELETE',
      });
    }
  });
});

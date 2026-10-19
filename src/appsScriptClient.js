// appsScriptClient.js
// Заміна supabaseClient.js — усі виклики йдуть на розгорнутий Google Apps Script Web App.
//
// ВАЖЛИВО про CORS: POST-запити відправляються з Content-Type: text/plain,
// а не application/json. Це навмисно — Apps Script не обробляє CORS-preflight
// (OPTIONS-запит), і якщо браузер його відправить (що станеться при
// application/json), запит впаде. text/plain — це "simple request" за
// специфікацією CORS, preflight не потрібен. На боці Apps Script (doPost)
// тіло однаково парситься як JSON через JSON.parse(e.postData.contents),
// незалежно від заявленого Content-Type.
//
// Усі запити, включно з читанням даних, ідуть через POST (doPost на сервері) —
// жодного PIN у query-параметрі URL: URL-адреси осідають у логах Apps
// Script/проксі-серверів і в історії браузера, тіло POST-запиту — ні.

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzGQ66LSiG4Gufrl7E_ihdzh3FWZc50tAuPiCcjBzq5Mev56NXerqSbl0zfa9_ePuwB9A/exec';

/**
 * Виконує дію на сервері — і читання ('getAll'), і запис (addStock,
 * addOperation, saveMaterial, ...). pin — PIN поточного залогіненого
 * користувача (sessionPin у App.jsx); сервер сам перевіряє права для
 * кожної дії, це не просто UI-затвор.
 *
 * Повертає { success: true, data: {...} } або { success: false, error: '...' } —
 * компоненти самі показують result.error через showMsg/alert.
 * Мережеві збої (сервер недоступний) кидають Error з людяним повідомленням.
 */
async function callAction(action, payload, pin) {
  let res;
  try {
    res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, pin, payload })
    });
  } catch (networkErr) {
    throw new Error("Немає з'єднання з сервером Apps Script.");
  }
  if (!res.ok) throw new Error('Мережева помилка: ' + res.status);
  return res.json();
}

/**
 * Завантажує стан застосунку (materials, stock, operations, expenses,
 * subcategories, writeoffs, users, templates, templateItems) одним запитом.
 *
 * pin — необов'язковий. Без нього сервер повертає "публічний" зріз (без
 * ІБ пацієнтів у operations, без PIN-кодів у users) — саме це вантажиться
 * при першому відкритті застосунку, ще до входу. Після успішного логіну
 * виклич це ще раз з pin — сервер довантажить ІБ пацієнтів (для будь-якого
 * залогіненого) і реальні PIN-и в users (лише якщо pin належить admin).
 *
 * Кидає Error з людяним повідомленням при мережевій помилці або якщо
 * сервер повернув success:false.
 */
async function fetchAllData(pin) {
  const json = await callAction('getAll', {}, pin || '');
  if (!json.success) throw new Error(json.error || 'Невідома помилка сервера.');
  return json.data;
}

export { fetchAllData, callAction };

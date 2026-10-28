const STORAGE_KEY = "poker-dealer-clock-v1";
const TELEGRAM_STORAGE_KEY = "poker_clock_state_v2";
const telegramSdk = window.Telegram?.WebApp || null;
const telegram = telegramSdk && (telegramSdk.initData || (telegramSdk.platform && telegramSdk.platform !== "unknown")) ? telegramSdk : null;

const defaultStructure = [
  { type: "level", duration: 15, sb: 25, bb: 50, ante: 0 },
  { type: "level", duration: 15, sb: 50, bb: 100, ante: 0 },
  { type: "level", duration: 15, sb: 75, bb: 150, ante: 0 },
  { type: "break", duration: 10 },
  { type: "level", duration: 15, sb: 100, bb: 200, ante: 25 },
  { type: "level", duration: 15, sb: 150, bb: 300, ante: 50 },
  { type: "level", duration: 15, sb: 200, bb: 400, ante: 50 },
  { type: "break", duration: 10 },
  { type: "level", duration: 15, sb: 300, bb: 600, ante: 100 },
  { type: "level", duration: 15, sb: 400, bb: 800, ante: 100 },
  { type: "level", duration: 15, sb: 600, bb: 1200, ante: 200 }
];

const defaultPlayers = [
  { id: crypto.randomUUID(), name: "Игрок 1", amount: 500, active: true },
  { id: crypto.randomUUID(), name: "Игрок 2", amount: 1000, active: true },
  { id: crypto.randomUUID(), name: "Игрок 3", amount: 2000, active: true },
  { id: crypto.randomUUID(), name: "Игрок 4", amount: 2000, active: true }
];

const saved = loadState();
const state = {
  structure: Array.isArray(saved.structure) && saved.structure.length ? saved.structure : structuredClone(defaultStructure),
  startingStack: Number(saved.startingStack) || 3000,
  levelIndex: Math.min(Number(saved.levelIndex) || 0, Math.max(0, (saved.structure || defaultStructure).length - 1)),
  remainingMs: Number.isFinite(Number(saved.remainingMs)) ? Math.max(0, Number(saved.remainingMs)) : 15 * 60_000,
  running: Boolean(saved.running),
  endsAt: Number(saved.endsAt) || null,
  tournamentStartedAt: Number(saved.tournamentStartedAt) || null,
  elapsedBeforeStart: Number(saved.elapsedBeforeStart) || 0,
  sound: saved.sound !== false,
  players: Array.isArray(saved.players) && saved.players.length ? saved.players : defaultPlayers,
  savedAt: Number(saved.savedAt) || 0,
  potWinners: {}
};

let audioContext = null;
let wakeLock = null;
let toastTimer = null;
let telegramSaveTimer = null;
let telegramPersistChain = Promise.resolve();

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const formatNumber = (value) => new Intl.NumberFormat("ru-RU").format(Number(value) || 0);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function loadState() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
  catch { return {}; }
}

function stateSnapshot() {
  return {
    structure: state.structure,
    startingStack: state.startingStack,
    levelIndex: state.levelIndex,
    remainingMs: state.remainingMs,
    running: state.running,
    endsAt: state.endsAt,
    tournamentStartedAt: state.tournamentStartedAt,
    elapsedBeforeStart: state.elapsedBeforeStart,
    sound: state.sound,
    players: state.players,
    savedAt: state.savedAt
  };
}

function writeLocalSnapshot(snapshot = stateSnapshot()) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)); }
  catch { /* Telegram DeviceStorage remains available when browser storage is restricted. */ }
}

function saveState(options = {}) {
  state.savedAt = Date.now();
  const snapshot = stateSnapshot();
  writeLocalSnapshot(snapshot);
  if (options.telegram !== false) queueTelegramSave(snapshot);
}

function queueTelegramSave(snapshot) {
  if (!telegram) return;
  clearTimeout(telegramSaveTimer);
  setTelegramStatus("Сохраняю…", "syncing");
  telegramSaveTimer = setTimeout(() => {
    telegramPersistChain = telegramPersistChain.then(() => persistToTelegram(snapshot)).catch(() => {
      setTelegramStatus("Сохранено локально", "error");
    });
  }, 300);
}

async function persistToTelegram(snapshot) {
  if (!telegram) return;
  const value = JSON.stringify(snapshot);
  const targets = [telegram.DeviceStorage, telegram.CloudStorage].filter(Boolean);
  if (!targets.length) {
    setTelegramStatus("Сохранено локально");
    return;
  }
  const results = await Promise.all(targets.map((storage) => telegramStorageSet(storage, TELEGRAM_STORAGE_KEY, value)));
  if (results.some(Boolean)) setTelegramStatus(results.every(Boolean) ? "Сохранено" : "Сохранено на устройстве");
  else setTelegramStatus("Сохранено локально", "error");
}

function telegramStorageSet(storage, key, value) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => finish(false), 2500);
    try { storage.setItem(key, value, (error, stored) => finish(!error && stored !== false)); }
    catch { finish(false); }
  });
}

function telegramStorageGet(storage, key) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value || null);
    };
    const timeout = setTimeout(() => finish(null), 2500);
    try { storage.getItem(key, (error, value) => finish(error ? null : value)); }
    catch { finish(null); }
  });
}

function parseStoredSnapshot(value) {
  if (!value) return null;
  try {
    const snapshot = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(snapshot.structure) || !snapshot.structure.length) return null;
    return snapshot;
  } catch { return null; }
}

function applyStoredSnapshot(snapshot) {
  if (!snapshot) return false;
  state.structure = snapshot.structure;
  state.startingStack = Number(snapshot.startingStack) || 3000;
  state.levelIndex = clamp(Number(snapshot.levelIndex) || 0, 0, state.structure.length - 1);
  state.remainingMs = Math.max(0, Number(snapshot.remainingMs) || 0);
  state.running = Boolean(snapshot.running);
  state.endsAt = Number(snapshot.endsAt) || null;
  state.tournamentStartedAt = Number(snapshot.tournamentStartedAt) || null;
  state.elapsedBeforeStart = Number(snapshot.elapsedBeforeStart) || 0;
  state.sound = snapshot.sound !== false;
  state.players = Array.isArray(snapshot.players) && snapshot.players.length ? snapshot.players : state.players;
  state.savedAt = Number(snapshot.savedAt) || 0;
  return true;
}

async function hydrateFromTelegram() {
  if (!telegram) return;
  const storages = [telegram.DeviceStorage, telegram.CloudStorage].filter(Boolean);
  if (!storages.length) return setTelegramStatus("Локальное сохранение");
  setTelegramStatus("Восстановление…", "syncing");
  const values = await Promise.all(storages.map((storage) => telegramStorageGet(storage, TELEGRAM_STORAGE_KEY)));
  const candidates = [stateSnapshot(), ...values.map(parseStoredSnapshot).filter(Boolean)];
  candidates.sort((a, b) => (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0));
  const freshest = candidates[0];
  const previousSavedAt = state.savedAt;
  if ((Number(freshest.savedAt) || 0) > previousSavedAt) applyStoredSnapshot(freshest);
  reconcileRunningTimer();
  saveState();
  renderClock();
  renderSchedule();
  renderPlayers();
  setTelegramStatus((Number(freshest.savedAt) || 0) > previousSavedAt ? "Восстановлено" : "Сохранено");
}

function setTelegramStatus(text, mode = "") {
  const badge = document.querySelector("#telegramStatus");
  if (!badge || !telegram) return;
  badge.hidden = false;
  badge.textContent = text;
  badge.classList.toggle("is-syncing", mode === "syncing");
  badge.classList.toggle("is-error", mode === "error");
}

function updateTelegramClosingProtection() {
  if (!telegram) return;
  try {
    if (state.running) telegram.enableClosingConfirmation?.();
    else telegram.disableClosingConfirmation?.();
  } catch { /* Older Telegram clients can ignore this enhancement. */ }
}

function resumeFromBackground() {
  const previousIndex = state.levelIndex;
  const wasRunning = state.running;
  reconcileRunningTimer();
  if (previousIndex !== state.levelIndex || wasRunning !== state.running) saveState();
  if (state.running) requestWakeLock();
  renderClock();
  updateTelegramClosingProtection();
}

function initializeTelegram() {
  if (!telegram) return;
  try {
    telegram.ready();
    telegram.expand();
    telegram.setHeaderColor?.("#07111f");
    telegram.setBackgroundColor?.("#050a13");
    telegram.setBottomBarColor?.("#050a13");
    telegram.lockOrientation?.();
    telegram.onEvent?.("activated", resumeFromBackground);
    telegram.onEvent?.("deactivated", () => saveState());
  } catch { /* The regular browser build keeps working outside Telegram. */ }
  updateTelegramClosingProtection();
  window.addEventListener("offline", () => {
    saveState();
    setTelegramStatus("Оффлайн · сохранено", "error");
  });
  window.addEventListener("online", () => hydrateFromTelegram());
  hydrateFromTelegram();
}

function currentStage() { return state.structure[state.levelIndex] || state.structure[0]; }

function stageDurationMs(stage = currentStage()) {
  return Math.max(1, Number(stage?.duration) || 1) * 60_000;
}

function reconcileRunningTimer() {
  if (!state.running || !state.endsAt) return;
  let now = Date.now();
  while (now >= state.endsAt && state.levelIndex < state.structure.length - 1) {
    state.levelIndex += 1;
    state.endsAt += stageDurationMs();
  }
  if (now >= state.endsAt && state.levelIndex >= state.structure.length - 1) {
    state.remainingMs = 0;
    state.running = false;
    state.endsAt = null;
  } else {
    state.remainingMs = Math.max(0, state.endsAt - now);
  }
}

function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function nonBreakLevelNumber(index) {
  return state.structure.slice(0, index + 1).filter((stage) => stage.type === "level").length;
}

function renderClock() {
  const stage = currentStage();
  const next = state.structure[state.levelIndex + 1];
  const duration = stageDurationMs(stage);
  const progress = clamp((state.remainingMs / duration) * 100, 0, 100);
  const isBreak = stage.type === "break";

  $("#levelLabel").textContent = isBreak ? "Перерыв" : `Уровень ${nonBreakLevelNumber(state.levelIndex)}`;
  $("#levelLabel").classList.toggle("break", isBreak);
  $("#levelDuration").textContent = `${stage.duration} ${pluralMinutes(stage.duration)}`;
  $("#timerKicker").textContent = isBreak ? "ДО КОНЦА ПЕРЕРЫВА" : "ДО ПОВЫШЕНИЯ";
  $("#timerDisplay").textContent = formatClock(state.remainingMs);
  $("#timerDisplay").classList.toggle("is-warning", state.remainingMs <= 60_000 && state.remainingMs > 10_000);
  $("#timerDisplay").classList.toggle("is-critical", state.remainingMs <= 10_000);
  $("#progressBar").style.width = `${progress}%`;
  $("#currentBlindsBlock").hidden = isBreak;
  if (!isBreak) {
    $("#currentBlinds").textContent = `${formatNumber(stage.sb)} / ${formatNumber(stage.bb)}`;
    $("#currentAnte").textContent = stage.ante ? `анте ${formatNumber(stage.ante)}` : "без анте";
  }
  if (!next) {
    $("#nextBlinds").textContent = "Конец турнира";
    $("#nextMeta").textContent = "Последний уровень структуры";
  } else if (next.type === "break") {
    $("#nextBlinds").textContent = "Перерыв";
    $("#nextMeta").textContent = `${next.duration} ${pluralMinutes(next.duration)}`;
  } else {
    $("#nextBlinds").textContent = `${formatNumber(next.sb)} / ${formatNumber(next.bb)}`;
    $("#nextMeta").textContent = `${next.duration} мин · ${next.ante ? `анте ${formatNumber(next.ante)}` : "без анте"}`;
  }
  $("#playIcon").textContent = state.running ? "Ⅱ" : "▶";
  $("#playButton").setAttribute("aria-label", state.running ? "Поставить таймер на паузу" : "Запустить таймер");
  $("#startingStackDisplay").textContent = formatNumber(state.startingStack);
  $("#elapsedTime").textContent = formatElapsed(getElapsedMs());
  $("#soundButton").classList.toggle("is-muted", !state.sound);
  $("#soundButton").setAttribute("aria-label", state.sound ? "Звук включён" : "Звук выключен");
}

function pluralMinutes(value) {
  const n = Math.abs(Number(value)) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return "минут";
  if (n1 > 1 && n1 < 5) return "минуты";
  if (n1 === 1) return "минута";
  return "минут";
}

function getElapsedMs() {
  if (state.tournamentStartedAt) return state.elapsedBeforeStart + (Date.now() - state.tournamentStartedAt);
  return state.elapsedBeforeStart;
}

function formatElapsed(ms) {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

async function toggleTimer() {
  unlockAudio();
  if (state.running) {
    state.remainingMs = Math.max(0, state.endsAt - Date.now());
    state.running = false;
    state.endsAt = null;
    if (state.tournamentStartedAt) {
      state.elapsedBeforeStart += Date.now() - state.tournamentStartedAt;
      state.tournamentStartedAt = null;
    }
    releaseWakeLock();
  } else {
    if (state.remainingMs <= 0) state.remainingMs = stageDurationMs();
    state.running = true;
    state.endsAt = Date.now() + state.remainingMs;
    state.tournamentStartedAt = Date.now();
    requestWakeLock();
  }
  saveState();
  updateTelegramClosingProtection();
  renderClock();
}

function adjustMinute(delta) {
  const current = state.running ? Math.max(0, state.endsAt - Date.now()) : state.remainingMs;
  state.remainingMs = Math.max(0, current + delta * 60_000);
  if (state.running) state.endsAt = Date.now() + state.remainingMs;
  saveState();
  renderClock();
  showToast(delta > 0 ? "Добавлена 1 минута" : "Убрана 1 минута");
}

function changeLevel(delta, announce = true) {
  const nextIndex = clamp(state.levelIndex + delta, 0, state.structure.length - 1);
  if (nextIndex === state.levelIndex && delta !== 0) return;
  state.levelIndex = nextIndex;
  state.remainingMs = stageDurationMs();
  if (state.running) state.endsAt = Date.now() + state.remainingMs;
  state.potWinners = {};
  saveState();
  renderClock();
  if (announce) showToast(currentStage().type === "break" ? "Начался перерыв" : `Уровень ${nonBreakLevelNumber(state.levelIndex)}`);
}

function resetCurrentLevel() {
  state.remainingMs = stageDurationMs();
  if (state.running) state.endsAt = Date.now() + state.remainingMs;
  saveState();
  renderClock();
  showToast("Уровень сброшен");
}

function timerTick() {
  if (state.running && state.endsAt) {
    const before = state.remainingMs;
    state.remainingMs = Math.max(0, state.endsAt - Date.now());
    if (state.remainingMs <= 0) {
      playAlarm();
      if (state.levelIndex < state.structure.length - 1) changeLevel(1);
      else {
        state.running = false;
        state.endsAt = null;
        if (state.tournamentStartedAt) {
          state.elapsedBeforeStart += Date.now() - state.tournamentStartedAt;
          state.tournamentStartedAt = null;
        }
        releaseWakeLock();
        saveState();
        showToast("Структура завершена");
      }
    } else if (Math.floor(before / 1000) !== Math.floor(state.remainingMs / 1000)) {
      if (state.sound && state.remainingMs <= 10_000 && state.remainingMs > 0) playTick();
    }
  }
  renderClock();
}

function unlockAudio() {
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === "suspended") audioContext.resume();
}

function tone(frequency, duration, gain = 0.08, delay = 0) {
  if (!state.sound) return;
  unlockAudio();
  const osc = audioContext.createOscillator();
  const volume = audioContext.createGain();
  osc.frequency.value = frequency;
  osc.type = "sine";
  volume.gain.setValueAtTime(0.0001, audioContext.currentTime + delay);
  volume.gain.exponentialRampToValueAtTime(gain, audioContext.currentTime + delay + 0.015);
  volume.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + delay + duration);
  osc.connect(volume).connect(audioContext.destination);
  osc.start(audioContext.currentTime + delay);
  osc.stop(audioContext.currentTime + delay + duration + 0.03);
}

function playTick() { tone(710, 0.08, 0.025); }
function playAlarm() {
  tone(523, .24, .11, 0);
  tone(659, .24, .11, .25);
  tone(784, .38, .13, .5);
  navigator.vibrate?.([180, 100, 260]);
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try { wakeLock = await navigator.wakeLock.request("screen"); }
  catch { /* Screen wake lock is best-effort. */ }
}

function releaseWakeLock() {
  wakeLock?.release?.();
  wakeLock = null;
}

function renderSchedule() {
  const container = $("#scheduleList");
  container.innerHTML = "";
  let levelNumber = 0;
  state.structure.forEach((stage, index) => {
    if (stage.type === "level") levelNumber += 1;
    const item = document.createElement("div");
    item.className = `schedule-item${stage.type === "break" ? " is-break" : ""}`;
    if (stage.type === "break") {
      item.innerHTML = `
        <div class="schedule-number">☕</div>
        <div class="break-label">Перерыв</div>
        ${compactField("Мин", stage.duration, "duration", index)}
        <button class="delete-button" data-delete-stage="${index}" type="button" aria-label="Удалить перерыв">×</button>`;
    } else {
      item.innerHTML = `
        <div class="schedule-number">${levelNumber}</div>
        ${compactField("SB", stage.sb, "sb", index)}
        ${compactField("BB", stage.bb, "bb", index)}
        ${compactField("Анте", stage.ante, "ante", index)}
        <button class="delete-button" data-delete-stage="${index}" type="button" aria-label="Удалить уровень">×</button>
        <div></div>${compactField("Минут", stage.duration, "duration", index)}<div></div><div></div><div></div>`;
    }
    container.appendChild(item);
  });
  $("#startingStack").value = state.startingStack;
}

function compactField(label, value, key, index) {
  return `<div class="compact-field"><label>${label}</label><input type="number" min="0" inputmode="numeric" value="${Number(value) || 0}" data-stage-index="${index}" data-stage-key="${key}" /></div>`;
}

function updateStage(index, key, value) {
  const number = Math.max(key === "duration" ? 1 : 0, Number(value) || 0);
  state.structure[index][key] = number;
  if (index === state.levelIndex && key === "duration" && !state.running) {
    state.remainingMs = Math.min(state.remainingMs, stageDurationMs());
  }
  saveState();
  renderClock();
}

function deleteStage(index) {
  if (state.structure.length <= 1) return showToast("Нужен хотя бы один уровень");
  state.structure.splice(index, 1);
  if (index < state.levelIndex) state.levelIndex -= 1;
  state.levelIndex = clamp(state.levelIndex, 0, state.structure.length - 1);
  state.remainingMs = stageDurationMs();
  if (state.running) state.endsAt = Date.now() + state.remainingMs;
  saveState();
  renderSchedule();
  renderClock();
}

function addStage(type) {
  const previousLevel = [...state.structure].reverse().find((item) => item.type === "level") || defaultStructure[0];
  state.structure.push(type === "break"
    ? { type: "break", duration: 10 }
    : { type: "level", duration: 15, sb: previousLevel.bb, bb: previousLevel.bb * 2, ante: previousLevel.ante });
  saveState();
  renderSchedule();
  requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
}

function resetStructure() {
  if (!confirm("Вернуть стандартную структуру? Текущая структура будет заменена.")) return;
  state.structure = structuredClone(defaultStructure);
  state.levelIndex = 0;
  state.remainingMs = stageDurationMs();
  if (state.running) state.endsAt = Date.now() + state.remainingMs;
  saveState();
  renderSchedule();
  renderClock();
  showToast("Структура восстановлена");
}

function renderPlayers() {
  const container = $("#playerRows");
  container.innerHTML = "";
  state.players.forEach((player) => {
    const row = document.createElement("div");
    row.className = "player-row";
    row.innerHTML = `
      <input class="player-input" value="${escapeHtml(player.name)}" aria-label="Имя игрока" data-player-name="${player.id}" />
      <input class="player-input player-amount" type="number" min="0" inputmode="numeric" value="${Number(player.amount) || 0}" aria-label="Вложено в раздачу" data-player-amount="${player.id}" />
      <label class="toggle-wrap" title="Игрок не сбросил карты"><input class="toggle" type="checkbox" ${player.active ? "checked" : ""} aria-label="Игрок в раздаче" data-player-active="${player.id}" /></label>
      <button class="remove-player" type="button" data-remove-player="${player.id}" aria-label="Удалить игрока">×</button>`;
    container.appendChild(row);
  });
}

function addPlayer() {
  state.players.push({ id: crypto.randomUUID(), name: `Игрок ${state.players.length + 1}`, amount: 0, active: true });
  saveState();
  renderPlayers();
}

function clearAllin() {
  state.players = Array.from({ length: 4 }, (_, index) => ({ id: crypto.randomUUID(), name: `Игрок ${index + 1}`, amount: 0, active: true }));
  state.potWinners = {};
  saveState();
  renderPlayers();
  $("#calculationResults").innerHTML = "";
}

function calculateSidePots() {
  const players = state.players
    .map((player) => ({ ...player, amount: Math.max(0, Math.floor(Number(player.amount) || 0)), name: player.name.trim() || "Без имени" }))
    .filter((player) => player.amount > 0);

  if (players.length < 2) {
    $("#calculationResults").innerHTML = `<div class="warning-card">Введите вклад как минимум двух игроков.</div>`;
    return;
  }

  const tiers = [...new Set(players.map((player) => player.amount))].sort((a, b) => a - b);
  const pots = [];
  const returns = [];
  const warnings = [];
  let previous = 0;

  tiers.forEach((tier) => {
    const contributors = players.filter((player) => player.amount >= tier);
    const amount = (tier - previous) * contributors.length;
    const eligible = contributors.filter((player) => player.active);
    if (contributors.length === 1) {
      returns.push({ player: contributors[0], amount });
    } else if (amount > 0) {
      pots.push({ amount, cap: tier, eligible });
      if (!eligible.length) warnings.push(`В банке ${formatNumber(amount)} нет игрока, который может его выиграть. Проверьте отметки «В игре».`);
    }
    previous = tier;
  });

  renderPotResults(players, pots, returns, warnings);
}

function renderPotResults(players, pots, returns, warnings) {
  const totalCommitted = players.reduce((sum, player) => sum + player.amount, 0);
  const totalPots = pots.reduce((sum, pot) => sum + pot.amount, 0);
  const results = $("#calculationResults");
  results.innerHTML = `<div class="summary-line"><span>Всего вложено</span><strong>${formatNumber(totalCommitted)}</strong></div>`;

  warnings.forEach((warning) => results.insertAdjacentHTML("beforeend", `<div class="warning-card">${escapeHtml(warning)}</div>`));
  returns.forEach((item) => results.insertAdjacentHTML("beforeend", `<div class="return-card"><strong>${escapeHtml(item.player.name)}</strong>: вернуть недоставленную ставку <strong>${formatNumber(item.amount)}</strong></div>`));

  pots.forEach((pot, index) => {
    const potKey = `pot-${index}-${pot.cap}-${pot.amount}`;
    const selected = state.potWinners[potKey] || [];
    const card = document.createElement("article");
    card.className = "pot-card";
    card.innerHTML = `
      <div class="pot-title"><h3>${index === 0 ? "Основной банк" : `Побочный банк ${index}`}</h3><span class="pot-amount">${formatNumber(pot.amount)}</span></div>
      <p class="pot-note">Учитываются ставки до ${formatNumber(pot.cap)} · могут выиграть: ${pot.eligible.length ? pot.eligible.map((p) => escapeHtml(p.name)).join(", ") : "никто"}</p>
      ${pot.eligible.length ? `<div class="winner-label">Отметьте победителя или делёжку</div><div class="winner-buttons">${pot.eligible.map((player) => `<button class="winner-button ${selected.includes(player.id) ? "is-selected" : ""}" type="button" data-pot-key="${potKey}" data-winner-id="${player.id}">${escapeHtml(player.name)}</button>`).join("")}</div>` : ""}`;
    results.appendChild(card);
  });

  const payouts = buildPayouts(pots);
  if (payouts.rows.length) {
    results.insertAdjacentHTML("beforeend", `
      <div class="payout-summary">
        <h3>Выплаты из выбранных банков</h3>
        ${payouts.rows.map((row) => `<div class="payout-row"><span>${escapeHtml(row.name)}</span><strong>+${formatNumber(row.amount)}</strong></div>`).join("")}
        ${payouts.remainder ? `<p class="remainder">Остаток при делёжке: ${formatNumber(payouts.remainder)}. Отдайте фишку первому игроку слева от баттона.</p>` : ""}
      </div>`);
  }

  if (totalPots === 0) results.insertAdjacentHTML("beforeend", `<div class="warning-card">Не удалось сформировать банк. Проверьте суммы.</div>`);
}

function buildPayouts(pots) {
  const map = new Map();
  let remainder = 0;
  pots.forEach((pot, index) => {
    const potKey = `pot-${index}-${pot.cap}-${pot.amount}`;
    const winnerIds = state.potWinners[potKey] || [];
    if (!winnerIds.length) return;
    const share = Math.floor(pot.amount / winnerIds.length);
    remainder += pot.amount - share * winnerIds.length;
    winnerIds.forEach((id) => {
      const player = state.players.find((item) => item.id === id);
      if (!player) return;
      map.set(id, { name: player.name || "Без имени", amount: (map.get(id)?.amount || 0) + share });
    });
  });
  return { rows: [...map.values()], remainder };
}

function toggleWinner(potKey, playerId) {
  const winners = new Set(state.potWinners[potKey] || []);
  winners.has(playerId) ? winners.delete(playerId) : winners.add(playerId);
  state.potWinners[potKey] = [...winners];
  calculateSidePots();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function showView(name) {
  $$(".view").forEach((view) => view.classList.toggle("is-active", view.dataset.view === name));
  $$(".nav-button").forEach((button) => button.classList.toggle("is-active", button.dataset.target === name));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 1900);
}

function bindEvents() {
  $$(".nav-button").forEach((button) => button.addEventListener("click", () => showView(button.dataset.target)));
  $("#playButton").addEventListener("click", toggleTimer);
  $("#minusMinute").addEventListener("click", () => adjustMinute(-1));
  $("#plusMinute").addEventListener("click", () => adjustMinute(1));
  $("#previousLevel").addEventListener("click", () => changeLevel(-1));
  $("#nextLevel").addEventListener("click", () => changeLevel(1));
  $("#resetLevel").addEventListener("click", resetCurrentLevel);
  $("#soundButton").addEventListener("click", () => {
    state.sound = !state.sound;
    if (state.sound) { unlockAudio(); tone(660, .12, .05); }
    saveState();
    renderClock();
    showToast(state.sound ? "Звук включён" : "Звук выключен");
  });
  $("#startingStack").addEventListener("change", (event) => {
    state.startingStack = Math.max(1, Number(event.target.value) || 3000);
    saveState();
    renderClock();
  });
  $("#scheduleList").addEventListener("change", (event) => {
    const input = event.target.closest("[data-stage-index]");
    if (input) updateStage(Number(input.dataset.stageIndex), input.dataset.stageKey, input.value);
  });
  $("#scheduleList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-stage]");
    if (button) deleteStage(Number(button.dataset.deleteStage));
  });
  $("#addLevel").addEventListener("click", () => addStage("level"));
  $("#addBreak").addEventListener("click", () => addStage("break"));
  $("#resetStructure").addEventListener("click", resetStructure);
  $("#addPlayer").addEventListener("click", addPlayer);
  $("#clearAllin").addEventListener("click", clearAllin);
  $("#calculatePots").addEventListener("click", () => { state.potWinners = {}; calculateSidePots(); });
  $("#playerRows").addEventListener("input", updatePlayerFromInput);
  $("#playerRows").addEventListener("change", updatePlayerFromInput);
  $("#playerRows").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-player]");
    if (!button) return;
    state.players = state.players.filter((player) => player.id !== button.dataset.removePlayer);
    state.potWinners = {};
    saveState();
    renderPlayers();
  });
  $("#calculationResults").addEventListener("click", (event) => {
    const button = event.target.closest("[data-pot-key]");
    if (button) toggleWinner(button.dataset.potKey, button.dataset.winnerId);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      resumeFromBackground();
    }
  });
  window.addEventListener("pagehide", () => writeLocalSnapshot());
}

function updatePlayerFromInput(event) {
  const target = event.target;
  const id = target.dataset.playerName || target.dataset.playerAmount || target.dataset.playerActive;
  if (!id) return;
  const player = state.players.find((item) => item.id === id);
  if (!player) return;
  if (target.dataset.playerName) player.name = target.value;
  if (target.dataset.playerAmount) player.amount = Math.max(0, Number(target.value) || 0);
  if (target.dataset.playerActive) player.active = target.checked;
  state.potWinners = {};
  saveState();
}

function initialize() {
  reconcileRunningTimer();
  if (saved.remainingMs == null && !state.running) state.remainingMs = stageDurationMs();
  bindEvents();
  renderClock();
  renderSchedule();
  renderPlayers();
  initializeTelegram();
  setInterval(timerTick, 250);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
}

initialize();

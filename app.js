const STORAGE_KEY = "poker-dealer-clock-v1";
const TELEGRAM_STORAGE_KEY = "poker_clock_state_v2";
const telegramSdk = window.Telegram?.WebApp || null;
const telegram = telegramSdk && (telegramSdk.initData || (telegramSdk.platform && telegramSdk.platform !== "unknown")) ? telegramSdk : null;

const DEFAULT_CHIPS = [25, 100, 500, 1000, 5000];
const DEFAULT_CHIP_INVENTORY = [
  { denomination: 25, count: 100 },
  { denomination: 100, count: 100 },
  { denomination: 500, count: 50 },
  { denomination: 1000, count: 25 },
  { denomination: 5000, count: 10 }
];
const AUTO_STRUCTURE_VERSION = 3;

function normalizeChipDenominations(value) {
  const source = Array.isArray(value) ? value : String(value || "").match(/\d+/g) || [];
  const chips = [...new Set(source.map(Number).filter((item) => Number.isFinite(item) && item > 0))].sort((a, b) => a - b);
  return chips.length ? chips : [...DEFAULT_CHIPS];
}

function normalizeChipInventory(value, legacyDenominations) {
  const source = Array.isArray(value) && value.length
    ? value
    : Array.isArray(legacyDenominations) && legacyDenominations.length
      ? normalizeChipDenominations(legacyDenominations).map((denomination) => ({ denomination, count: 50 }))
      : structuredClone(DEFAULT_CHIP_INVENTORY);
  const merged = new Map();
  source.forEach((item) => {
    const rawDenomination = Number(item?.denomination ?? item?.value ?? item);
    if (!Number.isFinite(rawDenomination) || rawDenomination <= 0) return;
    const denomination = Math.floor(rawDenomination);
    const count = Math.max(0, Math.floor(Number(item?.count) || 0));
    if (denomination) merged.set(denomination, (merged.get(denomination) || 0) + count);
  });
  const inventory = [...merged].map(([denomination, count]) => ({ denomination, count })).sort((a, b) => a.denomination - b.denomination);
  return inventory.length ? inventory : structuredClone(DEFAULT_CHIP_INVENTORY);
}

function availableChipDenominations(inventory) {
  const available = inventory.filter((item) => item.count > 0).map((item) => item.denomination);
  return available.length ? available : inventory.map((item) => item.denomination);
}

function gcd(a, b) {
  let left = Math.abs(Number(a) || 0);
  let right = Math.abs(Number(b) || 0);
  while (right) [left, right] = [right, left % right];
  return left;
}

function allocationUtility(rank, quantity, denominationCount) {
  const desired = [10, 8, 4, 2][rank] || 0;
  const useful = Math.min(quantity, desired) * (denominationCount - rank) * 25;
  const excess = Math.max(0, quantity - desired) * 3;
  const reservePenalty = rank >= Math.max(2, denominationCount - 2) ? quantity * 45 : 0;
  return useful - excess - reservePenalty;
}

function calculateStartingAllocation(startingStack, playerCount, inventory) {
  const stack = Math.max(1, Math.floor(Number(startingStack) || 0));
  const players = Math.max(1, Math.floor(Number(playerCount) || 1));
  const chips = normalizeChipInventory(inventory);
  const unit = chips.reduce((current, item) => gcd(current, item.denomination), 0) || 1;
  const divisible = stack % unit === 0;
  const target = Math.floor(stack / unit);
  let states = new Map([[0, { score: 0, counts: [] }]]);

  chips.forEach((chip, rank) => {
    const value = chip.denomination / unit;
    const cap = Math.min(Math.floor(chip.count / players), Math.floor(stack / chip.denomination));
    const previous = [...states.entries()];
    const next = new Map(states);
    previous.forEach(([amount, candidate]) => {
      for (let quantity = 1; quantity <= cap; quantity += 1) {
        const nextAmount = amount + value * quantity;
        if (nextAmount > target) break;
        const score = candidate.score + allocationUtility(rank, quantity, chips.length);
        const existing = next.get(nextAmount);
        if (!existing || score > existing.score) {
          const counts = [...candidate.counts];
          counts[rank] = quantity;
          next.set(nextAmount, { score, counts });
        }
      }
    });
    states = next;
  });

  const exact = divisible && states.has(target);
  const reached = exact ? target : Math.max(...states.keys());
  const winner = states.get(reached) || { counts: [] };
  const items = chips.map((chip, index) => {
    const perPlayer = winner.counts[index] || 0;
    const issued = perPlayer * players;
    return { ...chip, perPlayer, issued, reserve: chip.count - issued };
  });
  return {
    exact,
    stackPerPlayer: reached * unit,
    shortfall: Math.max(0, stack - reached * unit),
    items,
    totalIssued: reached * unit * players,
    reserveValue: items.reduce((sum, item) => sum + item.reserve * item.denomination, 0)
  };
}

function chipUnitForTarget(targetBb, chips) {
  const options = chips.filter((chip) => chip <= targetBb / 4);
  return options[options.length - 1] || chips[0];
}

function requiredUnitForLevels(levels, chips) {
  const amounts = levels.flatMap((stage) => [stage.sb, stage.bb, stage.ante].filter((amount) => amount > 0));
  const options = chips.filter((chip) => amounts.every((amount) => amount % chip === 0));
  return options[options.length - 1] || chips[0];
}

function usefulChipsForBlock(levels, chips, startingStack = 0) {
  const maxBb = Math.max(...levels.map((stage) => Number(stage.bb) || 0), chips[0]);
  const usefulLimit = Math.max(maxBb * 4, startingStack / 6);
  return chips.filter((chip) => chip <= usefulLimit);
}

function annotateChipChanges(stages, chips, startingStack, initialInPlay = null) {
  const firstBreakIndex = stages.findIndex((stage) => stage.type === "break");
  const firstBlock = stages.slice(0, firstBreakIndex < 0 ? stages.length : firstBreakIndex).filter((stage) => stage.type === "level");
  let inPlay = new Set(initialInPlay?.length ? initialInPlay : usefulChipsForBlock(firstBlock, chips, startingStack));

  stages.forEach((stage, index) => {
    if (stage.type !== "break") return;
    const nextBreakOffset = stages.slice(index + 1).findIndex((item) => item.type === "break");
    const blockEnd = nextBreakOffset < 0 ? stages.length : index + 1 + nextBreakOffset;
    const nextBlock = stages.slice(index + 1, blockEnd).filter((item) => item.type === "level");
    const requiredUnit = requiredUnitForLevels(nextBlock, chips);
    const chipOut = [...inPlay].filter((chip) => chip < requiredUnit);
    chipOut.forEach((chip) => inPlay.delete(chip));
    const useful = usefulChipsForBlock(nextBlock, chips);
    const chipIn = useful.filter((chip) => chip >= requiredUnit && !inPlay.has(chip));
    chipIn.forEach((chip) => inPlay.add(chip));
    stage.chipOut = chipOut;
    stage.chipIn = chipIn;
  });
  return stages;
}

function buildAutomaticStructure(startingStack, hours, anteEnabled = false, chipDenominations = DEFAULT_CHIPS, initialInPlay = null) {
  const stack = Math.max(100, Number(startingStack) || 3000);
  const selectedHours = Math.min(6, Math.max(3, Number(hours) || 4));
  const chips = normalizeChipDenominations(chipDenominations);
  const levelCount = selectedHours * 4;
  const levelDuration = selectedHours * 60 / levelCount;
  const smallestChip = chips[0];
  const firstUnit = chipUnitForTarget(Math.max(smallestChip * 2, stack / 60), chips);
  const firstBb = Math.max(smallestChip * 2, Math.round((stack / 60) / firstUnit) * firstUnit);
  const finalTarget = Math.max(firstBb * 2, stack * 2);
  const ratio = Math.pow(finalTarget / firstBb, 1 / Math.max(1, levelCount - 1));
  const stages = [];
  let previousBb = 0;

  for (let index = 0; index < levelCount; index += 1) {
    const targetBb = index === levelCount - 1 ? finalTarget : firstBb * Math.pow(ratio, index);
    const unit = chipUnitForTarget(targetBb, chips);
    let bb = Math.max(unit * 2, Math.round(targetBb / unit) * unit);
    if (bb <= previousBb) bb = Math.ceil((previousBb + unit) / unit) * unit;
    const sb = Math.max(unit, Math.floor((bb / 2) / unit) * unit);
    stages.push({ type: "level", duration: levelDuration, sb, bb, ante: anteEnabled ? bb : 0 });
    previousBb = bb;
    if ((index + 1) % 4 === 0 && index < levelCount - 1) stages.push({ type: "break", duration: 10 });
  }

  return annotateChipChanges(stages, chips, stack, initialInPlay);
}

const saved = loadState();
const initialAnteEnabled = typeof saved.anteEnabled === "boolean" ? saved.anteEnabled : false;
const initialChipInventory = normalizeChipInventory(saved.chipInventory, saved.chipDenominations);
const initialChipDenominations = availableChipDenominations(initialChipInventory);
const initialPlayerCount = Math.max(2, Math.floor(Number(saved.playerCount) || 8));
const initialAutoHours = [3, 4, 5, 6].includes(Number(saved.autoHours)) ? Number(saved.autoHours) : 4;
const initialStartingStack = Number(saved.startingStack) || 3000;
const initialAllocation = calculateStartingAllocation(initialStartingStack, initialPlayerCount, initialChipInventory);
const initialInPlay = initialAllocation.items.filter((item) => item.perPlayer > 0).map((item) => item.denomination);
const initialMode = saved.structureMode === "manual" ? "manual" : "auto";
const canRestoreStructure = Array.isArray(saved.structure) && saved.structure.length && (initialMode === "manual" || Number(saved.autoStructureVersion) === AUTO_STRUCTURE_VERSION);
const initialStructure = canRestoreStructure
  ? saved.structure
  : buildAutomaticStructure(initialStartingStack, initialAutoHours, initialAnteEnabled, initialChipDenominations, initialInPlay);
initialStructure.forEach((stage) => {
  if (stage.type === "level") stage.ante = initialAnteEnabled ? Number(stage.bb) || 0 : 0;
});
const defaultStructure = buildAutomaticStructure(3000, 4, false, DEFAULT_CHIPS);
const state = {
  structure: initialStructure,
  structureMode: initialMode,
  autoStructureVersion: AUTO_STRUCTURE_VERSION,
  autoHours: initialAutoHours,
  anteEnabled: initialAnteEnabled,
  chipInventory: initialChipInventory,
  chipDenominations: initialChipDenominations,
  playerCount: initialPlayerCount,
  startingStack: initialStartingStack,
  levelIndex: canRestoreStructure ? Math.min(Number(saved.levelIndex) || 0, Math.max(0, initialStructure.length - 1)) : 0,
  remainingMs: canRestoreStructure && Number.isFinite(Number(saved.remainingMs)) ? Math.max(0, Number(saved.remainingMs)) : Math.max(1, Number(initialStructure[0]?.duration) || 20) * 60_000,
  running: canRestoreStructure && Boolean(saved.running),
  endsAt: canRestoreStructure ? Number(saved.endsAt) || null : null,
  tournamentStartedAt: canRestoreStructure ? Number(saved.tournamentStartedAt) || null : null,
  elapsedBeforeStart: canRestoreStructure ? Number(saved.elapsedBeforeStart) || 0 : 0,
  players: [],
  priorPot: 0,
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
    structureMode: state.structureMode,
    autoStructureVersion: state.autoStructureVersion,
    autoHours: state.autoHours,
    anteEnabled: state.anteEnabled,
    chipInventory: state.chipInventory,
    chipDenominations: state.chipDenominations,
    playerCount: state.playerCount,
    startingStack: state.startingStack,
    levelIndex: state.levelIndex,
    remainingMs: state.remainingMs,
    running: state.running,
    endsAt: state.endsAt,
    tournamentStartedAt: state.tournamentStartedAt,
    elapsedBeforeStart: state.elapsedBeforeStart,
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
  state.structureMode = snapshot.structureMode === "manual" ? "manual" : "auto";
  state.autoStructureVersion = AUTO_STRUCTURE_VERSION;
  state.autoHours = [3, 4, 5, 6].includes(Number(snapshot.autoHours)) ? Number(snapshot.autoHours) : 4;
  state.anteEnabled = typeof snapshot.anteEnabled === "boolean" ? snapshot.anteEnabled : false;
  state.chipInventory = normalizeChipInventory(snapshot.chipInventory, snapshot.chipDenominations);
  state.chipDenominations = availableChipDenominations(state.chipInventory);
  state.playerCount = Math.max(2, Math.floor(Number(snapshot.playerCount) || 8));
  state.startingStack = Number(snapshot.startingStack) || 3000;
  const allocation = calculateStartingAllocation(state.startingStack, state.playerCount, state.chipInventory);
  const inPlay = allocation.items.filter((item) => item.perPlayer > 0).map((item) => item.denomination);
  const restoreStructure = state.structureMode === "manual" || Number(snapshot.autoStructureVersion) === AUTO_STRUCTURE_VERSION;
  state.structure = restoreStructure
    ? snapshot.structure
    : buildAutomaticStructure(state.startingStack, state.autoHours, state.anteEnabled, state.chipDenominations, inPlay);
  state.structure.forEach((stage) => {
    if (stage.type === "level") stage.ante = state.anteEnabled ? Number(stage.bb) || 0 : 0;
  });
  state.levelIndex = restoreStructure ? clamp(Number(snapshot.levelIndex) || 0, 0, state.structure.length - 1) : 0;
  state.remainingMs = restoreStructure ? Math.max(0, Number(snapshot.remainingMs) || 0) : stageDurationMs();
  state.running = restoreStructure && Boolean(snapshot.running);
  state.endsAt = restoreStructure ? Number(snapshot.endsAt) || null : null;
  state.tournamentStartedAt = restoreStructure ? Number(snapshot.tournamentStartedAt) || null : null;
  state.elapsedBeforeStart = restoreStructure ? Number(snapshot.elapsedBeforeStart) || 0 : 0;
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
  const showChipNotice = isBreak && state.structureMode === "auto";
  $("#breakChipNotice").hidden = !showChipNotice;
  if (showChipNotice) {
    const actions = [];
    if (stage.chipOut?.length) actions.push(`вывести ${formatChipList(stage.chipOut)}`);
    if (stage.chipIn?.length) actions.push(`ввести ${formatChipList(stage.chipIn)}`);
    $("#breakChipTitle").textContent = actions.length ? "Пора обновить набор фишек" : "Состав фишек без изменений";
    $("#breakChipText").textContent = actions.length ? `${actions.join("; ")}.` : "На этом перерыве ничего выводить или вводить не нужно.";
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
      if (state.remainingMs <= 10_000 && state.remainingMs > 0) playTick();
    }
  }
  renderClock();
}

function unlockAudio() {
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === "suspended") audioContext.resume();
}

function tone(frequency, duration, gain = 0.08, delay = 0) {
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
  const editable = state.structureMode === "manual";
  let levelNumber = 0;
  state.structure.forEach((stage, index) => {
    if (stage.type === "level") levelNumber += 1;
    const item = document.createElement("div");
    item.className = `schedule-item${stage.type === "break" ? " is-break" : ""}`;
    if (stage.type === "break") {
      const chipNotes = state.structureMode === "auto" ? `
        <div class="break-chip-note">
          <strong>Замена фишек</strong>
          <span>${stage.chipOut?.length ? `Вывести: ${formatChipList(stage.chipOut)}.` : "Ничего не выводить."} ${stage.chipIn?.length ? `Ввести: ${formatChipList(stage.chipIn)}.` : "Новые номиналы не нужны."}</span>
        </div>` : "";
      item.innerHTML = `
        <div class="schedule-number">☕</div>
        <div class="break-label">Перерыв</div>
        ${compactField("Мин", stage.duration, "duration", index)}
        <button class="delete-button" data-delete-stage="${index}" type="button" aria-label="Удалить перерыв" ${editable ? "" : "disabled"}>×</button>
        ${chipNotes}`;
    } else {
      item.innerHTML = `
        <div class="schedule-number">${levelNumber}</div>
        ${compactField("SB", stage.sb, "sb", index)}
        ${compactField("BB", stage.bb, "bb", index)}
        ${compactField("Минут", stage.duration, "duration", index)}
        <button class="delete-button" data-delete-stage="${index}" type="button" aria-label="Удалить уровень" ${editable ? "" : "disabled"}>×</button>
        <div class="schedule-ante">${state.anteEnabled ? `Анте автоматически: ${formatNumber(stage.bb)}` : "Без анте"}</div>`;
    }
    container.appendChild(item);
  });
  $("#startingStack").value = state.startingStack;
  $("#playerCount").value = state.playerCount;
  $$('[data-structure-mode]').forEach((button) => button.classList.toggle("is-active", button.dataset.structureMode === state.structureMode));
  $$('[data-auto-hours]').forEach((button) => button.classList.toggle("is-active", Number(button.dataset.autoHours) === state.autoHours));
  $$('[data-ante-mode]').forEach((button) => button.classList.toggle("is-active", (button.dataset.anteMode === "on") === state.anteEnabled));
  $("#autoControls").hidden = state.structureMode !== "auto";
  $("#manualControls").hidden = state.structureMode !== "manual";
  $("#manualAddRow").hidden = state.structureMode !== "manual";
  $("#stackHint").textContent = state.structureMode === "auto"
    ? "Изменение стека сразу пересчитает всю структуру."
    : "Стек сохраняется для справки; уровни в ручном режиме не пересчитываются.";
  const gameMinutes = state.structure.filter((stage) => stage.type === "level").reduce((sum, stage) => sum + Math.max(0, Number(stage.duration) || 0), 0);
  const breakMinutes = state.structure.filter((stage) => stage.type === "break").reduce((sum, stage) => sum + Math.max(0, Number(stage.duration) || 0), 0);
  $("#autoSummary").textContent = `Стек ${formatNumber(state.startingStack)} · ${formatDurationWords(gameMinutes)} игры${breakMinutes ? ` + ${breakMinutes} мин перерывов` : ""}`;
  renderChipInventory();
}

function renderChipInventory() {
  const rows = $("#chipInventoryRows");
  rows.innerHTML = state.chipInventory.map((item, index) => `
    <div class="inventory-row">
      <input class="field-input" type="number" min="1" inputmode="numeric" value="${item.denomination}" aria-label="Номинал фишки" data-chip-denomination="${index}" />
      <input class="field-input" type="number" min="0" inputmode="numeric" value="${item.count}" aria-label="Количество фишек" data-chip-count="${index}" />
      <button class="inventory-remove" type="button" data-remove-chip="${index}" aria-label="Удалить номинал">×</button>
    </div>`).join("");

  const allocation = calculateStartingAllocation(state.startingStack, state.playerCount, state.chipInventory);
  const used = allocation.items.filter((item) => item.perPlayer > 0);
  const piecesPerPlayer = allocation.items.reduce((sum, item) => sum + item.perPlayer, 0);
  $("#initialChipPlan").textContent = allocation.exact
    ? `На старте используются номиналы: ${formatChipList(used.map((item) => item.denomination))}. Крупные неиспользованные фишки остаются в резерве для перерывов.`
    : `Из этого набора нельзя собрать каждому ровно ${formatNumber(state.startingStack)}. Ближайший одинаковый стек: ${formatNumber(allocation.stackPerPlayer)}.`;

  const result = $("#allocationResult");
  const summary = allocation.exact
    ? `<div class="allocation-summary"><strong>${formatNumber(state.startingStack)}</strong> каждому из ${state.playerCount} игроков · ${piecesPerPlayer} фишек на человека · всего выдать ${formatNumber(allocation.totalIssued)}</div>`
    : `<div class="allocation-summary is-warning">Точный стек собрать нельзя: каждому получится ${formatNumber(allocation.stackPerPlayer)}, не хватает ${formatNumber(allocation.shortfall)}. Добавьте фишки или измените стек.</div>`;
  result.innerHTML = `${summary}
    <div class="allocation-table-head"><span>Фишка</span><span>Каждому</span><span>В резерве</span></div>
    ${allocation.items.map((item) => `<div class="allocation-table-row"><strong>${formatNumber(item.denomination)}</strong><span>${item.perPlayer} шт.</span><span>${item.reserve} шт.</span></div>`).join("")}
    <div class="allocation-foot">Резерв: ${formatNumber(allocation.reserveValue)} фишек по стоимости. Он остаётся у дилера для размена и ввода крупных номиналов.</div>`;
}

function formatChipList(chips) {
  return chips.length ? chips.map(formatNumber).join(", ") : "—";
}

function pluralLevels(value) {
  const n = Math.abs(Number(value)) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return "уровней";
  if (n1 === 1) return "уровень";
  if (n1 > 1 && n1 < 5) return "уровня";
  return "уровней";
}

function formatDurationWords(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes} мин`;
  if (!minutes) return `${hours} ${hours === 1 ? "час" : hours < 5 ? "часа" : "часов"}`;
  return `${hours} ч ${minutes} мин`;
}

function compactField(label, value, key, index) {
  const disabled = state.structureMode === "manual" ? "" : "disabled";
  return `<div class="compact-field"><label>${label}</label><input type="number" min="0" inputmode="numeric" value="${Number(value) || 0}" data-stage-index="${index}" data-stage-key="${key}" ${disabled} /></div>`;
}

function updateStage(index, key, value) {
  if (state.structureMode !== "manual") return;
  const number = Math.max(key === "duration" ? 1 : 0, Number(value) || 0);
  state.structure[index][key] = number;
  if (key === "bb" && state.structure[index].type === "level") state.structure[index].ante = state.anteEnabled ? number : 0;
  if (index === state.levelIndex && key === "duration" && !state.running) {
    state.remainingMs = Math.min(state.remainingMs, stageDurationMs());
  }
  saveState();
  renderSchedule();
  renderClock();
}

function deleteStage(index) {
  if (state.structureMode !== "manual") return;
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
  if (state.structureMode !== "manual") return;
  const previousLevel = [...state.structure].reverse().find((item) => item.type === "level") || defaultStructure[0];
  state.structure.push(type === "break"
    ? { type: "break", duration: 10 }
    : { type: "level", duration: previousLevel.duration || 20, sb: previousLevel.bb, bb: previousLevel.bb * 2, ante: state.anteEnabled ? previousLevel.bb * 2 : 0 });
  saveState();
  renderSchedule();
  requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
}

function resetStructure() {
  const message = state.structureMode === "manual"
    ? "Заменить ручную структуру автоматической?"
    : "Пересчитать автоматическую структуру с текущими настройками?";
  if (!confirm(message)) return;
  applyAutomaticStructure(state.autoHours);
}

function resetTournamentProgress() {
  state.levelIndex = 0;
  state.remainingMs = stageDurationMs();
  state.running = false;
  state.endsAt = null;
  state.tournamentStartedAt = null;
  state.elapsedBeforeStart = 0;
  releaseWakeLock();
}

function applyAutomaticStructure(hours, notify = true) {
  state.structureMode = "auto";
  state.autoHours = Number(hours);
  state.autoStructureVersion = AUTO_STRUCTURE_VERSION;
  const allocation = calculateStartingAllocation(state.startingStack, state.playerCount, state.chipInventory);
  const inPlay = allocation.items.filter((item) => item.perPlayer > 0).map((item) => item.denomination);
  state.structure = buildAutomaticStructure(state.startingStack, state.autoHours, state.anteEnabled, state.chipDenominations, inPlay);
  resetTournamentProgress();
  saveState();
  renderSchedule();
  renderClock();
  updateTelegramClosingProtection();
  if (notify) showToast(`Рассчитано: ${state.autoHours} ${state.autoHours < 5 ? "часа" : "часов"} чистой игры`);
}

function setStructureMode(mode) {
  if (mode === "auto") return applyAutomaticStructure(state.autoHours);
  state.structureMode = "manual";
  saveState();
  renderSchedule();
  renderClock();
  showToast("Ручное редактирование включено");
}

function setAnteMode(enabled) {
  state.anteEnabled = Boolean(enabled);
  state.structure.forEach((stage) => {
    if (stage.type === "level") stage.ante = state.anteEnabled ? Number(stage.bb) || 0 : 0;
  });
  saveState();
  renderSchedule();
  renderClock();
  showToast(state.anteEnabled ? "Анте равно большому блайнду" : "Игра без анте");
}

function renderPlayers() {
  const container = $("#playerRows");
  container.innerHTML = "";
  $("#playersTable").hidden = state.players.length === 0;
  $("#emptyAllin").hidden = state.players.length > 0;
  state.players.forEach((player) => {
    const row = document.createElement("div");
    row.className = "player-row";
    row.innerHTML = `
      <input class="player-input" value="${escapeHtml(player.name)}" aria-label="Имя игрока" data-player-name="${player.id}" />
      <input class="player-input player-amount" type="number" min="0" inputmode="numeric" value="${Number(player.amount) || ""}" placeholder="0" aria-label="Поставил сейчас" data-player-amount="${player.id}" />
      <button class="fold-button ${player.active ? "" : "is-folded"}" type="button" data-player-fold="${player.id}" aria-pressed="${player.active ? "false" : "true"}">${player.active ? "В игре" : "Фолд"}</button>
      <button class="remove-player" type="button" data-remove-player="${player.id}" aria-label="Удалить игрока">×</button>`;
    container.appendChild(row);
  });
  $("#priorPot").value = state.priorPot || "";
}

function addPlayer() {
  const id = crypto.randomUUID();
  state.players.push({ id, name: `Игрок ${state.players.length + 1}`, amount: 0, active: true });
  renderPlayers();
  requestAnimationFrame(() => document.querySelector(`[data-player-amount="${id}"]`)?.focus());
}

function clearAllin() {
  state.players = [];
  state.priorPot = 0;
  state.potWinners = {};
  renderPlayers();
  $("#calculationResults").innerHTML = "";
}

function calculateSidePots() {
  const priorPot = Math.max(0, Math.floor(Number(state.priorPot) || 0));
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

  if (priorPot > 0 && pots.length) {
    pots[0].amount += priorPot;
    pots[0].priorPot = priorPot;
  }

  renderPotResults(players, pots, returns, warnings, priorPot);
}

function renderPotResults(players, pots, returns, warnings, priorPot = 0) {
  const totalCommitted = players.reduce((sum, player) => sum + player.amount, 0);
  const totalPots = pots.reduce((sum, pot) => sum + pot.amount, 0);
  const results = $("#calculationResults");
  results.innerHTML = `<div class="summary-line"><span>Всего в банках</span><strong>${formatNumber(totalPots)}</strong></div>`;

  warnings.forEach((warning) => results.insertAdjacentHTML("beforeend", `<div class="warning-card">${escapeHtml(warning)}</div>`));
  returns.forEach((item) => results.insertAdjacentHTML("beforeend", `<div class="return-card"><strong>${escapeHtml(item.player.name)}</strong>: вернуть недоставленную ставку <strong>${formatNumber(item.amount)}</strong></div>`));

  pots.forEach((pot, index) => {
    const potKey = `pot-${index}-${pot.cap}-${pot.amount}`;
    const selected = state.potWinners[potKey] || [];
    const card = document.createElement("article");
    card.className = "pot-card";
    card.innerHTML = `
      <div class="pot-title"><h3>${index === 0 ? "Основной банк" : `Побочный банк ${index}`}</h3><span class="pot-amount">${formatNumber(pot.amount)}</span></div>
      <p class="pot-note">${pot.priorPot ? `Включает прежний банк ${formatNumber(pot.priorPot)} · ` : ""}ставки до ${formatNumber(pot.cap)} · могут выиграть: ${pot.eligible.length ? pot.eligible.map((p) => escapeHtml(p.name)).join(", ") : "никто"}</p>
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

function commitInventoryChange() {
  state.chipInventory = normalizeChipInventory(state.chipInventory);
  state.chipDenominations = availableChipDenominations(state.chipInventory);
  if (state.structureMode === "auto") applyAutomaticStructure(state.autoHours, false);
  else {
    saveState();
    renderSchedule();
  }
}

function addChipDenomination() {
  const used = new Set(state.chipInventory.map((item) => item.denomination));
  const suggested = DEFAULT_CHIPS.find((denomination) => !used.has(denomination))
    || Math.max(...state.chipDenominations, 1) * 5;
  state.chipInventory.push({ denomination: suggested, count: 0 });
  commitInventoryChange();
  requestAnimationFrame(() => $("#chipInventoryRows .inventory-row:last-child input")?.focus());
}

function bindEvents() {
  $$(".nav-button").forEach((button) => button.addEventListener("click", () => showView(button.dataset.target)));
  $("#playButton").addEventListener("click", toggleTimer);
  $("#minusMinute").addEventListener("click", () => adjustMinute(-1));
  $("#plusMinute").addEventListener("click", () => adjustMinute(1));
  $("#previousLevel").addEventListener("click", () => changeLevel(-1));
  $("#nextLevel").addEventListener("click", () => changeLevel(1));
  $("#resetLevel").addEventListener("click", resetCurrentLevel);
  $("#startingStack").addEventListener("change", (event) => {
    state.startingStack = Math.max(100, Number(event.target.value) || 3000);
    if (state.structureMode === "auto") applyAutomaticStructure(state.autoHours);
    else {
      saveState();
      renderSchedule();
      renderClock();
    }
  });
  $("#playerCount").addEventListener("change", (event) => {
    state.playerCount = clamp(Math.floor(Number(event.target.value) || 8), 2, 100);
    if (state.structureMode === "auto") applyAutomaticStructure(state.autoHours);
    else {
      saveState();
      renderSchedule();
    }
  });
  $("#addChipDenomination").addEventListener("click", addChipDenomination);
  $("#chipInventoryRows").addEventListener("change", (event) => {
    const denominationInput = event.target.closest("[data-chip-denomination]");
    const countInput = event.target.closest("[data-chip-count]");
    if (denominationInput) state.chipInventory[Number(denominationInput.dataset.chipDenomination)].denomination = Math.max(1, Math.floor(Number(denominationInput.value) || 1));
    if (countInput) state.chipInventory[Number(countInput.dataset.chipCount)].count = Math.max(0, Math.floor(Number(countInput.value) || 0));
    if (denominationInput || countInput) commitInventoryChange();
  });
  $("#chipInventoryRows").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-chip]");
    if (!button) return;
    if (state.chipInventory.length <= 1) return showToast("Нужен хотя бы один номинал");
    state.chipInventory.splice(Number(button.dataset.removeChip), 1);
    commitInventoryChange();
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
  $$('[data-structure-mode]').forEach((button) => button.addEventListener("click", () => setStructureMode(button.dataset.structureMode)));
  $$('[data-auto-hours]').forEach((button) => button.addEventListener("click", () => applyAutomaticStructure(Number(button.dataset.autoHours))));
  $$('[data-ante-mode]').forEach((button) => button.addEventListener("click", () => setAnteMode(button.dataset.anteMode === "on")));
  $("#addPlayer").addEventListener("click", addPlayer);
  $("#clearAllin").addEventListener("click", clearAllin);
  $("#calculatePots").addEventListener("click", () => { state.potWinners = {}; calculateSidePots(); });
  $("#priorPot").addEventListener("input", (event) => {
    state.priorPot = Math.max(0, Number(event.target.value) || 0);
    state.potWinners = {};
  });
  $("#playerRows").addEventListener("input", updatePlayerFromInput);
  $("#playerRows").addEventListener("change", updatePlayerFromInput);
  $("#playerRows").addEventListener("click", (event) => {
    const foldButton = event.target.closest("[data-player-fold]");
    if (foldButton) {
      const player = state.players.find((item) => item.id === foldButton.dataset.playerFold);
      if (player) player.active = !player.active;
      state.potWinners = {};
      renderPlayers();
      return;
    }
    const button = event.target.closest("[data-remove-player]");
    if (!button) return;
    state.players = state.players.filter((player) => player.id !== button.dataset.removePlayer);
    state.potWinners = {};
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
  const id = target.dataset.playerName || target.dataset.playerAmount;
  if (!id) return;
  const player = state.players.find((item) => item.id === id);
  if (!player) return;
  if (target.dataset.playerName) player.name = target.value;
  if (target.dataset.playerAmount) player.amount = Math.max(0, Number(target.value) || 0);
  state.potWinners = {};
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
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js?v=6");
}

initialize();


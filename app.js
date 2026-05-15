import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  EmailAuthProvider,
  linkWithCredential,
  reauthenticateWithCredential,
  updatePassword
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  collection,
  query,
  where,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── CONFIG ───────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyB1ZnIU_-VywC0DI0L3iC7RE-5bxoWC948",
  authDomain: "test-ea08b.firebaseapp.com",
  projectId: "test-ea08b",
  storageBucket: "test-ea08b.firebasestorage.app",
  messagingSenderId: "1083487143750",
  appId: "1:1083487143750:web:463cebf0d5422cd8ae0747"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

// ── STATE ────────────────────────────────────────────────────
let currentUser = null;
let slotGroups = [];          // [{ id, start, end, text }]  start/end = 0-47 (half-hour index)
let originalSlotGroups = [];  // snapshot taken when a date is loaded — used by Revert
let presets = [];             // string[]
let saveTimer = null;
const _d = new Date();
const TODAY = `${_d.getFullYear()}-${String(_d.getMonth()+1).padStart(2,'0')}-${String(_d.getDate()).padStart(2,'0')}`;
let currentDate = TODAY;      // the date currently shown in the timetable
let undoStack = [];           // deep-copy snapshots, max 10
let selectedPreset = null;    // mobile tap-to-apply
let presetEditMode = false;   // mobile edit mode toggle

// ── SLOT UTILS ───────────────────────────────────────────────
function slotToTime(slot) {
  const h = String(Math.floor(slot / 2)).padStart(2, '0');
  const m = slot % 2 === 0 ? '00' : '30';
  return `${h}:${m}`;
}

function nowSlotIndex() {
  const d = new Date();
  return Math.floor((d.getHours() * 60 + d.getMinutes()) / 30);
}

// ── URL DETECTION ─────────────────────────────────────────────
function extractUrls(text) {
  return (text.match(/https?:\/\/[^\s]+/g) || []);
}

function renderLinkPills(container, text) {
  container.innerHTML = '';
  extractUrls(text).forEach(url => {
    const a = document.createElement('a');
    a.className = 'link-pill';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = '🔗 ' + url.replace(/^https?:\/\//, '').slice(0, 40) + (url.length > 50 ? '…' : '');
    a.title = url;
    container.appendChild(a);
  });
  container.style.display = container.children.length ? 'flex' : 'none';
}

function initSlotGroups() {
  slotGroups = Array.from({ length: 48 }, (_, i) => ({
    id: `g${i}_${Date.now()}`,
    start: i,
    end: i,
    text: ''
  }));
}

function pushUndo() {
  undoStack.push(JSON.parse(JSON.stringify(slotGroups)));
  if (undoStack.length > 10) undoStack.shift();
  syncUndoBtn();
}

function syncUndoBtn() {
  const btn = document.getElementById('btn-undo');
  if (!btn) return;
  btn.disabled = undoStack.length === 0;
  btn.title = undoStack.length > 0
    ? `Undo (${undoStack.length} step${undoStack.length > 1 ? 's' : ''} available)`
    : 'Nothing to undo';
}

// ── TIMETABLE RENDER ─────────────────────────────────────────
function renderTimetable() {
  const container = document.getElementById('timetable');
  container.innerHTML = '';

  const nowSlot = nowSlotIndex();

  slotGroups.forEach((group, idx) => {
    const isMerged = group.end > group.start;
    const slotCount = group.end - group.start + 1;
    const isNow = group.start <= nowSlot && nowSlot <= group.end;

    // Row
    const row = document.createElement('div');
    row.className = [
      'slot-row',
      isMerged ? 'merged' : '',
      isNow ? 'current-slot' : ''
    ].filter(Boolean).join(' ');
    row.dataset.start = group.start;
    row.dataset.end = group.end;
    row.dataset.id = group.id;
    row.style.minHeight = `${slotCount * 50}px`;

    // Time label
    const timeLabel = document.createElement('div');
    timeLabel.className = `time-label${group.start % 2 !== 0 && !isMerged ? ' half-hour' : ''}`;

    const startSpan = document.createElement('span');
    startSpan.className = 'time-start';
    startSpan.textContent = slotToTime(group.start);
    timeLabel.appendChild(startSpan);

    if (isMerged) {
      const sep = document.createElement('span');
      sep.className = 'time-sep';
      sep.textContent = '–';
      timeLabel.appendChild(sep);

      const endSpan = document.createElement('span');
      endSpan.className = 'time-end';
      endSpan.textContent = group.end === 47 ? '24:00' : slotToTime(group.end + 1);
      timeLabel.appendChild(endSpan);
    }

    // Textarea
    const textarea = document.createElement('textarea');
    textarea.className = 'slot-input';
    textarea.value = group.text;
    textarea.placeholder = 'Add task...';

    const autoResize = () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.max(slotCount * 50 - 16, textarea.scrollHeight) + 'px';
    };

    // Link pills — shown below textarea when text contains URLs
    const linkPills = document.createElement('div');
    linkPills.className = 'slot-link-pills';
    renderLinkPills(linkPills, group.text);

    textarea.addEventListener('input', () => {
      group.text = textarea.value;
      autoResize();
      renderLinkPills(linkPills, textarea.value);
      debouncedSave();
    });

    setTimeout(autoResize, 0);

    // Push undo when user starts editing a slot (once per focus, not per keystroke)
    textarea.addEventListener('focus', () => {
      if (isMobile() && selectedPreset) {
        pushUndo();
        textarea.value = textarea.value ? `${textarea.value}\n${selectedPreset}` : selectedPreset;
        group.text = textarea.value;
        autoResize();
        debouncedSave();
        clearMobilePreset();
        textarea.blur();
        return;
      }
      pushUndo();
    });

    // Drop target
    row.addEventListener('dragover', e => {
      e.preventDefault();
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', e => {
      if (!row.contains(e.relatedTarget)) row.classList.remove('drag-over');
    });
    row.addEventListener('drop', e => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const dragged = e.dataTransfer.getData('text/plain');
      if (!dragged) return;
      pushUndo();
      textarea.value = textarea.value ? `${textarea.value}\n${dragged}` : dragged;
      group.text = textarea.value;
      autoResize();
      debouncedSave();
    });

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'slot-actions';

    if (idx < slotGroups.length - 1) {
      const mergeBtn = document.createElement('button');
      mergeBtn.className = 'action-btn merge-btn';
      mergeBtn.title = 'Merge with slot below';
      mergeBtn.textContent = '⊞';
      mergeBtn.onclick = e => { e.stopPropagation(); mergeWithNext(group.id); };
      actions.appendChild(mergeBtn);
    }

    if (isMerged) {
      const splitBtn = document.createElement('button');
      splitBtn.className = 'action-btn split-btn';
      splitBtn.title = 'Split bottom row off';
      splitBtn.textContent = '✂';
      splitBtn.onclick = e => { e.stopPropagation(); splitGroup(group.id); };
      actions.appendChild(splitBtn);
    }

    const slotBody = document.createElement('div');
    slotBody.className = 'slot-body';
    slotBody.appendChild(textarea);
    slotBody.appendChild(linkPills);

    row.appendChild(timeLabel);
    row.appendChild(slotBody);
    row.appendChild(actions);
    container.appendChild(row);
  });

  // Draw the current-time red line after DOM is painted
  requestAnimationFrame(drawNowIndicator);
}

function drawNowIndicator() {
  const container = document.getElementById('timetable');
  const existing = container.querySelector('.now-indicator');
  if (existing) existing.remove();

  const now = new Date();
  const slot = nowSlotIndex();
  const minIntoSlot = (now.getHours() * 60 + now.getMinutes()) % 30;

  let targetRow = null;
  for (const row of container.querySelectorAll('.slot-row')) {
    const s = +row.dataset.start, e = +row.dataset.end;
    if (s <= slot && slot <= e) { targetRow = row; break; }
  }
  if (!targetRow) return;

  const offsetInRow = (slot - +targetRow.dataset.start) * 50 + (minIntoSlot / 30) * 50;

  const line = document.createElement('div');
  line.className = 'now-indicator';
  line.style.top = `${targetRow.offsetTop + offsetInRow}px`;
  container.appendChild(line);
}

// ── MERGE / SPLIT ────────────────────────────────────────────
function mergeWithNext(groupId) {
  const idx = slotGroups.findIndex(g => g.id === groupId);
  if (idx < 0 || idx >= slotGroups.length - 1) return;
  pushUndo();

  const curr = slotGroups[idx];
  const next = slotGroups[idx + 1];
  const combined = [curr.text, next.text].filter(Boolean).join('\n');

  slotGroups.splice(idx, 2, {
    id: curr.id,
    start: curr.start,
    end: next.end,
    text: combined
  });

  renderTimetable();
  debouncedSave();
}

function splitGroup(groupId) {
  const idx = slotGroups.findIndex(g => g.id === groupId);
  if (idx < 0) return;

  const group = slotGroups[idx];
  if (group.start === group.end) return;
  pushUndo();

  // Split off only the last half-hour row from the bottom
  slotGroups.splice(idx, 1,
    { ...group, end: group.end - 1 },
    { id: `g${group.end}_${Date.now()}`, start: group.end, end: group.end, text: '' }
  );

  renderTimetable();
  debouncedSave();
}

// ── PRESETS RENDER ───────────────────────────────────────────
function renderPresets() {
  const list = document.getElementById('preset-list');
  list.innerHTML = '';

  presets.forEach((text, idx) => {
    const item = document.createElement('div');
    item.className = 'preset-item';
    item.draggable = true;

    item.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', text);
      e.dataTransfer.effectAllowed = 'copy';
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));


    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.textContent = '⠿';
    handle.title = 'Drag to schedule';

    const label = document.createElement('span');
    label.className = 'preset-text';
    label.textContent = text;
    label.title = 'Click to edit';
    // Desktop: always edit on click
    // Mobile: handled by item click below
    label.onclick = () => { if (!isMobile()) startEditPreset(label, idx); };

    // Mobile: tap behaviour depends on edit mode
    item.addEventListener('click', e => {
      if (!isMobile()) return;
      if (e.target.closest('.preset-delete') || e.target.closest('.preset-link-btn')) return;
      if (presetEditMode) {
        startEditPreset(label, idx);
      } else {
        selectPresetMobile(text, item);
      }
    });

    // Link button — only shown if preset text is/contains a URL
    const urls = extractUrls(text);
    if (urls.length) {
      const linkBtn = document.createElement('a');
      linkBtn.className = 'preset-link-btn';
      linkBtn.href = urls[0];
      linkBtn.target = '_blank';
      linkBtn.rel = 'noopener noreferrer';
      linkBtn.textContent = '🔗';
      linkBtn.title = urls[0];
      linkBtn.onclick = e => e.stopPropagation();
      item.appendChild(linkBtn);
    }

    const del = document.createElement('button');
    del.className = 'preset-delete';
    del.textContent = '×';
    del.title = 'Delete';
    del.onclick = () => deletePreset(idx);


    item.appendChild(handle);
    item.appendChild(label);
    item.appendChild(del);
    list.appendChild(item);
  });
}

function startEditPreset(label, idx) {
  const original = label.textContent;
  const input = document.createElement('input');
  input.className = 'preset-edit-input';
  input.value = original;
  label.replaceWith(input);
  input.focus();
  input.select();

  const save = async () => {
    const newText = input.value.trim();
    if (newText && newText !== original) {
      presets[idx] = newText;
      await savePresets();
    }
    renderPresets();
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); renderPresets(); }
  });
}

window.addPreset = async function () {
  const input = document.getElementById('preset-input');
  const text = input.value.trim();
  if (!text) return;
  presets.push(text);
  input.value = '';
  renderPresets();
  await savePresets();
};

async function deletePreset(idx) {
  presets.splice(idx, 1);
  renderPresets();
  await savePresets();
}

// ── FIRESTORE ────────────────────────────────────────────────
async function saveTimetable() {
  if (!currentUser) return;
  await setDoc(doc(db, 'timetables', `${currentUser.uid}_${currentDate}`), {
    groups: slotGroups,
    updatedAt: new Date()
  });
}

async function loadTimetable() {
  await loadDateTimetable(TODAY);
}

// Load (or create) the timetable for any date string "YYYY-MM-DD"
async function loadDateTimetable(date) {
  currentDate = date;
  undoStack = [];
  syncUndoBtn();
  updateViewingUI(date);

  const snap = await getDoc(doc(db, 'timetables', `${currentUser.uid}_${date}`));
  slotGroups = snap.exists() && snap.data().groups?.length ? snap.data().groups : null;
  if (!slotGroups) initSlotGroups();

  // Snapshot for Button B (Revert)
  originalSlotGroups = JSON.parse(JSON.stringify(slotGroups));

  renderTimetable();
  if (date === TODAY) scrollToNow();
}

// Update header title + button states based on which date is shown
function updateViewingUI(date) {
  const isToday = date === TODAY;

  // Panel title
  const title = document.getElementById('schedule-title');
  if (title) {
    if (isToday) {
      title.textContent = "Today's Schedule";
    } else {
      // Parse as local noon to avoid DST shifts
      const d = new Date(`${date}T12:00:00`);
      title.textContent = d.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
      });
    }
  }

  // Amber background when viewing another day
  const header = document.querySelector('.timetable-header');
  if (header) header.classList.toggle('viewing-other', !isToday);

  // Button C disabled when already on today
  const btnToday = document.getElementById('btn-today');
  if (btnToday) btnToday.disabled = isToday;
}

async function savePresets() {
  if (!currentUser) return;
  await setDoc(doc(db, 'users', currentUser.uid), { presets }, { merge: true });
}

async function loadPresets() {
  const snap = await getDoc(doc(db, 'users', currentUser.uid));
  presets = snap.exists() && snap.data().presets ? snap.data().presets : [];
  renderPresets();
}

function debouncedSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveTimetable, 800);
}

function scrollToNow() {
  const slot = nowSlotIndex();
  setTimeout(() => {
    for (const row of document.querySelectorAll('.slot-row')) {
      if (+row.dataset.start <= slot && slot <= +row.dataset.end) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        break;
      }
    }
  }, 150);
}

// Refresh now-indicator every minute without re-rendering the full table
setInterval(() => { if (currentUser) drawNowIndicator(); }, 60_000);

// ── UNDO ─────────────────────────────────────────────────────
window.undoTimetable = function () {
  if (!undoStack.length) return;
  slotGroups = undoStack.pop();
  syncUndoBtn();
  renderTimetable();
  debouncedSave();
};

// ── BUTTON A — date picker ───────────────────────────────────
window.openDatePicker = function () {
  const picker = document.getElementById('date-picker');
  picker.value = currentDate;
  picker.showPicker();
};

// Called by the hidden input's onchange
window.onDatePicked = async function (value) {
  if (value && value !== currentDate) await loadDateTimetable(value);
};

// ── BUTTON B — revert to the state when this date was loaded ─
window.revertTimetable = function () {
  clearTimeout(saveTimer);
  slotGroups = JSON.parse(JSON.stringify(originalSlotGroups));
  renderTimetable();
  saveTimetable(); // persist the reverted state
};

// ── BUTTON C — back to today ─────────────────────────────────
window.goToToday = async function () {
  if (currentDate !== TODAY) await loadDateTimetable(TODAY);
};

// ── MOBILE UTILS ─────────────────────────────────────────────
function isMobile() { return window.innerWidth <= 768; }

// ── PRESET EDIT MODE (mobile) ────────────────────────────────
window.togglePresetEditMode = function () {
  presetEditMode = !presetEditMode;
  const btn = document.getElementById('preset-edit-btn');
  btn.classList.toggle('active', presetEditMode);
  const hint = document.getElementById('presets-hint-mobile');
  if (hint) hint.textContent = presetEditMode
    ? 'Tap item to edit text'
    : 'Tap item to apply · ✏️ to edit';
  // Deselect any pending apply
  if (!presetEditMode) clearMobilePreset();
};

// ── TAP-TO-APPLY (mobile, edit mode OFF) ─────────────────────
window.clearMobilePreset = function () {
  selectedPreset = null;
  document.querySelectorAll('.preset-item.mobile-selected')
    .forEach(el => el.classList.remove('mobile-selected'));
  document.getElementById('mobile-preset-hint')?.classList.add('hidden');
};

function selectPresetMobile(text, itemEl) {
  if (selectedPreset === text) { clearMobilePreset(); return; }
  clearMobilePreset();
  selectedPreset = text;
  itemEl.classList.add('mobile-selected');
  document.getElementById('mobile-preset-name').textContent = `"${text}"`;
  document.getElementById('mobile-preset-hint').classList.remove('hidden');
  closePresetSheet();
}

// ── BOTTOM SHEET ─────────────────────────────────────────────
window.openPresetSheet = function () {
  document.getElementById('presets-panel').classList.add('sheet-open');
  document.getElementById('sheet-backdrop').classList.add('active');
  document.getElementById('tab-presets').classList.add('active');
  document.getElementById('tab-schedule').classList.remove('active');
};

window.closePresetSheet = function () {
  document.getElementById('presets-panel').classList.remove('sheet-open');
  document.getElementById('sheet-backdrop').classList.remove('active');
  document.getElementById('tab-schedule').classList.add('active');
  document.getElementById('tab-presets').classList.remove('active');
};

// ── TOUCH DRAG (mobile: drag preset → drop on timetable slot) ─
let touchDragText    = null;
let touchDragGhost   = null;
let touchDropTarget  = null;

function startTouchDrag(text, touch) {
  touchDragText = text;
  touchDragGhost = document.createElement('div');
  touchDragGhost.className = 'drag-ghost';
  touchDragGhost.textContent = text;
  document.body.appendChild(touchDragGhost);
  moveTouchGhost(touch);
}

function moveTouchGhost(touch) {
  if (!touchDragGhost) return;
  touchDragGhost.style.left = touch.clientX + 'px';
  touchDragGhost.style.top  = touch.clientY + 'px';
  // Find slot row under finger
  touchDragGhost.style.visibility = 'hidden';
  const el = document.elementFromPoint(touch.clientX, touch.clientY);
  touchDragGhost.style.visibility = '';
  const row = el?.closest('.slot-row');
  if (touchDropTarget !== row) {
    touchDropTarget?.classList.remove('drag-over');
    touchDropTarget = row;
    row?.classList.add('drag-over');
  }
}

function endTouchDrag(touch) {
  touchDragGhost?.remove();
  touchDragGhost = null;
  touchDropTarget?.classList.remove('drag-over');
  touchDropTarget = null;

  if (touch && touchDragText) {
    // Use final finger position to find drop target
    const el  = document.elementFromPoint(touch.clientX, touch.clientY);
    const row = el?.closest('.slot-row');
    if (row) {
      const group = slotGroups.find(g => g.id === row.dataset.id);
      if (group) {
        pushUndo();
        group.text = group.text ? `${group.text}\n${touchDragText}` : touchDragText;
        renderTimetable();
        debouncedSave();
      }
    }
  }
  touchDragText = null;
}

// ── SETTINGS POPUP ───────────────────────────────────────────
window.toggleSettings = function () {
  const popup = document.getElementById('settings-popup');
  popup.classList.toggle('hidden');
  // Clear fields & message on open
  if (!popup.classList.contains('hidden')) {
    document.getElementById('current-password-input').value = '';
    document.getElementById('new-password-input').value = '';
    document.getElementById('confirm-password-input').value = '';
    setPasswordMsg('', '');
  }
};

// Close popup when clicking outside
document.addEventListener('click', e => {
  const wrap = document.getElementById('settings-popup')?.closest('.user-menu-wrap');
  if (wrap && !wrap.contains(e.target)) {
    document.getElementById('settings-popup')?.classList.add('hidden');
  }
});

window.savePassword = async function () {
  const newPw      = document.getElementById('new-password-input').value;
  const confirmPw  = document.getElementById('confirm-password-input').value;
  const currentPw  = document.getElementById('current-password-input').value;
  const user       = auth.currentUser;

  if (!newPw || newPw.length < 6) return setPasswordMsg('Min 6 characters.', 'error');
  if (newPw !== confirmPw)        return setPasswordMsg('Passwords do not match.', 'error');

  const hasPassword = user.providerData.some(p => p.providerId === 'password');

  try {
    if (hasPassword) {
      // Re-authenticate first, then update
      const cred = EmailAuthProvider.credential(user.email, currentPw);
      await reauthenticateWithCredential(user, cred);
      await updatePassword(user, newPw);
    } else {
      // Google user — link email/password to existing account
      const cred = EmailAuthProvider.credential(user.email, newPw);
      await linkWithCredential(user, cred);
      // Show current password field for future changes
      document.getElementById('current-password-input').classList.remove('hidden');
      document.getElementById('password-section-title').textContent = 'Change Password';
    }
    setPasswordMsg('Password saved!', 'success');
    document.getElementById('new-password-input').value = '';
    document.getElementById('confirm-password-input').value = '';
    document.getElementById('current-password-input').value = '';
  } catch (err) {
    const msgs = {
      'auth/wrong-password':       'Current password incorrect.',
      'auth/weak-password':        'Min 6 characters.',
      'auth/requires-recent-login':'Please logout and login again first.',
    };
    setPasswordMsg(msgs[err.code] || err.message, 'error');
  }
};

function setPasswordMsg(text, type) {
  const el = document.getElementById('password-msg');
  el.textContent = text;
  el.className = `settings-msg ${type}`;
}

// ── GOOGLE SIGN-IN ───────────────────────────────────────────
window.signInWithGoogle = async function () {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    const user = result.user;

    // If new Google user, create their Firestore record
    const userRef = doc(db, 'users', user.uid);
    const snap = await getDoc(userRef);
    if (!snap.exists()) {
      await setDoc(userRef, {
        email: user.email,
        name: user.displayName || '',
        createdAt: new Date()
      });
    }
    // onAuthStateChanged handles redirect to dashboard
  } catch (err) {
    if (err.code !== 'auth/popup-closed-by-user') {
      alert('Google sign-in failed: ' + err.message);
    }
  }
};

// ── AUTH ─────────────────────────────────────────────────────
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}
window.showLogin = () => showPage('login-page');
window.showRegister = () => showPage('register-page');

onAuthStateChanged(auth, async user => {
  if (user) {
    currentUser = user;
    document.getElementById('user-email').textContent = user.email;
    document.getElementById('settings-email-label').textContent = user.email;
    // Show "Current password" field only if user already has a password
    const hasPassword = user.providerData.some(p => p.providerId === 'password');
    const currentPwInput = document.getElementById('current-password-input');
    const pwTitle = document.getElementById('password-section-title');
    if (hasPassword) {
      currentPwInput.classList.remove('hidden');
      pwTitle.textContent = 'Change Password';
    } else {
      currentPwInput.classList.add('hidden');
      pwTitle.textContent = 'Set Password';
    }
    document.getElementById('today-label').textContent = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    showPage('dashboard-page');
    await Promise.all([loadTimetable(), loadPresets()]);
  } else {
    currentUser = null;
    showPage('login-page');
  }
});

window.login = async function () {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';
  try {
    const snap = await getDocs(query(collection(db, 'users'), where('email', '==', email)));
    if (snap.empty) {
      errorEl.textContent = 'No account found with this email (case-sensitive).';
      return;
    }
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    errorEl.textContent = friendlyError(err.code);
  }
};

window.register = async function () {
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const errorEl = document.getElementById('register-error');
  errorEl.textContent = '';
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await setDoc(doc(db, 'users', cred.user.uid), {
      email,
      createdAt: new Date(),
      presets: []
    });
  } catch (err) {
    errorEl.textContent = friendlyError(err.code);
  }
};

window.logout = async function () { await signOut(auth); };

function friendlyError(code) {
  return ({
    'auth/invalid-email':        'Invalid email address.',
    'auth/user-not-found':       'No account found with this email.',
    'auth/wrong-password':       'Incorrect password.',
    'auth/email-already-in-use': 'This email is already registered.',
    'auth/weak-password':        'Password must be at least 6 characters.',
    'auth/too-many-requests':    'Too many attempts. Please try again later.',
    'auth/invalid-credential':   'Invalid email or password.',
  })[code] ?? 'Something went wrong. Please try again.';
}

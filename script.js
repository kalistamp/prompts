/* ============================================================
   PROMPT STUDIO — UI

   Owns the view state and the DOM. All persistence goes through
   PromptCloud; all model calls go through PromptRunner; all
   per-device settings through PromptSettings.

   FOUR SECTIONS, ONE MARKUP TREE
     Library and Scratch are the same list+detail component with
     different retention chrome, so switching between them swaps the
     data and not the DOM. Workshop and History are their own views.
     Layout is switched by CSS at 700 and 1024 only — there is no
     user-agent sniffing and no second set of mobile markup.

   No inline event handlers anywhere; every listener is attached here.
   ============================================================ */

(function () {
  'use strict';

  const Cloud = window.PromptCloud;
  const Runner = window.PromptRunner;
  const Settings = window.PromptSettings;
  const Diff = window.PromptDiff;

  // ─────────────────────────────────────────────
  // VIEW STATE
  // ─────────────────────────────────────────────

  const prefs = Settings.readPrefs();

  const state = {
    section: 'library',
    search: '',
    category: '',
    sort: prefs.sort,
    view: prefs.view,
    pinnedOnly: false,
    selectedPromptId: null,
    expandedIds: new Set(),
    collapsedCategories: new Set(loadCollapsed()),

    // Workshop
    metaPromptId: null,
    running: false,
    abortController: null,
    lastRun: null,

    // History
    selectMode: false,
    selectedRunIds: new Set(),
    historyRange: 'all',
    historyProvider: '',
    historyStatus: '',
    historyUnsavedOnly: false,

    pendingConfirm: null,
    pendingRunDelete: null,
    paletteIndex: 0,
    paletteItems: [],

    // Versions
    versionsPromptId: null,
    versions: [],
    selectedVersionId: null
  };

  function loadCollapsed() {
    try {
      const raw = JSON.parse(localStorage.getItem('ps.collapsed.v1') || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  }

  function saveCollapsed() {
    try {
      localStorage.setItem('ps.collapsed.v1', JSON.stringify([...state.collapsedCategories]));
    } catch (e) { /* private mode */ }
  }

  // ─────────────────────────────────────────────
  // DOM
  // ─────────────────────────────────────────────

  const $ = id => document.getElementById(id);

  const el = {
    authScreen: $('auth-screen'),
    appContainer: $('app-container'),
    loginForm: $('login-form'),
    loginEmail: $('login-email'),
    loginPassword: $('login-password'),
    loginError: $('login-error'),
    loginSubmit: $('login-submit'),

    sidebar: $('workspace-sidebar'),
    sidebarBackdrop: $('sidebar-backdrop'),
    sidebarCloseBtn: $('sidebar-close-btn'),
    mobileMenuBtn: $('mobile-menu-btn'),
    sidebarCategories: $('sidebar-categories'),
    sidebarSyncBtn: $('sidebar-sync-btn'),
    sidebarSyncLabel: $('sidebar-sync-label'),
    sidebarAccountEmail: $('sidebar-account-email'),
    sidebarSettingsBtn: $('sidebar-settings-btn'),

    contextEyebrow: $('context-eyebrow'),
    viewTitle: $('current-view-title'),
    resultCount: $('current-result-count'),
    searchBar: $('search-bar'),
    searchInput: $('search-input'),
    clearSearchBtn: $('clear-search-btn'),
    saveState: $('save-state'),
    saveStateLabel: $('save-state-label'),
    themeToggle: $('theme-toggle'),
    syncBtn: $('sync-btn'),
    settingsBtn: $('settings-btn'),

    viewList: $('view-list'),
    viewWorkshop: $('view-workshop'),
    viewHistory: $('view-history'),
    categoryFilter: $('category-filter'),
    sortSelect: $('sort-select'),
    promptsContainer: $('prompts-container'),
    detailPanel: $('detail-panel'),
    detailEmpty: $('detail-empty'),
    detailContent: $('detail-content'),
    categoryList: $('category-list'),

    workshopList: $('workshop-list'),
    workshopSelectedName: $('workshop-selected-name'),
    workshopInput: $('workshop-input'),
    workshopModelLabel: $('workshop-model-label'),
    workshopClearBtn: $('workshop-clear-btn'),
    workshopRunBtn: $('workshop-run-btn'),
    workshopStopBtn: $('workshop-stop-btn'),
    workshopOutputPane: $('workshop-output-pane'),
    workshopOutputBack: $('workshop-output-back'),
    workshopOutput: $('workshop-output'),
    workshopReceipt: $('workshop-receipt'),
    workshopOutputActions: $('workshop-output-actions'),
    workshopCopyBtn: $('workshop-copy-btn'),
    workshopSaveLibraryBtn: $('workshop-save-library-btn'),
    workshopSaveScratchBtn: $('workshop-save-scratch-btn'),
    workshopDiscardBtn: $('workshop-discard-btn'),

    historyRange: $('history-range'),
    historyProvider: $('history-provider'),
    historyStatus: $('history-status'),
    historyUnsaved: $('history-unsaved'),
    historySelectBtn: $('history-select-btn'),
    historySelectionBar: $('history-selection-bar'),
    historySelectAll: $('history-select-all'),
    historySelectionCount: $('history-selection-count'),
    historyCancelSelect: $('history-cancel-select'),
    historyDeleteBtn: $('history-delete-btn'),
    historyList: $('history-list'),

    promptDialog: $('prompt-dialog'),
    promptDialogTitle: $('prompt-dialog-title'),
    promptForm: $('prompt-form'),
    promptTitle: $('prompt-title'),
    promptSection: $('prompt-section'),
    promptCategory: $('prompt-category'),
    promptTags: $('prompt-tags'),
    promptText: $('prompt-text'),
    promptNotes: $('prompt-notes'),
    editorCount: $('editor-count'),
    workshopHint: $('workshop-hint'),

    settingsDialog: $('settings-dialog'),
    accountEmail: $('account-email'),
    cloudStatus: $('cloud-status'),
    settingsProvider: $('settings-provider'),
    providerRows: $('provider-rows'),
    settingsEffort: $('settings-effort'),
    settingsMaxTokens: $('settings-max-tokens'),
    settingsScratchDays: $('settings-scratch-days'),
    settingsRunsDays: $('settings-runs-days'),
    sweepSummary: $('sweep-summary'),
    runSweepBtn: $('run-sweep-btn'),
    exportBtn: $('export-btn'),
    signOutBtn: $('sign-out-btn'),

    confirmDialog: $('confirm-dialog'),
    confirmTitle: $('confirm-title'),
    confirmDescription: $('confirm-description'),
    confirmAcceptBtn: $('confirm-accept-btn'),

    runDialog: $('run-dialog'),
    runDialogTitle: $('run-dialog-title'),
    runDetailBody: $('run-detail-body'),
    runCopyInput: $('run-copy-input'),
    runCopyOutput: $('run-copy-output'),

    paletteDialog: $('palette-dialog'),
    paletteInput: $('palette-input'),
    paletteResults: $('palette-results'),

    versionsDialog: $('versions-dialog'),
    versionsTitle: $('versions-title'),
    versionsList: $('versions-list'),
    versionsDiff: $('versions-diff'),
    versionsSummary: $('versions-summary'),
    versionCopyBtn: $('version-copy-btn'),
    versionRestoreBtn: $('version-restore-btn'),

    importFile: $('import-file'),
    importPasteBtn: $('import-paste-btn'),
    importPasteWrap: $('import-paste-wrap'),
    importText: $('import-text'),
    importTextBtn: $('import-text-btn'),
    importNote: $('import-note')

    // The FAB and the mobile tab bar are deliberately absent. Both are
    // driven by delegated listeners keyed on data-open-prompt and
    // data-section, so holding a reference to either would be a lookup
    // nothing reads — the exact shape of the dead v1 toolbar button.
  };

  // Editor state, separate from view state because it only exists
  // while the prompt dialog is open.
  let editState = { editing: false, id: null };

  // ─────────────────────────────────────────────
  // UTILITIES
  // ─────────────────────────────────────────────

  function escapeHtml(unsafe) {
    if (unsafe === null || unsafe === undefined) return '';
    return String(unsafe)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function showToast(message, actionLabel, onAction) {
    let toast = $('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = message;
    toast.appendChild(span);
    if (actionLabel && onAction) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'toast-action';
      button.textContent = actionLabel;
      button.addEventListener('click', () => {
        toast.classList.remove('show');
        onAction();
      });
      toast.appendChild(button);
    }
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), actionLabel ? 5000 : 3000);
  }

  // Single source of truth for the desktop breakpoint. The CSS uses
  // 1024 for the two-pane layout; if one moves the other must too.
  function isDesktop() {
    return window.matchMedia('(min-width: 1024px)').matches;
  }

  function isPhone() {
    return window.matchMedia('(max-width: 699px)').matches;
  }

  function formatDate(ms) {
    if (!ms) return '';
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatDateTime(ms) {
    if (!ms) return '';
    return new Date(ms).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  function counts(text) {
    const chars = (text || '').length;
    const tokens = Math.max(1, Math.round(chars / 4));
    return `${chars.toLocaleString()} chars · ~${tokens.toLocaleString()} tokens`;
  }

  function formatCost(value) {
    const n = Number(value) || 0;
    if (n === 0) return '$0';
    if (n < 0.01) return `$${n.toFixed(4)}`;
    return `$${n.toFixed(3)}`;
  }

  function copyText(text, label) {
    navigator.clipboard.writeText(text)
      .then(() => showToast(label || 'Copied to clipboard.'))
      .catch(() => showToast('Unable to copy. Select the text and copy it manually.'));
  }

  // ─────────────────────────────────────────────
  // DIALOG HELPERS
  // ─────────────────────────────────────────────

  // Native <dialog> gives the focus trap, Esc handling and inert
  // background for free — the v1 hand-rolled versions of all three
  // are gone.
  function openDialog(dialog, preferredFocus) {
    if (!dialog || dialog.open) return;
    dialog.showModal();
    requestAnimationFrame(() => {
      const target = preferredFocus || dialog.querySelector('input, textarea, select, button');
      if (target) target.focus();
    });
  }

  function closeDialog(dialog) {
    if (dialog && dialog.open) dialog.close();
  }

  // Drag-down-to-dismiss on the phone bottom sheets.
  function wireSheetDrag(dialog) {
    const handle = dialog.querySelector('[data-sheet-drag]');
    const inner = dialog.querySelector('.sheet-inner');
    if (!handle || !inner) return;
    let startY = 0;
    let delta = 0;
    let dragging = false;

    handle.addEventListener('pointerdown', event => {
      if (!isPhone()) return;
      dragging = true;
      startY = event.clientY;
      delta = 0;
      inner.style.transition = 'none';
      try { handle.setPointerCapture(event.pointerId); } catch (e) { /* older browsers */ }
    });

    handle.addEventListener('pointermove', event => {
      if (!dragging) return;
      delta = Math.max(0, event.clientY - startY);
      inner.style.transform = `translateY(${delta}px)`;
    });

    function end() {
      if (!dragging) return;
      dragging = false;
      inner.style.transition = '';
      inner.style.transform = '';
      if (delta > 110) closeDialog(dialog);
    }

    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  [el.promptDialog, el.settingsDialog, el.confirmDialog, el.runDialog].forEach(wireSheetDrag);

  // Backdrop click closes. A <dialog> reports clicks on its backdrop
  // as clicks on the dialog element itself, so compare the target.
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('click', event => {
      if (event.target === dialog) closeDialog(dialog);
    });
  });

  document.addEventListener('click', event => {
    const closer = event.target.closest('[data-close-dialog]');
    if (closer) {
      const dialog = closer.closest('dialog');
      closeDialog(dialog);
    }
  });

  function confirmAction({ title, description, confirmLabel, onConfirm }) {
    el.confirmTitle.textContent = title;
    el.confirmDescription.textContent = description;
    el.confirmAcceptBtn.innerHTML = `<i class="fas fa-trash"></i> ${escapeHtml(confirmLabel || 'Delete')}`;
    state.pendingConfirm = onConfirm;
    openDialog(el.confirmDialog, el.confirmAcceptBtn);
  }

  el.confirmAcceptBtn.addEventListener('click', () => {
    const action = state.pendingConfirm;
    state.pendingConfirm = null;
    closeDialog(el.confirmDialog);
    if (action) action();
  });

  el.confirmDialog.addEventListener('close', () => { state.pendingConfirm = null; });

  // ─────────────────────────────────────────────
  // THEME
  // ─────────────────────────────────────────────

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const isDark = theme === 'dark';
    el.themeToggle.innerHTML = `<i class="fas fa-${isDark ? 'sun' : 'moon'}"></i>`;
    el.themeToggle.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = isDark ? '#0b1120' : '#f5f7fb';
  }

  el.themeToggle.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    Settings.writePrefs({ theme: next });
    applyTheme(next);
  });

  // ─────────────────────────────────────────────
  // SECTIONS
  // ─────────────────────────────────────────────

  const SECTION_META = {
    library:  { title: 'Library',  eyebrow: 'Long-term prompts',  view: 'list' },
    workshop: { title: 'Workshop', eyebrow: 'Meta-prompts and runs', view: 'workshop' },
    scratch:  { title: 'Scratch',  eyebrow: 'One-time drafts',    view: 'list' },
    history:  { title: 'History',  eyebrow: 'Every API run',      view: 'history' }
  };

  function setSection(section) {
    if (!SECTION_META[section]) return;
    state.section = section;
    state.selectedPromptId = null;
    state.pinnedOnly = false;
    state.category = '';
    el.categoryFilter.value = '';
    Settings.writePrefs({ section });

    document.body.className = document.body.className
      .replace(/\bsection-\w+\b/g, '').trim();
    document.body.classList.add(`section-${section}`);

    const meta = SECTION_META[section];
    el.viewList.hidden = meta.view !== 'list';
    el.viewWorkshop.hidden = meta.view !== 'workshop';
    el.viewHistory.hidden = meta.view !== 'history';
    el.searchBar.hidden = section === 'history';

    document.querySelectorAll('[data-section]').forEach(button => {
      button.classList.toggle('active', button.dataset.section === section);
    });

    closeSidebar();
    render();
  }

  // ─────────────────────────────────────────────
  // RENDER — top level
  // ─────────────────────────────────────────────

  function render() {
    const all = Cloud.getPrompts();
    const runs = Cloud.getRuns();

    $('count-library').textContent = all.filter(p => p.section === 'library').length;
    $('count-workshop').textContent = all.filter(p => p.section === 'workshop').length;
    $('count-scratch').textContent = all.filter(p => p.section === 'scratch').length;
    $('count-history').textContent = runs.length;
    $('count-pinned').textContent = all.filter(p => p.pinned).length;

    const meta = SECTION_META[state.section];
    el.contextEyebrow.textContent = meta.eyebrow;

    if (meta.view === 'list') renderList();
    else if (meta.view === 'workshop') renderWorkshop();
    else renderHistory();

    populateCategories();
  }

  function sectionPrompts() {
    return Cloud.getPrompts().filter(p => p.section === state.section);
  }

  function filteredPrompts() {
    const term = state.search.trim().toLowerCase();
    return sectionPrompts().filter(p => {
      const matchesSearch = !term ||
        p.title.toLowerCase().includes(term) ||
        p.text.toLowerCase().includes(term) ||
        p.category.toLowerCase().includes(term) ||
        p.notes.toLowerCase().includes(term) ||
        (p.tags || []).some(t => t.toLowerCase().includes(term));
      const matchesCategory = !state.category || p.category === state.category;
      const matchesPinned = !state.pinnedOnly || p.pinned;
      return matchesSearch && matchesCategory && matchesPinned;
    });
  }

  function sortPrompts(list) {
    const sort = state.sort;
    return list.sort((a, b) => {
      if (sort === 'date-desc') return b.updatedAt - a.updatedAt;
      if (sort === 'date-asc') return a.updatedAt - b.updatedAt;
      if (sort === 'name-asc') return a.title.localeCompare(b.title);
      if (sort === 'name-desc') return b.title.localeCompare(a.title);
      if (sort === 'custom') return (a.order || 0) - (b.order || 0);
      return 0;
    });
  }

  // ─────────────────────────────────────────────
  // RENDER — list (Library / Scratch)
  // ─────────────────────────────────────────────

  function renderList() {
    const filtered = filteredPrompts();
    const isFiltering = Boolean(state.search.trim() || state.category || state.pinnedOnly);
    // Reordering only makes sense on an unfiltered list — reordering a
    // subset would silently move the hidden items too.
    const canReorder = state.sort === 'custom' && !isFiltering;

    el.viewTitle.textContent = state.pinnedOnly
      ? `${SECTION_META[state.section].title} · Pinned`
      : (state.category || SECTION_META[state.section].title);
    el.resultCount.textContent = filtered.length;

    el.promptsContainer.innerHTML = '';

    if (state.selectedPromptId && !filtered.some(p => p.id === state.selectedPromptId)) {
      state.selectedPromptId = null;
    }
    if (!state.selectedPromptId && filtered.length && isDesktop()) {
      state.selectedPromptId = filtered[0].id;
    }

    if (!filtered.length) {
      const first = sectionPrompts().length === 0;
      el.promptsContainer.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon"><i class="fas fa-${first ? 'wand-magic-sparkles' : 'magnifying-glass'}"></i></div>
          <h2>${first ? `Nothing in ${escapeHtml(SECTION_META[state.section].title)} yet` : 'No matching prompts'}</h2>
          <p>${first
            ? (state.section === 'workshop'
              ? 'Meta-prompts live here — the prompts that engineer your other prompts.'
              : 'Build a private, searchable library of the prompts you use most.')
            : 'Try another search, category, or view.'}</p>
          ${first
            ? '<button class="btn" type="button" data-open-prompt><i class="fas fa-plus"></i> New prompt</button>'
            : '<button class="btn btn-secondary" type="button" data-action="clear-filters"><i class="fas fa-xmark"></i> Clear filters</button>'}
        </div>`;
      renderDetail();
      return;
    }

    if (state.sort === 'custom') {
      const hint = document.createElement('div');
      hint.className = 'reorder-hint';
      hint.innerHTML = isFiltering
        ? '<i class="fas fa-circle-info"></i> Clear search and category filters to reorder prompts.'
        : '<i class="fas fa-grip-vertical"></i> Drag the handle — or use the up/down arrows — to reorder within a category. Saved automatically.';
      el.promptsContainer.appendChild(hint);
    }

    const pinned = filtered.filter(p => p.pinned);
    if (pinned.length && !state.pinnedOnly) {
      el.promptsContainer.appendChild(
        buildCategorySection('Pinned', sortPrompts(pinned.slice()), false, isFiltering, 'pinned-section')
      );
    }

    const grouped = {};
    filtered.forEach(p => {
      const cat = p.category || 'Uncategorized';
      (grouped[cat] = grouped[cat] || []).push(p);
    });

    Object.keys(grouped).sort((a, b) => {
      if (a === 'Uncategorized') return 1;
      if (b === 'Uncategorized') return -1;
      return a.localeCompare(b);
    }).forEach(cat => {
      el.promptsContainer.appendChild(
        buildCategorySection(cat, sortPrompts(grouped[cat]), canReorder, isFiltering, '')
      );
    });

    renderDetail();
  }

  function buildCategorySection(cat, list, canReorder, isFiltering, extraClass) {
    const section = document.createElement('div');
    section.className = 'category-section' + (extraClass ? ' ' + extraClass : '');
    const isOpen = isFiltering || !state.collapsedCategories.has(cat);
    if (isOpen) section.classList.add('expanded');

    const contentId = `cat-${String(cat).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${list[0] ? list[0].id : 'empty'}`;

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'category-header';
    header.setAttribute('aria-expanded', String(isOpen));
    header.setAttribute('aria-controls', contentId);
    header.innerHTML = `
      <i class="fas fa-chevron-right arrow-icon"></i>
      <h2>${escapeHtml(cat)}</h2>
      <span class="category-count">${list.length}</span>`;
    header.addEventListener('click', () => {
      const nowOpen = section.classList.toggle('expanded');
      header.setAttribute('aria-expanded', String(nowOpen));
      if (nowOpen) state.collapsedCategories.delete(cat);
      else state.collapsedCategories.add(cat);
      saveCollapsed();
    });

    const content = document.createElement('div');
    content.className = 'category-content';
    content.id = contentId;
    const inner = document.createElement('div');
    inner.className = 'category-content-inner';
    const grid = document.createElement('div');
    grid.className = 'prompts-grid view-' + state.view;

    list.forEach((p, index) => grid.appendChild(createItem(p, cat, canReorder, index, list.length)));

    inner.appendChild(grid);
    content.appendChild(inner);
    section.appendChild(header);
    section.appendChild(content);
    return section;
  }

  function bodyNeedsToggle(text) {
    if (!text) return false;
    const breaks = (text.match(/\n/g) || []).length;
    if (state.view === 'compact') return text.length > 60 || breaks >= 1;
    if (state.view === 'list') return text.length > 170 || breaks >= 3;
    return text.length > 300 || breaks >= 5;
  }

  function expiryChip(prompt) {
    if (prompt.section !== 'scratch' || !prompt.expiresAt) return '';
    const remaining = prompt.expiresAt - Date.now();
    if (remaining <= 0) return '<span class="expiry-chip is-expired">Expired</span>';
    const days = Math.ceil(remaining / 86400000);
    return `<span class="expiry-chip">Expires in ${days}d</span>`;
  }

  function createItem(p, cat, canReorder, index, total) {
    const item = document.createElement('div');
    item.className = 'prompt-item';
    item.dataset.id = p.id;
    item.dataset.category = cat;
    if (state.selectedPromptId === p.id) item.classList.add('is-selected');
    if (state.expandedIds.has(p.id)) item.classList.add('is-expanded');

    const tagsHtml = (p.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
    const updated = formatDate(p.updatedAt);
    const largeView = state.view === 'large';
    const countText = counts(p.text);

    const reorderBtns = canReorder ? `
      <button class="tool-btn" data-action="move" data-id="${p.id}" data-direction="-1" title="Move up" aria-label="Move up" ${index === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
      <button class="tool-btn" data-action="move" data-id="${p.id}" data-direction="1" title="Move down" aria-label="Move down" ${index === total - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button>` : '';

    const pinBtn = `<button class="tool-btn pin-btn${p.pinned ? ' pinned' : ''}" data-action="pin" data-id="${p.id}" title="${p.pinned ? 'Unpin' : 'Pin to top'}" aria-label="${p.pinned ? 'Unpin' : 'Pin to top'}" aria-pressed="${p.pinned ? 'true' : 'false'}"><i class="${p.pinned ? 'fas' : 'far'} fa-star"></i></button>`;
    const copyInTools = largeView ? '' : `<button class="tool-btn" data-action="copy" data-id="${p.id}" title="Copy" aria-label="Copy ${escapeHtml(p.title)}"><i class="fas fa-copy"></i></button>`;

    item.innerHTML = `
      <div class="item-top">
        ${canReorder ? '<button class="drag-handle" aria-label="Drag to reorder" title="Drag to reorder"><i class="fas fa-grip-vertical"></i></button>' : ''}
        <button class="prompt-open" type="button" data-action="open" data-id="${p.id}" aria-label="Open ${escapeHtml(p.title)}">
          <span class="item-head">
            <span class="item-title">${escapeHtml(p.title)}</span>
            ${!largeView && updated ? `<span class="item-meta">${escapeHtml(updated)}</span>` : ''}
            ${!largeView ? `<span class="item-meta item-counts">${escapeHtml(countText)}</span>` : ''}
          </span>
        </button>
        <div class="item-tools">
          ${reorderBtns}
          ${pinBtn}
          ${copyInTools}
          <button class="tool-btn" data-action="edit" data-id="${p.id}" title="Edit" aria-label="Edit ${escapeHtml(p.title)}"><i class="fas fa-pen"></i></button>
          <button class="tool-btn danger" data-action="delete" data-id="${p.id}" title="Delete" aria-label="Delete ${escapeHtml(p.title)}"><i class="fas fa-trash"></i></button>
        </div>
      </div>
      ${tagsHtml || expiryChip(p) ? `<div class="item-tags">${tagsHtml}${expiryChip(p)}</div>` : ''}
      <div class="prompt-body">${escapeHtml(p.text)}</div>
      ${bodyNeedsToggle(p.text) ? `<button class="preview-toggle" data-action="expand" data-id="${p.id}">${state.expandedIds.has(p.id)
        ? '<i class="fas fa-chevron-up"></i> Show less'
        : '<i class="fas fa-chevron-down"></i> Show more'}</button>` : ''}
      ${largeView ? `<div class="item-footer">
        <button class="copy-btn" data-action="copy" data-id="${p.id}" aria-label="Copy ${escapeHtml(p.title)}"><i class="fas fa-copy"></i> Copy</button>
        <span class="item-meta"><span class="item-counts">${escapeHtml(countText)}</span>${updated ? ` · Updated ${escapeHtml(updated)}` : ''}</span>
      </div>` : ''}`;

    if (canReorder) {
      const handle = item.querySelector('.drag-handle');
      if (handle) handle.addEventListener('pointerdown', e => startDrag(e, item, p.id, cat));
    }
    return item;
  }

  function renderDetail() {
    const prompt = Cloud.getPrompts().find(p => p.id === state.selectedPromptId);
    if (!prompt) {
      el.detailEmpty.hidden = false;
      el.detailContent.hidden = true;
      el.detailContent.innerHTML = '';
      return;
    }

    const tags = (prompt.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
    el.detailEmpty.hidden = true;
    el.detailContent.hidden = false;
    el.detailContent.innerHTML = `
      <div class="detail-mobile-header">
        <button class="detail-back" type="button" data-detail-action="close"><i class="fas fa-chevron-left"></i> Back</button>
        <button class="icon-btn" type="button" data-detail-action="edit" aria-label="Edit"><i class="fas fa-pen"></i></button>
      </div>
      <div class="detail-kicker">
        <span class="detail-category">${escapeHtml(prompt.category || 'Uncategorized')}</span>
        <button class="tool-btn pin-btn${prompt.pinned ? ' pinned' : ''}" type="button" data-detail-action="pin" aria-label="${prompt.pinned ? 'Unpin' : 'Pin'}" aria-pressed="${prompt.pinned ? 'true' : 'false'}"><i class="${prompt.pinned ? 'fas' : 'far'} fa-star"></i></button>
      </div>
      <h2 class="detail-title">${escapeHtml(prompt.title)}</h2>
      ${tags || expiryChip(prompt) ? `<div class="detail-tags">${tags}${expiryChip(prompt)}</div>` : ''}
      <div class="detail-meta">
        <span><i class="far fa-clock"></i> Updated ${escapeHtml(formatDate(prompt.updatedAt))}</span>
        <span><i class="far fa-calendar"></i> Created ${escapeHtml(formatDate(prompt.createdAt))}</span>
        <span class="item-counts"><i class="fas fa-text-width"></i> ${escapeHtml(counts(prompt.text))}</span>
      </div>
      <p class="detail-prompt-label">Prompt</p>
      <div class="detail-prompt">${escapeHtml(prompt.text)}</div>
      ${prompt.notes ? `<div class="detail-notes"><p class="detail-notes-label">Notes</p>${escapeHtml(prompt.notes)}</div>` : ''}
      <div class="detail-actions">
        <button class="btn" type="button" data-detail-action="copy"><i class="fas fa-copy"></i> Copy prompt</button>
        ${prompt.section !== 'workshop'
          ? '<button class="btn btn-secondary" type="button" data-detail-action="to-workshop"><i class="fas fa-screwdriver-wrench"></i> Move to Workshop</button>'
          : '<button class="btn btn-secondary" type="button" data-detail-action="use"><i class="fas fa-play"></i> Use in Workshop</button>'}
        <button class="icon-btn" type="button" data-detail-action="versions" aria-label="Version history" title="Version history"><i class="fas fa-clock-rotate-left"></i></button>
        <button class="icon-btn" type="button" data-detail-action="edit" aria-label="Edit"><i class="fas fa-pen"></i></button>
        <button class="icon-btn danger" type="button" data-detail-action="delete" aria-label="Delete"><i class="fas fa-trash"></i></button>
      </div>`;
  }

  function openPromptDetail(id) {
    if (!Cloud.getPrompts().some(p => p.id === id)) return;
    state.selectedPromptId = id;
    el.promptsContainer.querySelectorAll('.prompt-item').forEach(item => {
      item.classList.toggle('is-selected', Number(item.dataset.id) === id);
    });
    renderDetail();
    el.detailPanel.classList.add('is-open');
    el.detailPanel.scrollTop = 0;
  }

  function closePromptDetail() {
    el.detailPanel.classList.remove('is-open');
  }

  // ─────────────────────────────────────────────
  // CATEGORIES
  // ─────────────────────────────────────────────

  function populateCategories() {
    const list = sectionPrompts();
    const categories = [...new Set(list.map(p => p.category).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));

    el.categoryList.innerHTML = '';
    [...new Set(Cloud.getPrompts().map(p => p.category).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b))
      .forEach(c => {
        const option = document.createElement('option');
        option.value = c;
        el.categoryList.appendChild(option);
      });

    const current = el.categoryFilter.value;
    el.categoryFilter.innerHTML = '<option value="">All categories</option>';
    categories.forEach(c => {
      const option = document.createElement('option');
      option.value = c;
      option.textContent = c;
      el.categoryFilter.appendChild(option);
    });
    el.categoryFilter.value = categories.includes(current) ? current : '';

    el.sidebarCategories.innerHTML = '';
    categories.forEach(category => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'nav-item' + (state.category === category ? ' active' : '');
      button.dataset.category = category;
      button.innerHTML = '<span><i class="fas fa-folder"></i><span class="nav-category-name"></span></span><span class="nav-count"></span>';
      button.querySelector('.nav-category-name').textContent = category;
      button.querySelector('.nav-count').textContent = list.filter(p => p.category === category).length;
      el.sidebarCategories.appendChild(button);
    });
  }

  // ─────────────────────────────────────────────
  // PROMPT ACTIONS
  // ─────────────────────────────────────────────

  function scratchExpiry() {
    const days = Cloud.getSettings().scratchRetentionDays;
    return days === null ? null : Date.now() + days * 86400000;
  }

  /* `previous` is the state before this edit. When it is supplied and
     the content actually changed, a snapshot is filed for the version
     history. Pin, reorder and expiry changes pass nothing, so a drag
     or a star never buries the real edits. The snapshot is fire and
     forget — it must never delay or block the save itself. */
  function savePrompt(prompt, previous) {
    Cloud.upsertPromptLocal(prompt);
    Cloud.savePrompts([prompt]);
    if (previous) {
      Cloud.recordVersion(previous, prompt)
        .catch(error => console.error('[ui] could not record version', error));
    }
  }

  function togglePin(id) {
    const prompt = Cloud.getPrompts().find(p => p.id === id);
    if (!prompt) return;
    prompt.pinned = !prompt.pinned;
    prompt.updatedAt = Date.now();
    savePrompt(prompt);
    render();
    showToast(prompt.pinned ? 'Pinned to top.' : 'Unpinned.');
  }

  function copyPrompt(id) {
    const prompt = Cloud.getPrompts().find(p => p.id === id);
    if (prompt) copyText(prompt.text, 'Prompt copied.');
  }

  function deletePrompt(id) {
    const prompt = Cloud.getPrompts().find(p => p.id === id);
    if (!prompt) return;
    confirmAction({
      title: `Delete “${prompt.title}”?`,
      description: 'This removes the prompt from every synced device. It cannot be undone.',
      confirmLabel: 'Delete prompt',
      onConfirm: () => {
        Cloud.removePromptLocal(id);
        Cloud.savePrompts([], [{ id, deletedAt: Date.now(), revision: prompt.revision || 0 }]);
        // prompt_items deletes are tombstones, so no database cascade
        // reaches the version snapshots. Clear them here or they
        // outlive the prompt they belong to.
        Cloud.deleteVersionsFor(id)
          .catch(error => console.error('[ui] could not clear versions', error));
        state.expandedIds.delete(id);
        if (state.selectedPromptId === id) {
          state.selectedPromptId = null;
          closePromptDetail();
        }
        render();
        showToast('Prompt deleted.');
      }
    });
  }

  function movePromptToSection(id, section) {
    const prompt = Cloud.getPrompts().find(p => p.id === id);
    if (!prompt) return;
    const previous = { ...prompt };
    prompt.section = section;
    prompt.expiresAt = section === 'scratch' ? scratchExpiry() : null;
    prompt.updatedAt = Date.now();
    savePrompt(prompt, previous);
    render();
    showToast(`Moved to ${SECTION_META[section].title}.`);
  }

  function openPromptEditor(id, sectionHint) {
    el.promptForm.reset();
    if (id) {
      const prompt = Cloud.getPrompts().find(p => p.id === id);
      if (!prompt) return;
      editState = { editing: true, id };
      el.promptDialogTitle.textContent = 'Edit prompt';
      el.promptTitle.value = prompt.title;
      el.promptSection.value = prompt.section;
      el.promptCategory.value = prompt.category || '';
      el.promptTags.value = (prompt.tags || []).join(', ');
      el.promptText.value = prompt.text;
      el.promptNotes.value = prompt.notes || '';
    } else {
      editState = { editing: false, id: null };
      el.promptDialogTitle.textContent = 'Add new prompt';
      const fallback = state.section === 'history' ? 'library' : state.section;
      el.promptSection.value = sectionHint || fallback;
    }
    updateEditorMeta();
    openDialog(el.promptDialog, el.promptTitle);
  }

  function updateEditorMeta() {
    el.editorCount.textContent = `${el.promptText.value.length.toLocaleString()} characters`;
    el.workshopHint.hidden = el.promptSection.value !== 'workshop';
  }

  el.promptText.addEventListener('input', updateEditorMeta);
  el.promptSection.addEventListener('change', updateEditorMeta);

  el.promptForm.addEventListener('submit', event => {
    event.preventDefault();
    const section = Cloud.safeSection(el.promptSection.value);
    const data = {
      title: el.promptTitle.value.trim(),
      category: el.promptCategory.value.trim(),
      tags: el.promptTags.value.split(',').map(t => t.trim()).filter(Boolean),
      text: el.promptText.value.trim(),
      notes: el.promptNotes.value.trim(),
      section,
      updatedAt: Date.now()
    };

    let saved;
    let previous = null;
    if (editState.editing) {
      const existing = Cloud.getPrompts().find(p => p.id === editState.id);
      if (!existing) return;
      // Copied before the spread below, because `existing` is the
      // live object in the store and upsertPromptLocal is about to
      // replace it — the pre-edit state has to be captured here or
      // it is gone by the time the version is written.
      previous = { ...existing };
      saved = { ...existing, ...data };
      // Entering Scratch starts the clock; leaving it clears the clock.
      if (section === 'scratch' && !existing.expiresAt) saved.expiresAt = scratchExpiry();
      if (section !== 'scratch') saved.expiresAt = null;
    } else {
      const id = Cloud.newId();
      saved = {
        ...data,
        id,
        createdAt: id,
        order: id,
        pinned: false,
        revision: 0,
        expiresAt: section === 'scratch' ? scratchExpiry() : null,
        runConfig: null
      };
    }

    savePrompt(saved, previous);
    state.selectedPromptId = saved.id;
    closeDialog(el.promptDialog);

    if (saved.section !== state.section && SECTION_META[saved.section]) setSection(saved.section);
    else render();

    if (!isDesktop()) openPromptDetail(saved.id);
  });

  // ─────────────────────────────────────────────
  // REORDER
  // ─────────────────────────────────────────────

  /* Pointer Events rather than the HTML5 drag API, because HTML5
     drag does not fire on touchscreens. touch-action:none on the
     handle stops the page scrolling mid-drag. */
  let dragState = null;

  function startDrag(event, item, id, category) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    dragState = { item, id, category, container: item.parentElement, pointerId: event.pointerId };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch (e) { /* older browsers */ }
    item.classList.add('dragging');
    document.body.classList.add('is-dragging');
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);
  }

  function onDragMove(event) {
    if (!dragState) return;
    event.preventDefault();
    const below = document.elementFromPoint(event.clientX, event.clientY);
    if (!below) return;
    const target = below.closest('.prompt-item');
    if (!target || target === dragState.item) return;
    if (target.parentElement !== dragState.container) return;
    if (target.dataset.category !== String(dragState.category)) return;
    const rect = target.getBoundingClientRect();
    const before = (event.clientY - rect.top) < rect.height / 2;
    dragState.container.insertBefore(dragState.item, before ? target : target.nextSibling);
  }

  function endDrag() {
    if (!dragState) return;
    const { item, container, category } = dragState;
    item.classList.remove('dragging');
    document.body.classList.remove('is-dragging');
    document.removeEventListener('pointermove', onDragMove);
    document.removeEventListener('pointerup', endDrag);
    document.removeEventListener('pointercancel', endDrag);
    const ordered = Array.from(container.querySelectorAll('.prompt-item')).map(n => Number(n.dataset.id));
    dragState = null;
    commitOrder(category, ordered);
  }

  // Persists only rows whose order actually changed, so reordering
  // one category never rewrites unrelated prompts.
  function commitOrder(category, orderedIds) {
    const indexById = new Map(orderedIds.map((id, i) => [id, i]));
    const changedAt = Date.now();
    const changed = [];
    sectionPrompts().forEach(p => {
      if ((p.category || 'Uncategorized') === category && indexById.has(p.id)) {
        const next = indexById.get(p.id);
        if (p.order !== next) {
          p.order = next;
          p.updatedAt = changedAt;
          changed.push(p);
        }
      }
    });
    if (changed.length) Cloud.savePrompts(changed);
    render();
  }

  function movePrompt(id, direction) {
    const prompt = Cloud.getPrompts().find(p => p.id === id);
    if (!prompt) return;
    const category = prompt.category || 'Uncategorized';
    const list = sectionPrompts()
      .filter(p => (p.category || 'Uncategorized') === category)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    const index = list.findIndex(p => p.id === id);
    const swap = index + direction;
    if (swap < 0 || swap >= list.length) return;

    const tmp = list[index].order;
    list[index].order = list[swap].order;
    list[swap].order = tmp;
    const changedAt = Date.now();
    list[index].updatedAt = changedAt;
    list[swap].updatedAt = changedAt;
    Cloud.savePrompts([list[index], list[swap]]);
    render();
  }

  // ─────────────────────────────────────────────
  // WORKSHOP
  // ─────────────────────────────────────────────

  function metaPrompts() {
    return Cloud.getPrompts()
      .filter(p => p.section === 'workshop')
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  function renderWorkshop() {
    const list = metaPrompts();
    el.viewTitle.textContent = 'Workshop';
    el.resultCount.textContent = list.length;

    if (state.metaPromptId && !list.some(p => p.id === state.metaPromptId)) {
      state.metaPromptId = null;
    }
    if (!state.metaPromptId && list.length) state.metaPromptId = list[0].id;

    el.workshopList.innerHTML = '';
    if (!list.length) {
      el.workshopList.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon"><i class="fas fa-screwdriver-wrench"></i></div>
          <h2>No meta-prompts yet</h2>
          <p>A meta-prompt is the prompt that writes your prompts. Create one to start running.</p>
          <button class="btn" type="button" data-open-prompt data-section-hint="workshop"><i class="fas fa-plus"></i> New meta-prompt</button>
        </div>`;
    } else {
      list.forEach(p => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'workshop-item' + (p.id === state.metaPromptId ? ' is-selected' : '');
        button.dataset.metaId = p.id;
        const title = document.createElement('strong');
        title.textContent = p.title;
        const sub = document.createElement('span');
        sub.textContent = p.text.replace(/\s+/g, ' ').slice(0, 90);
        button.appendChild(title);
        button.appendChild(sub);
        el.workshopList.appendChild(button);
      });
    }

    const selected = list.find(p => p.id === state.metaPromptId);
    el.workshopSelectedName.textContent = selected ? selected.title : 'No meta-prompt selected';

    const creds = Settings.readCredentials();
    const providerMeta = Settings.PROVIDERS[creds.provider];
    const model = Settings.resolveModel(creds.provider, creds);
    const hasKey = Boolean(creds.keys[creds.provider]);
    el.workshopModelLabel.textContent = hasKey
      ? `${providerMeta.label} · ${model}`
      : `${providerMeta.label} · no API key`;
    el.workshopRunBtn.disabled = !selected || !hasKey || state.running;
  }

  function setRunning(running) {
    state.running = running;
    el.workshopRunBtn.hidden = running;
    el.workshopStopBtn.hidden = !running;
    el.workshopInput.disabled = running;
    el.workshopRunBtn.disabled = running;
  }

  async function runWorkshop() {
    const meta = Cloud.getPrompts().find(p => p.id === state.metaPromptId);
    if (!meta) { showToast('Pick a meta-prompt first.'); return; }
    const input = el.workshopInput.value;

    const creds = Settings.readCredentials();
    if (!creds.keys[creds.provider]) {
      showToast('Add an API key in Settings first.');
      openSettings();
      return;
    }

    state.lastRun = null;
    el.workshopOutput.textContent = '';
    el.workshopOutput.classList.add('is-streaming');
    el.workshopOutputActions.hidden = true;
    el.workshopReceipt.textContent = 'Running…';
    if (isPhone()) el.workshopOutputPane.classList.add('is-open');
    setRunning(true);

    state.abortController = new AbortController();
    const startedAt = Date.now();
    let receipt = null;
    let failure = null;

    try {
      receipt = await Runner.run({
        metaPromptText: meta.text,
        input,
        maxTokens: Cloud.getSettings().defaultMaxTokens,
        signal: state.abortController.signal,
        onDelta: chunk => {
          el.workshopOutput.textContent += chunk;
          el.workshopOutput.scrollTop = el.workshopOutput.scrollHeight;
        }
      });
    } catch (error) {
      failure = error;
    } finally {
      setRunning(false);
      state.abortController = null;
      el.workshopOutput.classList.remove('is-streaming');
    }

    const aborted = failure && failure.name === 'AbortError';

    if (failure && !aborted) {
      el.workshopOutput.textContent = '';
      const box = document.createElement('div');
      box.className = 'run-error';
      const strong = document.createElement('strong');
      strong.textContent = failure.message || 'The run failed.';
      box.appendChild(strong);
      if (failure.hint) {
        const span = document.createElement('span');
        span.textContent = failure.hint;
        box.appendChild(span);
      }
      el.workshopOutput.appendChild(box);
      el.workshopReceipt.textContent = 'Failed';
    }

    if (aborted) {
      el.workshopReceipt.textContent = 'Stopped';
      showToast('Run stopped.');
    }

    // A history row is written for success AND failure. A run that
    // errored is exactly the one you want to find later.
    if (!aborted) {
      const creds2 = Settings.readCredentials();
      const record = {
        id: Cloud.newId(),
        metaPromptId: meta.id,
        metaPromptTitle: meta.title,
        provider: receipt ? receipt.provider : creds2.provider,
        requestedModel: receipt ? receipt.requestedModel : Settings.resolveModel(creds2.provider, creds2),
        servedModel: receipt ? receipt.servedModel : '',
        responseId: receipt ? receipt.responseId : '',
        promptVersion: receipt ? receipt.promptVersion : Runner.PROMPT_VERSION,
        input,
        output: receipt ? receipt.text : '',
        status: receipt ? 'ok' : 'error',
        errorMessage: failure ? String(failure.message || '') : '',
        inputTokens: receipt ? receipt.inputTokens : 0,
        outputTokens: receipt ? receipt.outputTokens : 0,
        costUsd: receipt ? receipt.costUsd : 0,
        durationMs: receipt ? receipt.durationMs : Date.now() - startedAt,
        keep: false,
        savedPromptId: null,
        createdAt: Date.now()
      };

      try {
        state.lastRun = await Cloud.saveRun(record);
      } catch (error) {
        console.error('[ui] could not record the run', error);
        state.lastRun = record;
        showToast('The run finished but could not be saved to History.');
      }
    }

    if (receipt) {
      const swapped = receipt.servedModel && receipt.servedModel !== receipt.requestedModel;
      el.workshopReceipt.textContent = [
        receipt.servedModel || receipt.requestedModel,
        `${receipt.inputTokens.toLocaleString()}→${receipt.outputTokens.toLocaleString()} tok`,
        receipt.priced ? formatCost(receipt.costUsd) : 'unpriced',
        `${(receipt.durationMs / 1000).toFixed(1)}s`
      ].join(' · ') + (swapped ? ' (swapped)' : '');
      el.workshopOutputActions.hidden = false;
    }

    render();
  }

  function saveRunOutput(section) {
    if (!state.lastRun || !state.lastRun.output) return;
    const meta = Cloud.getPrompts().find(p => p.id === state.lastRun.metaPromptId);
    const id = Cloud.newId();
    const prompt = {
      id,
      title: `${meta ? meta.title : 'Run'} — ${formatDate(Date.now())}`,
      text: state.lastRun.output,
      category: '',
      tags: [],
      notes: `From a ${state.lastRun.servedModel || state.lastRun.requestedModel} run.`,
      pinned: false,
      section,
      createdAt: id,
      updatedAt: id,
      order: id,
      revision: 0,
      expiresAt: section === 'scratch' ? scratchExpiry() : null,
      runConfig: null
    };
    savePrompt(prompt);

    // Linking the run to the saved prompt also exempts it from the
    // retention sweep — you kept the output, so the receipt stays.
    Cloud.updateRun(state.lastRun.id, { savedPromptId: id })
      .catch(error => console.error('[ui] could not link run to prompt', error));

    showToast(`Saved to ${SECTION_META[section].title}.`);
    render();
  }

  // ─────────────────────────────────────────────
  // HISTORY
  // ─────────────────────────────────────────────

  function filteredRuns() {
    const now = Date.now();
    return Cloud.getRuns().filter(run => {
      if (state.historyRange !== 'all') {
        const days = Number(state.historyRange);
        if (run.createdAt < now - days * 86400000) return false;
      }
      if (state.historyProvider && run.provider !== state.historyProvider) return false;
      if (state.historyStatus && run.status !== state.historyStatus) return false;
      if (state.historyUnsavedOnly && run.savedPromptId) return false;
      return true;
    });
  }

  function renderHistory() {
    const list = filteredRuns();
    el.viewTitle.textContent = 'History';
    el.resultCount.textContent = list.length;

    const providers = [...new Set(Cloud.getRuns().map(r => r.provider).filter(Boolean))].sort();
    const currentProvider = el.historyProvider.value;
    el.historyProvider.innerHTML = '<option value="">All providers</option>';
    providers.forEach(p => {
      const option = document.createElement('option');
      option.value = p;
      option.textContent = (Settings.PROVIDERS[p] && Settings.PROVIDERS[p].label) || p;
      el.historyProvider.appendChild(option);
    });
    el.historyProvider.value = providers.includes(currentProvider) ? currentProvider : '';

    el.historySelectionBar.hidden = !state.selectMode;
    el.historyList.innerHTML = '';

    if (!list.length) {
      el.historyList.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon"><i class="fas fa-clock-rotate-left"></i></div>
          <h2>${Cloud.getRuns().length ? 'No runs match these filters' : 'No runs yet'}</h2>
          <p>${Cloud.getRuns().length ? 'Try widening the date range or clearing a filter.' : 'Every run you make in the Workshop is recorded here — including the ones that fail.'}</p>
        </div>`;
      updateSelectionCount();
      return;
    }

    list.forEach(run => el.historyList.appendChild(createHistoryRow(run)));
    updateSelectionCount();
  }

  function createHistoryRow(run) {
    const row = document.createElement('div');
    row.className = 'history-row' + (state.selectedRunIds.has(run.id) ? ' is-selected' : '');
    row.dataset.runId = run.id;

    const parts = [];
    if (state.selectMode) {
      parts.push(`<input type="checkbox" data-run-select="${run.id}" ${state.selectedRunIds.has(run.id) ? 'checked' : ''} aria-label="Select run">`);
    }

    const snippet = (run.status === 'error' ? run.errorMessage : run.output) || run.input || '';
    const model = run.servedModel || run.requestedModel || '—';
    const swapped = run.servedModel && run.requestedModel && run.servedModel !== run.requestedModel;

    parts.push(`
      <button class="history-main" type="button" data-run-open="${run.id}">
        <span class="history-title">
          <strong>${escapeHtml(run.metaPromptTitle || 'Run')}</strong>
          <span class="history-badge ${run.status === 'error' ? 'error' : 'ok'}">${run.status === 'error' ? 'Failed' : 'OK'}</span>
          ${run.keep ? '<span class="history-badge keep">Keep</span>' : ''}
          ${run.savedPromptId ? '<span class="history-badge">Saved</span>' : ''}
        </span>
        <span class="history-snippet">${escapeHtml(snippet.replace(/\s+/g, ' ').slice(0, 220))}</span>
        <span class="history-meta">
          <span>${escapeHtml(formatDateTime(run.createdAt))}</span>
          <span>${escapeHtml(model)}${swapped ? ' (swapped)' : ''}</span>
          <span>${run.inputTokens.toLocaleString()}→${run.outputTokens.toLocaleString()} tok</span>
          <span>${escapeHtml(formatCost(run.costUsd))}</span>
          <span>${(run.durationMs / 1000).toFixed(1)}s</span>
        </span>
      </button>
      <div class="history-actions">
        <button class="tool-btn${run.keep ? ' pinned' : ''}" data-run-keep="${run.id}" title="${run.keep ? 'Stop keeping' : 'Keep — never auto-delete'}" aria-pressed="${run.keep ? 'true' : 'false'}"><i class="${run.keep ? 'fas' : 'far'} fa-bookmark"></i></button>
        <button class="tool-btn danger" data-run-delete="${run.id}" title="Delete run"><i class="fas fa-trash"></i></button>
      </div>`);

    row.innerHTML = parts.join('');
    return row;
  }

  function updateSelectionCount() {
    const visible = filteredRuns();
    const selectedVisible = visible.filter(r => state.selectedRunIds.has(r.id));
    el.historySelectionCount.textContent = `${selectedVisible.length} selected`;
    el.historyDeleteBtn.disabled = selectedVisible.length === 0;
    el.historySelectAll.checked = visible.length > 0 && selectedVisible.length === visible.length;
  }

  function requestRunDeletion(ids) {
    const runs = Cloud.getRuns().filter(r => ids.includes(r.id));
    const keepers = runs.filter(r => r.keep);
    const deletable = runs.filter(r => !r.keep).map(r => r.id);

    if (!deletable.length) {
      showToast('Every selected run is marked Keep. Nothing to delete.');
      return;
    }

    // The confirm states exactly what goes and what stays.
    const description = keepers.length
      ? `${deletable.length} ${deletable.length === 1 ? 'run' : 'runs'} will be deleted. ${keepers.length} marked Keep will remain.`
      : `This permanently deletes ${deletable.length} ${deletable.length === 1 ? 'run' : 'runs'}.`;

    confirmAction({
      title: `Delete ${deletable.length} ${deletable.length === 1 ? 'run' : 'runs'}?`,
      description,
      confirmLabel: `Delete ${deletable.length}`,
      onConfirm: () => scheduleRunDeletion(deletable)
    });
  }

  /* Hard delete, with a 5-second undo. The rows are hidden
     immediately and the DELETE is held for the length of the toast,
     so Undo is instant and a tab closed mid-window leaves the runs
     intact — the safe direction to fail in. */
  function scheduleRunDeletion(ids) {
    if (state.pendingRunDelete) {
      clearTimeout(state.pendingRunDelete.timer);
      commitRunDeletion();
    }

    const hidden = new Set(ids);
    state.pendingRunDelete = { ids, hidden };
    ids.forEach(id => state.selectedRunIds.delete(id));

    const rows = el.historyList.querySelectorAll('[data-run-id]');
    rows.forEach(row => {
      if (hidden.has(Number(row.dataset.runId))) row.hidden = true;
    });
    updateSelectionCount();

    state.pendingRunDelete.timer = setTimeout(commitRunDeletion, 5000);
    showToast(`${ids.length} ${ids.length === 1 ? 'run' : 'runs'} deleted.`, 'Undo', () => {
      clearTimeout(state.pendingRunDelete.timer);
      state.pendingRunDelete = null;
      renderHistory();
      showToast('Restored.');
    });
  }

  function commitRunDeletion() {
    const pending = state.pendingRunDelete;
    if (!pending) return;
    state.pendingRunDelete = null;
    Cloud.deleteRuns(pending.ids)
      .then(() => render())
      .catch(error => {
        console.error('[ui] run delete failed', error);
        showToast('Could not delete those runs. They are still here.');
        render();
      });
  }

  function openRunDetail(id) {
    const run = Cloud.getRuns().find(r => r.id === id);
    if (!run) return;
    el.runDialogTitle.textContent = run.metaPromptTitle || 'Run';

    const swapped = run.servedModel && run.requestedModel && run.servedModel !== run.requestedModel;
    const cell = (label, value, extraClass) =>
      `<div class="receipt-cell${extraClass ? ' ' + extraClass : ''}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;

    el.runDetailBody.innerHTML = `
      <div class="run-detail-block">
        <h3>Receipt</h3>
        <div class="receipt-grid">
          ${cell('When', formatDateTime(run.createdAt))}
          ${cell('Provider', (Settings.PROVIDERS[run.provider] && Settings.PROVIDERS[run.provider].label) || run.provider)}
          ${cell('Model requested', run.requestedModel || '—')}
          ${cell('Model served', run.servedModel || '—', swapped ? 'is-swapped' : '')}
          ${cell('Tokens', `${run.inputTokens.toLocaleString()} in / ${run.outputTokens.toLocaleString()} out`)}
          ${cell('Cost', formatCost(run.costUsd))}
          ${cell('Duration', `${(run.durationMs / 1000).toFixed(1)}s`)}
          ${cell('Status', run.status === 'error' ? 'Failed' : 'OK')}
          ${cell('Prompt version', run.promptVersion || '—')}
          ${run.responseId ? cell('Response id', run.responseId) : ''}
        </div>
      </div>
      ${run.status === 'error' ? `<div class="run-detail-block"><h3>Error</h3><pre>${escapeHtml(run.errorMessage)}</pre></div>` : ''}
      <div class="run-detail-block"><h3>Input</h3><pre>${escapeHtml(run.input || '(empty)')}</pre></div>
      ${run.output ? `<div class="run-detail-block"><h3>Output</h3><pre>${escapeHtml(run.output)}</pre></div>` : ''}`;

    el.runCopyInput.onclick = () => copyText(run.input, 'Input copied.');
    el.runCopyOutput.onclick = () => copyText(run.output, 'Output copied.');
    el.runCopyOutput.disabled = !run.output;
    openDialog(el.runDialog, el.runCopyOutput);
  }

  // ─────────────────────────────────────────────
  // SETTINGS
  // ─────────────────────────────────────────────

  function openSettings() {
    const user = Cloud.getUser();
    el.accountEmail.textContent = (user && user.email) || 'Unknown account';
    renderSettings();
    openDialog(el.settingsDialog);
  }

  function renderSettings() {
    const creds = Settings.readCredentials();
    const cloudSettings = Cloud.getSettings();

    el.settingsProvider.innerHTML = '';
    Settings.PROVIDER_IDS.forEach(id => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = Settings.PROVIDERS[id].label;
      el.settingsProvider.appendChild(option);
    });
    el.settingsProvider.value = creds.provider;
    el.settingsEffort.value = creds.effort;
    el.settingsMaxTokens.value = cloudSettings.defaultMaxTokens;
    el.settingsScratchDays.value = cloudSettings.scratchRetentionDays === null
      ? '' : String(cloudSettings.scratchRetentionDays);
    el.settingsRunsDays.value = cloudSettings.runsRetentionDays === null
      ? '' : String(cloudSettings.runsRetentionDays);

    el.providerRows.innerHTML = '';
    Settings.PROVIDER_IDS.forEach(id => {
      const meta = Settings.PROVIDERS[id];
      const row = document.createElement('div');
      row.className = 'provider-row';
      row.dataset.provider = id;
      row.innerHTML = `
        <div class="provider-row-head">
          <strong>${escapeHtml(meta.label)}</strong>
          <span class="provider-print">${escapeHtml(Settings.fingerprint(creds.keys[id]))}</span>
          <button class="btn btn-secondary" type="button" data-test-provider="${id}">Test</button>
        </div>
        <div class="provider-row-fields">
          <label class="sr-only" for="key-${id}">${escapeHtml(meta.label)} API key</label>
          <input type="password" id="key-${id}" data-key-input="${id}" placeholder="${escapeHtml(meta.placeholder)}" autocomplete="off" spellcheck="false">
          <label class="sr-only" for="model-${id}">${escapeHtml(meta.label)} model</label>
          <select id="model-${id}" data-model-input="${id}"></select>
        </div>
        <p class="provider-test-note" data-test-note="${id}"></p>`;
      el.providerRows.appendChild(row);

      row.querySelector(`[data-key-input="${id}"]`).value = creds.keys[id];
      populateModelSelect(id, creds);
    });

    updateSweepSummary();
  }

  function populateModelSelect(providerId, creds) {
    const select = el.providerRows.querySelector(`[data-model-input="${providerId}"]`);
    if (!select) return;
    const meta = Settings.PROVIDERS[providerId];
    const cached = Settings.readModelCatalog(providerId, creds.keys[providerId]);
    const chosen = creds.models[providerId];

    select.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = `Default (${meta.defaultModel})`;
    select.appendChild(auto);

    const models = cached ? cached.models : [];
    // A pinned model that the live list no longer contains still has
    // to be selectable, or saving Settings would silently change it.
    if (chosen && !models.includes(chosen)) models.unshift(chosen);
    models.forEach(model => {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      select.appendChild(option);
    });
    select.value = chosen;
  }

  function collectCredentials() {
    const keys = {};
    const models = {};
    Settings.PROVIDER_IDS.forEach(id => {
      const keyInput = el.providerRows.querySelector(`[data-key-input="${id}"]`);
      const modelInput = el.providerRows.querySelector(`[data-model-input="${id}"]`);
      if (keyInput) keys[id] = keyInput.value;
      if (modelInput) models[id] = modelInput.value;
    });
    return Settings.writeCredentials({
      provider: el.settingsProvider.value,
      effort: el.settingsEffort.value,
      keys,
      models
    });
  }

  function updateSweepSummary() {
    const { expiredScratch, staleRuns } = Cloud.sweepCandidates();
    const total = expiredScratch.length + staleRuns.length;
    el.sweepSummary.textContent = total === 0
      ? 'Nothing is due for cleanup.'
      : `${expiredScratch.length} expired Scratch ${expiredScratch.length === 1 ? 'prompt' : 'prompts'} and ${staleRuns.length} old ${staleRuns.length === 1 ? 'run' : 'runs'} can be removed.`;
    el.runSweepBtn.disabled = total === 0;
  }

  // ─────────────────────────────────────────────
  // VERSION HISTORY
  // ─────────────────────────────────────────────

  function openVersions(promptId) {
    const prompt = Cloud.getPrompts().find(p => p.id === promptId);
    if (!prompt) return;

    state.versionsPromptId = promptId;
    state.versions = [];
    state.selectedVersionId = null;
    el.versionsTitle.textContent = prompt.title || 'Versions';
    el.versionsList.innerHTML = '<p class="palette-empty">Loading…</p>';
    el.versionsDiff.innerHTML = '';
    el.versionsSummary.textContent = '';
    openDialog(el.versionsDialog);

    Cloud.listVersions(promptId)
      .then(versions => {
        if (state.versionsPromptId !== promptId) return;
        state.versions = versions;
        state.selectedVersionId = versions.length ? versions[0].id : null;
        renderVersions();
      })
      .catch(error => {
        console.error('[ui] could not load versions', error);
        el.versionsList.innerHTML = '<p class="palette-empty">Could not load version history.</p>';
      });
  }

  function renderVersions() {
    const prompt = Cloud.getPrompts().find(p => p.id === state.versionsPromptId);
    const hasVersions = state.versions.length > 0;
    el.versionCopyBtn.disabled = !hasVersions;
    el.versionRestoreBtn.disabled = !hasVersions;

    if (!hasVersions) {
      el.versionsList.innerHTML =
        '<p class="palette-empty">No earlier versions yet. One is filed each time you change this prompt&rsquo;s content.</p>';
      el.versionsDiff.innerHTML = '';
      el.versionsSummary.textContent = '';
      return;
    }

    el.versionsList.innerHTML = '';
    state.versions.forEach((version, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'version-item' + (version.id === state.selectedVersionId ? ' is-selected' : '');
      button.dataset.versionId = version.id;

      const when = document.createElement('strong');
      when.textContent = formatDateTime(version.createdAt);
      const meta = document.createElement('span');
      const changed = prompt ? Cloud.contentChanged(version, prompt) : true;
      meta.textContent = index === 0
        ? (changed ? 'Previous version' : 'Same as current')
        : `${index + 1} versions back`;

      button.appendChild(when);
      button.appendChild(meta);
      el.versionsList.appendChild(button);
    });

    renderVersionDiff();
  }

  function renderVersionDiff() {
    const prompt = Cloud.getPrompts().find(p => p.id === state.versionsPromptId);
    const version = state.versions.find(v => v.id === state.selectedVersionId);
    if (!prompt || !version) { el.versionsDiff.innerHTML = ''; return; }

    const rows = Diff.diffLines(version.text, prompt.text);
    const summary = Diff.summarise(rows);
    const shown = Diff.collapse(rows);

    const fieldRows = [];
    const compare = (label, before, after) => {
      if (String(before || '') !== String(after || '')) {
        fieldRows.push(
          `<div class="diff-field"><span>${escapeHtml(label)}</span>` +
          `<del>${escapeHtml(before || '(empty)')}</del>` +
          `<ins>${escapeHtml(after || '(empty)')}</ins></div>`
        );
      }
    };
    compare('Title', version.title, prompt.title);
    compare('Section', version.section, prompt.section);
    compare('Category', version.category, prompt.category);
    compare('Tags', (version.tags || []).join(', '), (prompt.tags || []).join(', '));
    compare('Notes', version.notes, prompt.notes);

    const body = shown.map(row => {
      if (row.type === 'gap') {
        return `<div class="diff-gap">${escapeHtml(row.text)}</div>`;
      }
      const sign = row.type === 'add' ? '+' : row.type === 'remove' ? '−' : ' ';
      return `<div class="diff-line diff-${row.type}"><span class="diff-sign">${sign}</span>` +
             `<span class="diff-text">${escapeHtml(row.text) || '&nbsp;'}</span></div>`;
    }).join('');

    el.versionsDiff.innerHTML =
      `<p class="diff-caption">This version <span aria-hidden="true">&rarr;</span> current</p>` +
      (fieldRows.length ? `<div class="diff-fields">${fieldRows.join('')}</div>` : '') +
      (summary.changed
        ? `<div class="diff-body">${body}</div>`
        : '<p class="palette-empty">The prompt text is identical.</p>');

    el.versionsSummary.textContent = summary.changed
      ? `${summary.added} added · ${summary.removed} removed`
      : 'No text changes';
  }

  el.versionsList.addEventListener('click', event => {
    const button = event.target.closest('[data-version-id]');
    if (!button) return;
    state.selectedVersionId = Number(button.dataset.versionId);
    renderVersions();
  });

  el.versionCopyBtn.addEventListener('click', () => {
    const version = state.versions.find(v => v.id === state.selectedVersionId);
    if (version) copyText(version.text, 'Version copied.');
  });

  el.versionRestoreBtn.addEventListener('click', () => {
    const prompt = Cloud.getPrompts().find(p => p.id === state.versionsPromptId);
    const version = state.versions.find(v => v.id === state.selectedVersionId);
    if (!prompt || !version) return;

    confirmAction({
      title: 'Restore this version?',
      description: `“${prompt.title}” goes back to how it was on ${formatDateTime(version.createdAt)}. The current version is filed in the history first, so this is reversible.`,
      confirmLabel: 'Restore',
      onConfirm: () => {
        // Snapshot the current state before overwriting it, so a
        // restore can itself be undone by restoring the version this
        // creates. Without it, restoring would be the one edit in the
        // app that loses work.
        const previous = { ...prompt };
        prompt.title = version.title;
        prompt.text = version.text;
        prompt.category = version.category;
        prompt.tags = (version.tags || []).slice();
        prompt.notes = version.notes;
        prompt.section = version.section;
        prompt.expiresAt = version.section === 'scratch' ? (prompt.expiresAt || scratchExpiry()) : null;
        prompt.updatedAt = Date.now();

        savePrompt(prompt, previous);
        closeDialog(el.versionsDialog);
        render();
        showToast('Version restored.');
      }
    });
  });

  el.versionsDialog.addEventListener('close', () => {
    state.versionsPromptId = null;
    state.versions = [];
    state.selectedVersionId = null;
  });

  // ─────────────────────────────────────────────
  // IMPORT
  // ─────────────────────────────────────────────

  function setImportNote(message, kind) {
    el.importNote.className = 'provider-test-note' + (kind ? ` is-${kind}` : '');
    el.importNote.textContent = message;
  }

  /* Parse first, state the counts, then write — same contract as
     every other bulk action here. Nothing lands until the confirm
     sheet has said exactly how many prompts are coming in and how
     many were already present. */
  function beginImport(rawText, sourceLabel) {
    let parsed;
    try {
      parsed = Cloud.parseImport(rawText);
    } catch (error) {
      setImportNote(error.message, 'error');
      return;
    }

    if (!parsed.fresh.length && !parsed.duplicates.length) {
      setImportNote(`Nothing importable in ${sourceLabel}. ${parsed.skipped} entries were unusable.`, 'error');
      return;
    }

    const parts = [`${parsed.fresh.length} new ${parsed.fresh.length === 1 ? 'prompt' : 'prompts'} will be added.`];
    if (parsed.duplicates.length) {
      parts.push(`${parsed.duplicates.length} already exist and will be skipped — existing prompts are never overwritten.`);
    }
    if (parsed.skipped) parts.push(`${parsed.skipped} entries were unusable and will be ignored.`);

    confirmAction({
      title: `Import ${parsed.fresh.length} ${parsed.fresh.length === 1 ? 'prompt' : 'prompts'}?`,
      description: parts.join(' '),
      confirmLabel: `Import ${parsed.fresh.length}`,
      onConfirm: () => {
        const added = Cloud.applyImport(parsed, 'skip');
        setImportNote(`Imported ${added} ${added === 1 ? 'prompt' : 'prompts'}.`, 'ok');
        showToast(`Imported ${added} ${added === 1 ? 'prompt' : 'prompts'}.`);
        render();
      }
    });
  }

  el.importFile.addEventListener('change', () => {
    const file = el.importFile.files && el.importFile.files[0];
    if (!file) return;
    setImportNote('Reading…');
    file.text()
      .then(text => beginImport(text, file.name))
      .catch(() => setImportNote('That file could not be read.', 'error'))
      .finally(() => { el.importFile.value = ''; });
  });

  el.importPasteBtn.addEventListener('click', () => {
    el.importPasteWrap.hidden = !el.importPasteWrap.hidden;
    if (!el.importPasteWrap.hidden) el.importText.focus();
  });

  el.importTextBtn.addEventListener('click', () => {
    const text = el.importText.value.trim();
    if (!text) { setImportNote('Paste some JSON first.', 'error'); return; }
    beginImport(text, 'the pasted JSON');
  });

  // ─────────────────────────────────────────────
  // COMMAND PALETTE
  // ─────────────────────────────────────────────

  function openPalette() {
    el.paletteInput.value = '';
    buildPalette('');
    openDialog(el.paletteDialog, el.paletteInput);
  }

  function buildPalette(query) {
    const term = query.trim().toLowerCase();
    const items = [];

    Object.keys(SECTION_META).forEach(section => {
      items.push({
        icon: 'fa-arrow-right',
        label: `Go to ${SECTION_META[section].title}`,
        hint: 'Section',
        run: () => setSection(section)
      });
    });

    items.push({
      icon: 'fa-plus', label: 'New prompt', hint: 'Action',
      run: () => openPromptEditor(null)
    });
    items.push({
      icon: 'fa-gear', label: 'Open settings', hint: 'Action',
      run: () => openSettings()
    });
    items.push({
      icon: 'fa-rotate', label: 'Sync now', hint: 'Action',
      run: () => Cloud.syncFromCloud().then(ok => showToast(ok ? 'Cloud sync complete.' : 'Sync failed.'))
    });

    Cloud.getPrompts().forEach(prompt => {
      items.push({
        icon: 'fa-align-left',
        label: prompt.title,
        hint: SECTION_META[prompt.section].title,
        run: () => {
          setSection(prompt.section);
          if (prompt.section === 'workshop') {
            state.metaPromptId = prompt.id;
            renderWorkshop();
          } else {
            openPromptDetail(prompt.id);
          }
        }
      });
    });

    const matched = term
      ? items.filter(item => item.label.toLowerCase().includes(term))
      : items;

    state.paletteItems = matched.slice(0, 40);
    state.paletteIndex = 0;
    renderPalette();
  }

  function renderPalette() {
    el.paletteResults.innerHTML = '';
    if (!state.paletteItems.length) {
      el.paletteResults.innerHTML = '<p class="palette-empty">Nothing matches.</p>';
      return;
    }
    state.paletteItems.forEach((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'palette-item' + (index === state.paletteIndex ? ' is-active' : '');
      button.dataset.paletteIndex = index;
      button.setAttribute('role', 'option');
      const icon = document.createElement('i');
      icon.className = `fas ${item.icon}`;
      const label = document.createElement('span');
      label.textContent = item.label;
      const hint = document.createElement('small');
      hint.textContent = item.hint;
      button.appendChild(icon);
      button.appendChild(label);
      button.appendChild(hint);
      el.paletteResults.appendChild(button);
    });
  }

  function runPaletteItem(index) {
    const item = state.paletteItems[index];
    closeDialog(el.paletteDialog);
    if (item) item.run();
  }

  // ─────────────────────────────────────────────
  // SIDEBAR
  // ─────────────────────────────────────────────

  function openSidebar() {
    document.body.classList.add('sidebar-open');
    el.mobileMenuBtn.setAttribute('aria-expanded', 'true');
  }

  function closeSidebar() {
    document.body.classList.remove('sidebar-open');
    el.mobileMenuBtn.setAttribute('aria-expanded', 'false');
  }

  // ─────────────────────────────────────────────
  // EVENT WIRING
  // ─────────────────────────────────────────────

  document.addEventListener('click', event => {
    const opener = event.target.closest('[data-open-prompt]');
    if (opener) openPromptEditor(null, opener.dataset.sectionHint);
  });

  document.querySelectorAll('[data-section]').forEach(button => {
    button.addEventListener('click', () => setSection(button.dataset.section));
  });

  el.sidebar.addEventListener('click', event => {
    const pinnedButton = event.target.closest('[data-nav-mode="pinned"]');
    const categoryButton = event.target.closest('[data-category]');
    if (pinnedButton) {
      if (state.section === 'history') setSection('library');
      state.pinnedOnly = !state.pinnedOnly;
      state.category = '';
      el.categoryFilter.value = '';
      pinnedButton.classList.toggle('active', state.pinnedOnly);
      render();
      closeSidebar();
    } else if (categoryButton) {
      state.pinnedOnly = false;
      state.category = categoryButton.dataset.category;
      el.categoryFilter.value = state.category;
      render();
      closeSidebar();
    }
  });

  el.sidebarSettingsBtn.addEventListener('click', openSettings);
  el.mobileMenuBtn.addEventListener('click', openSidebar);
  el.sidebarCloseBtn.addEventListener('click', closeSidebar);
  el.sidebarBackdrop.addEventListener('click', closeSidebar);
  el.mobileMenuBtn.setAttribute('aria-expanded', 'false');

  el.searchInput.addEventListener('input', () => {
    state.search = el.searchInput.value;
    el.clearSearchBtn.style.display = state.search.length ? 'flex' : 'none';
    render();
  });

  el.clearSearchBtn.addEventListener('click', () => {
    state.search = '';
    el.searchInput.value = '';
    el.clearSearchBtn.style.display = 'none';
    el.searchInput.focus();
    render();
  });

  el.categoryFilter.addEventListener('change', () => {
    state.category = el.categoryFilter.value;
    state.pinnedOnly = false;
    render();
  });

  el.sortSelect.addEventListener('change', () => {
    state.sort = el.sortSelect.value;
    Settings.writePrefs({ sort: state.sort });
    render();
  });

  document.querySelectorAll('.view-btn[data-view-mode]').forEach(button => {
    button.addEventListener('click', () => {
      state.view = button.dataset.viewMode;
      Settings.writePrefs({ view: state.view });
      state.expandedIds = new Set();
      updateViewButtons();
      render();
    });
  });

  function updateViewButtons() {
    document.querySelectorAll('.view-btn[data-view-mode]').forEach(button => {
      const active = button.dataset.viewMode === state.view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  el.promptsContainer.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (button.dataset.action === 'clear-filters') {
      state.search = '';
      state.category = '';
      state.pinnedOnly = false;
      el.searchInput.value = '';
      el.categoryFilter.value = '';
      el.clearSearchBtn.style.display = 'none';
      render();
      return;
    }
    const id = Number(button.dataset.id);
    if (!Number.isFinite(id)) return;

    const actions = {
      move: () => movePrompt(id, Number(button.dataset.direction)),
      open: () => openPromptDetail(id),
      pin: () => togglePin(id),
      copy: () => copyPrompt(id),
      edit: () => openPromptEditor(id),
      delete: () => deletePrompt(id),
      expand: () => toggleExpand(id)
    };
    const action = actions[button.dataset.action];
    if (action) action();
  });

  // Targeted DOM toggle rather than a re-render, which is what makes
  // expand/collapse reliable on a phone. A pinned prompt renders
  // twice, so every instance of the id is updated.
  function toggleExpand(id) {
    const items = el.promptsContainer.querySelectorAll(`.prompt-item[data-id="${id}"]`);
    if (!items.length) return;
    const expanded = !state.expandedIds.has(id);
    if (expanded) state.expandedIds.add(id);
    else state.expandedIds.delete(id);
    items.forEach(item => {
      item.classList.toggle('is-expanded', expanded);
      const toggle = item.querySelector('.preview-toggle');
      if (toggle) {
        toggle.innerHTML = expanded
          ? '<i class="fas fa-chevron-up"></i> Show less'
          : '<i class="fas fa-chevron-down"></i> Show more';
      }
    });
  }

  el.detailContent.addEventListener('click', event => {
    const button = event.target.closest('button[data-detail-action]');
    if (!button) return;
    const id = state.selectedPromptId;
    const actions = {
      close: closePromptDetail,
      copy: () => copyPrompt(id),
      pin: () => togglePin(id),
      edit: () => openPromptEditor(id),
      delete: () => deletePrompt(id),
      'to-workshop': () => movePromptToSection(id, 'workshop'),
      use: () => { state.metaPromptId = id; setSection('workshop'); },
      versions: () => openVersions(id)
    };
    const action = actions[button.dataset.detailAction];
    if (action) action();
  });

  // Workshop
  el.workshopList.addEventListener('click', event => {
    const button = event.target.closest('[data-meta-id]');
    if (!button) return;
    state.metaPromptId = Number(button.dataset.metaId);
    renderWorkshop();
  });

  el.workshopRunBtn.addEventListener('click', runWorkshop);
  el.workshopStopBtn.addEventListener('click', () => {
    if (state.abortController) state.abortController.abort();
  });
  el.workshopClearBtn.addEventListener('click', () => {
    el.workshopInput.value = '';
    el.workshopInput.focus();
  });
  el.workshopOutputBack.addEventListener('click', () => {
    el.workshopOutputPane.classList.remove('is-open');
  });
  el.workshopCopyBtn.addEventListener('click', () => {
    if (state.lastRun) copyText(state.lastRun.output, 'Output copied.');
  });
  el.workshopSaveLibraryBtn.addEventListener('click', () => saveRunOutput('library'));
  el.workshopSaveScratchBtn.addEventListener('click', () => saveRunOutput('scratch'));
  el.workshopDiscardBtn.addEventListener('click', () => {
    state.lastRun = null;
    el.workshopOutput.textContent = '';
    el.workshopReceipt.textContent = '';
    el.workshopOutputActions.hidden = true;
    el.workshopOutputPane.classList.remove('is-open');
  });

  // History
  el.historyRange.addEventListener('change', () => {
    state.historyRange = el.historyRange.value;
    renderHistory();
  });
  el.historyProvider.addEventListener('change', () => {
    state.historyProvider = el.historyProvider.value;
    renderHistory();
  });
  el.historyStatus.addEventListener('change', () => {
    state.historyStatus = el.historyStatus.value;
    renderHistory();
  });
  el.historyUnsaved.addEventListener('change', () => {
    state.historyUnsavedOnly = el.historyUnsaved.checked;
    renderHistory();
  });

  el.historySelectBtn.addEventListener('click', () => {
    state.selectMode = true;
    state.selectedRunIds = new Set();
    renderHistory();
  });

  el.historyCancelSelect.addEventListener('click', () => {
    state.selectMode = false;
    state.selectedRunIds = new Set();
    renderHistory();
  });

  // Select-all respects the current filter — filter to failed runs,
  // select all, delete has to work.
  el.historySelectAll.addEventListener('change', () => {
    const visible = filteredRuns();
    if (el.historySelectAll.checked) visible.forEach(r => state.selectedRunIds.add(r.id));
    else visible.forEach(r => state.selectedRunIds.delete(r.id));
    renderHistory();
  });

  el.historyDeleteBtn.addEventListener('click', () => {
    const visible = filteredRuns().filter(r => state.selectedRunIds.has(r.id));
    if (visible.length) requestRunDeletion(visible.map(r => r.id));
  });

  el.historyList.addEventListener('click', event => {
    const open = event.target.closest('[data-run-open]');
    const keep = event.target.closest('[data-run-keep]');
    const remove = event.target.closest('[data-run-delete]');
    if (open) { openRunDetail(Number(open.dataset.runOpen)); return; }
    if (keep) {
      const id = Number(keep.dataset.runKeep);
      const run = Cloud.getRuns().find(r => r.id === id);
      if (!run) return;
      Cloud.updateRun(id, { keep: !run.keep })
        .then(() => { renderHistory(); updateSweepSummary(); })
        .catch(() => showToast('Could not update that run.'));
      return;
    }
    if (remove) { requestRunDeletion([Number(remove.dataset.runDelete)]); }
  });

  el.historyList.addEventListener('change', event => {
    const box = event.target.closest('[data-run-select]');
    if (!box) return;
    const id = Number(box.dataset.runSelect);
    if (box.checked) state.selectedRunIds.add(id);
    else state.selectedRunIds.delete(id);
    const row = box.closest('.history-row');
    if (row) row.classList.toggle('is-selected', box.checked);
    updateSelectionCount();
  });

  // Settings
  el.settingsBtn.addEventListener('click', openSettings);

  el.settingsProvider.addEventListener('change', () => { collectCredentials(); renderWorkshop(); });
  el.settingsEffort.addEventListener('change', collectCredentials);

  el.providerRows.addEventListener('change', event => {
    if (event.target.closest('[data-key-input]') || event.target.closest('[data-model-input]')) {
      const creds = collectCredentials();
      const keyInput = event.target.closest('[data-key-input]');
      if (keyInput) populateModelSelect(keyInput.dataset.keyInput, creds);
      renderWorkshop();
    }
  });

  el.providerRows.addEventListener('click', event => {
    const button = event.target.closest('[data-test-provider]');
    if (!button) return;
    const providerId = button.dataset.testProvider;
    const creds = collectCredentials();
    const note = el.providerRows.querySelector(`[data-test-note="${providerId}"]`);
    note.className = 'provider-test-note';
    note.textContent = 'Testing…';
    button.disabled = true;

    Runner.listModels(providerId, creds.keys[providerId], { force: true })
      .then(result => {
        note.className = 'provider-test-note is-ok';
        note.textContent = `Key works — ${result.models.length} models available.`;
        populateModelSelect(providerId, Settings.readCredentials());
        renderSettings();
      })
      .catch(error => {
        note.className = 'provider-test-note is-error';
        note.textContent = [error.message, error.hint].filter(Boolean).join(' ');
      })
      .finally(() => { button.disabled = false; });
  });

  function saveCloudSettings() {
    const patch = {
      defaultMaxTokens: Number(el.settingsMaxTokens.value) || 16000,
      scratchRetentionDays: el.settingsScratchDays.value === '' ? null : Number(el.settingsScratchDays.value),
      runsRetentionDays: el.settingsRunsDays.value === '' ? null : Number(el.settingsRunsDays.value)
    };
    Cloud.saveSettings(patch)
      .then(updateSweepSummary)
      .catch(() => showToast('Could not save those settings.'));
  }

  el.settingsMaxTokens.addEventListener('change', saveCloudSettings);
  el.settingsScratchDays.addEventListener('change', saveCloudSettings);
  el.settingsRunsDays.addEventListener('change', saveCloudSettings);

  el.runSweepBtn.addEventListener('click', () => {
    const { expiredScratch, staleRuns } = Cloud.sweepCandidates();
    confirmAction({
      title: 'Clean up now?',
      description: `${expiredScratch.length} expired Scratch ${expiredScratch.length === 1 ? 'prompt' : 'prompts'} and ${staleRuns.length} old ${staleRuns.length === 1 ? 'run' : 'runs'} will be deleted. Pinned prompts and runs marked Keep will remain.`,
      confirmLabel: 'Clean up',
      onConfirm: () => {
        Cloud.runSweep().then(result => {
          showToast(`Removed ${result.prompts} prompts and ${result.runs} runs.`);
          render();
          updateSweepSummary();
        });
      }
    });
  });

  el.exportBtn.addEventListener('click', () => {
    const payload = JSON.stringify({
      exportedAt: new Date().toISOString(),
      prompts: Cloud.getPrompts()
    }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `prompt-studio-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  el.signOutBtn.addEventListener('click', async () => {
    el.signOutBtn.disabled = true;
    const result = await Cloud.signOut();
    el.signOutBtn.disabled = false;
    if (!result.ok) { showToast(result.error); return; }
    closeDialog(el.settingsDialog);
    endSession();
  });

  el.syncBtn.addEventListener('click', () => {
    Cloud.syncFromCloud().then(ok => showToast(ok ? 'Cloud sync complete.' : 'Sync failed.'));
  });
  el.sidebarSyncBtn.addEventListener('click', () => {
    Cloud.syncFromCloud().then(ok => showToast(ok ? 'Cloud sync complete.' : 'Sync failed.'));
  });

  // Palette
  el.paletteInput.addEventListener('input', () => buildPalette(el.paletteInput.value));

  el.paletteResults.addEventListener('click', event => {
    const button = event.target.closest('[data-palette-index]');
    if (button) runPaletteItem(Number(button.dataset.paletteIndex));
  });

  el.paletteDialog.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const count = state.paletteItems.length;
      if (!count) return;
      state.paletteIndex = (state.paletteIndex + delta + count) % count;
      renderPalette();
      const active = el.paletteResults.querySelector('.is-active');
      if (active) active.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runPaletteItem(state.paletteIndex);
    }
  });

  // Global keys
  document.addEventListener('keydown', event => {
    const meta = event.metaKey || event.ctrlKey;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) ||
      document.activeElement.isContentEditable;

    if (meta && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openPalette();
      return;
    }
    if (event.key === '/' && !typing && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      openPalette();
      return;
    }
    if (meta && event.key === 'Enter' && state.section === 'workshop' && !state.running) {
      event.preventDefault();
      runWorkshop();
      return;
    }
    if (meta && event.key.toLowerCase() === 's') {
      if (el.promptDialog.open) {
        event.preventDefault();
        el.promptForm.requestSubmit();
      }
      return;
    }
    if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
      if (document.body.classList.contains('sidebar-open')) closeSidebar();
      else if (el.workshopOutputPane.classList.contains('is-open')) {
        el.workshopOutputPane.classList.remove('is-open');
      } else closePromptDetail();
    }
  });

  // Flush a held delete if the tab is closing — the timer would
  // otherwise be lost. The rows survive either way; this just avoids
  // a delete the user already confirmed silently not happening.
  window.addEventListener('pagehide', () => {
    if (state.pendingRunDelete) {
      clearTimeout(state.pendingRunDelete.timer);
      commitRunDeletion();
    }
  });

  // ─────────────────────────────────────────────
  // SYNC STATUS
  // ─────────────────────────────────────────────

  Cloud.on('status', ({ state: syncState, message }) => {
    const icons = {
      syncing: '<i class="fas fa-spinner fa-spin"></i>',
      synced: '<i class="fas fa-check"></i>',
      error: '<i class="fas fa-exclamation-triangle"></i>'
    };
    el.syncBtn.innerHTML = icons[syncState] || '<i class="fas fa-cloud"></i>';
    el.cloudStatus.textContent = message;
    el.saveState.dataset.state = syncState;
    el.sidebarSyncBtn.dataset.state = syncState;
    el.saveStateLabel.textContent = syncState === 'synced' ? 'Saved' : message;
    el.sidebarSyncLabel.textContent = syncState === 'synced' ? 'All changes saved' : message;
    el.syncBtn.setAttribute('aria-label',
      syncState === 'syncing' ? 'Syncing' : syncState === 'error' ? 'Sync failed. Retry' : 'Sync');
    if (syncState === 'synced') {
      setTimeout(() => { el.syncBtn.innerHTML = '<i class="fas fa-cloud"></i>'; }, 1500);
    }
  });

  Cloud.on('change', () => {
    render();
    if (el.settingsDialog.open) updateSweepSummary();
  });

  // ─────────────────────────────────────────────
  // SESSION
  // ─────────────────────────────────────────────

  async function beginSession(user) {
    document.body.classList.add('is-authenticated');
    el.authScreen.hidden = true;
    el.appContainer.hidden = false;
    el.sidebarAccountEmail.textContent = user.email || 'Cloud workspace';
    el.accountEmail.textContent = user.email || user.id;

    await Cloud.startSession(user);
    setSection(prefs.section === 'history' ? 'history' : prefs.section);

    // Load-time sweep. Nothing pinned or marked Keep is touched, and
    // Library and Workshop are never candidates at all.
    const { expiredScratch, staleRuns } = Cloud.sweepCandidates();
    if (expiredScratch.length || staleRuns.length) {
      showToast(
        `${expiredScratch.length + staleRuns.length} expired items can be cleaned up.`,
        'Clean up',
        () => Cloud.runSweep().then(result => {
          showToast(`Removed ${result.prompts} prompts and ${result.runs} runs.`);
          render();
        })
      );
    }
  }

  function endSession() {
    Cloud.endSession();
    document.body.classList.remove('is-authenticated', 'sidebar-open');
    el.detailPanel.classList.remove('is-open');
    el.appContainer.hidden = true;
    el.authScreen.hidden = false;
    el.loginEmail.focus();
  }

  el.loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    el.loginError.textContent = '';
    el.loginSubmit.disabled = true;
    // Preserved so a failed sign-in restores the button exactly as
    // the markup shipped it, rather than a different label.
    const original = el.loginSubmit.innerHTML;
    el.loginSubmit.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signing in…';

    try {
      const result = await Cloud.signIn(el.loginEmail.value.trim(), el.loginPassword.value);
      if (!result.ok) throw new Error(result.error);
      el.loginPassword.value = '';
      await beginSession(result.user);
    } catch (error) {
      el.loginError.textContent = error.message || 'Sign-in failed. Please try again.';
    } finally {
      el.loginSubmit.disabled = false;
      el.loginSubmit.innerHTML = original;
    }
  });

  // ─────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────

  async function init() {
    applyTheme(prefs.theme);
    el.sortSelect.value = state.sort;
    updateViewButtons();
    el.clearSearchBtn.style.display = 'none';

    if (!window.supabase) {
      el.loginError.textContent = 'Cloud library failed to load. Check your connection and refresh.';
      return;
    }
    if (!Cloud.configured()) {
      el.loginError.textContent = 'Cloud sync is not configured yet (see supabase-config.js).';
      return;
    }

    Cloud.onAuthChange((event, session) => {
      if (event === 'SIGNED_OUT' && Cloud.getUser()) endSession();
      if (event === 'SIGNED_IN' && session && session.user && !Cloud.getUser()) {
        setTimeout(() => beginSession(session.user), 0);
      }
    });

    const session = await Cloud.getSession();
    if (session && session.user) await beginSession(session.user);
  }

  init().catch(error => {
    console.error('[ui] initialisation failed', error);
    el.loginError.textContent = error.message || 'The application could not start. Please refresh.';
  });
})();

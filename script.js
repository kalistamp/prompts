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
    // The exchange: system prompt plus alternating turns.
    thread: null,
    outputMode: prefs.outputMode,
    // The run in flight: 'idle' | 'thinking' | 'streaming', plus the
    // clock that turns a silent wait into a legible one.
    runPhase: 'idle',
    runStartedAt: 0,
    elapsedTimer: null,
    // The meta-prompt picker, opened by "/" or by the composer chip.
    slashOpen: false,
    slashIndex: 0,
    slashItems: [],
    previewOpen: false,

    // Full prompt viewer
    promptView: null,
    promptViewMode: 'markdown',

    // Reading mode — the index of the turn being read full screen,
    // or null. An index rather than a copy of the text, so a reopened
    // reader cannot show a stale answer.
    readerIndex: null,

    // History
    selectMode: false,
    selectedRunIds: new Set(),
    historyRange: 'all',
    historyProvider: '',
    historyStatus: '',
    historyUnsavedOnly: false,
    // Identical consecutive failures collapse to one row; this holds
    // the groups the user has chosen to open back up.
    expandedRepeats: new Set(),

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
    panes: $('list-detail-panes'),
    paneResizer: $('pane-resizer'),
    detailPanel: $('detail-panel'),
    detailEmpty: $('detail-empty'),
    detailContent: $('detail-content'),
    categoryList: $('category-list'),

    // Workshop — the run surface. One composer, one thread. The
    // second textarea, the picker pane, the output pane and the
    // four-button action row it carried are all gone.
    composer: $('composer'),
    composerMetaChip: $('composer-meta-chip'),
    composerMetaName: $('composer-meta-name'),
    composerModelChip: $('composer-model-chip'),
    composerModelName: $('composer-model-name'),
    composerPreviewChip: $('composer-preview-chip'),
    composerHint: $('composer-hint'),
    threadScroll: $('thread-scroll'),
    workshopThread: $('workshop-thread'),
    threadLive: $('thread-live'),
    slashMenu: $('slash-menu'),
    workshopInput: $('workshop-input'),
    workshopClearBtn: $('workshop-clear-btn'),
    workshopRunBtn: $('workshop-run-btn'),
    workshopRunLabel: $('workshop-run-label'),
    workshopStopBtn: $('workshop-stop-btn'),
    sendPreviewSummary: $('send-preview-summary'),
    sendPreviewBody: $('send-preview-body'),
    viewPromptBtn: $('view-prompt-btn'),

    libraryFilterChips: $('library-filter-chips'),
    historyFilterChips: $('history-filter-chips'),
    promptViewDialog: $('prompt-view-dialog'),
    promptViewTitle: $('prompt-view-title'),
    promptViewNote: $('prompt-view-note'),
    promptViewBody: $('prompt-view-body'),
    promptViewCopy: $('prompt-view-copy'),
    promptViewEdit: $('prompt-view-edit'),

    readerDialog: $('reader-dialog'),
    readerTitle: $('reader-title'),
    readerBody: $('reader-body'),
    readerText: $('reader-text'),
    readerMeta: $('reader-meta'),
    readerCopy: $('reader-copy'),

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

  /* Whether motion is wanted at all. Every transition below is
     routed through this, so "reduce" is honoured by the JS as well
     as by the stylesheet — a View Transition is not a CSS animation
     and the media query alone would not stop one. */
  function motionOK() {
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /* A same-document View Transition, where the browser has one.
     Native, so there is no animation loop and no library — and the
     fallback is simply doing the work, which is what used to happen
     unconditionally. */
  function transition(update, className) {
    if (!document.startViewTransition || !motionOK()) { update(); return Promise.resolve(); }
    if (className) document.documentElement.classList.add(className);
    const vt = document.startViewTransition(update);
    return vt.finished
      .catch(() => { /* interrupted by a second transition */ })
      .finally(() => { if (className) document.documentElement.classList.remove(className); });
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const isDark = theme === 'dark';
    el.themeToggle.innerHTML = `<i class="fas fa-${isDark ? 'sun' : 'moon'}"></i>`;
    el.themeToggle.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
    const meta = document.querySelector('meta[name="theme-color"]');
    // Kept in step with --bg in the token block, for the browser
    // chrome on mobile.
    if (meta) meta.content = isDark ? '#05090f' : '#e6ebf4';
  }

  /* The new theme is wiped in under a circle growing from the toggle,
     so the change reads as coming from the control that caused it
     rather than as the page blinking. Everything here degrades: no
     View Transition support, or reduced motion, and applyTheme just
     runs. */
  el.themeToggle.addEventListener('click', async () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    Settings.writePrefs({ theme: next });

    const canClip = typeof document.startViewTransition === 'function' &&
      typeof el.themeToggle.animate === 'function' && motionOK();

    if (!canClip) { applyTheme(next); return; }

    const box = el.themeToggle.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    // The far corner decides the radius, so the circle always covers
    // the viewport however near an edge the button sits.
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));

    document.documentElement.classList.add('vt-theme');
    const vt = document.startViewTransition(() => applyTheme(next));
    try {
      await vt.ready;
      await document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 460, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', pseudoElement: '::view-transition-new(root)' }
      ).finished;
    } catch (e) {
      /* A browser with startViewTransition but no pseudoElement
         animation still gets the theme — it just gets it instantly. */
    } finally {
      document.documentElement.classList.remove('vt-theme');
    }
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
    // Switching away from the Workshop mid-picker would leave the
    // menu open behind a view that no longer contains it.
    closeSlashMenu();
    // Cross-faded rather than swapped between frames. The work is
    // identical either way; `transition` only wraps it — and there is
    // nothing to cross-fade to when the section is already current,
    // where this still has to run because it clears the filters.
    if (state.section === section) { applySection(section); return; }
    transition(() => applySection(section));
  }

  function applySection(section) {
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
    /* The reading pane is a full-screen overlay on a phone, and
       `is-open` is a class on the panel rather than a fact derived
       from state.selectedPromptId — which this function has just
       cleared. Leaving it set meant coming back to a section and
       finding the empty "Select a prompt" panel covering the list,
       with no Back button on it to get out. */
    closePromptDetail();
    animateNextRender();
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

  /* Pinned is a CROSS-SECTION view. The sidebar count for it has always
     been global, but the list it opened was scoped to the section you
     happened to be in — so pinning a prompt and then moving it to
     Workshop made it disappear from Pinned while the count still
     claimed it was there. The count was right; the list was wrong. */
  function scopePrompts() {
    return state.pinnedOnly ? Cloud.getPrompts() : sectionPrompts();
  }

  function filteredPrompts() {
    const term = state.search.trim().toLowerCase();
    return scopePrompts().filter(p => {
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

  /* Position within the current render, for the staggered reveal.
     Rows span several category sections, so the counter cannot live
     inside the per-section loop or every section would restart it. */
  let rowIndex = 0;

  /* Whether the NEXT render animates its rows in.

     Rows should arrive when the list changes wholesale — first
     paint, a section switch, a filter dropped. They must not when
     the list is being narrowed a character at a time: search calls
     render() on every keystroke, and restarting a twenty-row
     staggered fade on each one turns typing into a strobe.

     So it is opt-in, and every render consumes it. */
  let staggerRows = true;

  function animateNextRender() { staggerRows = true; }

  function stagger(node, index) {
    if (!staggerRows) return node;
    node.classList.add('stagger-in');
    // A custom property through the CSSOM: allowed by the style CSP,
    // where a style="" attribute would be blocked outright.
    node.style.setProperty('--i', String(index));
    return node;
  }

  function renderList() {
    const filtered = filteredPrompts();
    const isFiltering = Boolean(state.search.trim() || state.category || state.pinnedOnly);
    // Reordering only makes sense on an unfiltered list — reordering a
    // subset would silently move the hidden items too.
    const canReorder = state.sort === 'custom' && !isFiltering;

    // Pinned spans every section now, so naming one would be a lie.
    el.viewTitle.textContent = state.pinnedOnly
      ? 'Pinned'
      : (state.category || SECTION_META[state.section].title);
    el.contextEyebrow.textContent = state.pinnedOnly
      ? 'Across all sections'
      : SECTION_META[state.section].eyebrow;
    el.resultCount.textContent = filtered.length;

    el.promptsContainer.innerHTML = '';
    renderLibraryChips();
    // Restarts the staggered reveal on every render, so the counter
    // is per-render rather than per-session.
    rowIndex = 0;

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
      staggerRows = false;
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
    // Consumed: the next render is plain unless something asks again.
    staggerRows = false;
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

    list.forEach((p, index) => {
      grid.appendChild(stagger(createItem(p, cat, canReorder, index, list.length), rowIndex++));
    });

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

  // Only shown in the Pinned view, where rows come from several
  // sections and "which section is this in" is otherwise unanswerable.
  function sectionChip(prompt) {
    if (!state.pinnedOnly) return '';
    return `<span class="section-chip">${escapeHtml(SECTION_META[prompt.section].title)}</span>`;
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
      ${tagsHtml || expiryChip(p) || sectionChip(p) ? `<div class="item-tags">${sectionChip(p)}${tagsHtml}${expiryChip(p)}</div>` : ''}
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
      ${tags || expiryChip(prompt) || sectionChip(prompt) ? `<div class="detail-tags">${sectionChip(prompt)}${tags}${expiryChip(prompt)}</div>` : ''}
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
          ? '<button class="btn btn-secondary" type="button" data-detail-action="to-workshop"><i class="fas fa-screwdriver-wrench"></i> Copy to Workshop</button>'
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
  // THE SPLIT
  // ─────────────────────────────────────────────

  /* A window splitter between the list and the reading pane.

     The stored value is a width in px, or null for "never dragged" —
     and those are genuinely different states, not the same one
     written twice. Unset follows the responsive default as the
     window changes; a set width does not, because you set it.

     The width is applied as a custom property rather than as a
     grid-template-columns override, so the stylesheet keeps the
     clamp() and a width dragged out on an ultrawide cannot squeeze
     the list to nothing on a laptop. */
  const SPLIT_MIN = 300;
  const SPLIT_STEP = 24;

  function splitBounds() {
    const total = el.panes.getBoundingClientRect().width;
    // Mirrors the 56% ceiling in the stylesheet. Two places, because
    // CSS cannot clamp a drag and JS should not own the layout.
    return { min: SPLIT_MIN, max: Math.max(SPLIT_MIN, Math.round(total * 0.56)) };
  }

  function applySplit(px, { persist = false } = {}) {
    if (px === null) {
      el.panes.style.removeProperty('--detail-w');
      if (persist) Settings.writePrefs({ detailWidth: null });
      describeSplit();
      return;
    }

    /* Clamp against the container ONLY when there is a container to
       measure. At boot the workspace is still `hidden` behind the
       sign-in screen, so it measures zero — and clamping against
       zero collapsed every restored width to the 300px minimum. The
       symptom was that dragging the splitter appeared to work and
       then silently reset on the next visit.

       With no width to measure, write the stored value through and
       let the stylesheet's own clamp() bound it at first layout,
       which is what that clamp is for. */
    const total = el.panes.getBoundingClientRect().width;
    const value = total > 0
      ? Math.round(Math.min(Math.round(total * 0.56), Math.max(SPLIT_MIN, px)))
      : Math.round(px);

    el.panes.style.setProperty('--detail-w', value + 'px');
    // Only ever persists a measured value: every caller that persists
    // is a user gesture, and by then the workspace is on screen.
    if (persist) Settings.writePrefs({ detailWidth: value });
    describeSplit();
  }

  /* The splitter reports its position as a percentage, which is the
     one number that stays meaningful when the window is resized. */
  function describeSplit() {
    const total = el.panes.getBoundingClientRect().width;
    if (!total) return;
    const width = el.detailPanel.getBoundingClientRect().width;
    const pct = Math.round((width / total) * 100);
    el.paneResizer.setAttribute('aria-valuenow', String(pct));
    el.paneResizer.setAttribute('aria-valuemin', String(Math.round((SPLIT_MIN / total) * 100)));
    el.paneResizer.setAttribute('aria-valuemax', '56');
    el.paneResizer.setAttribute('aria-valuetext', `Reading pane ${pct}% of the workspace`);
  }

  function currentSplit() {
    return el.detailPanel.getBoundingClientRect().width;
  }

  el.paneResizer.addEventListener('pointerdown', event => {
    if (!isDesktop() && !window.matchMedia('(min-width: 700px)').matches) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = currentSplit();
    let moved = false;

    el.paneResizer.classList.add('is-dragging');
    document.body.classList.add('is-resizing');
    try { el.paneResizer.setPointerCapture(event.pointerId); } catch (e) { /* older browsers */ }

    function move(e) {
      // Dragging left grows the reading pane, which is the direction
      // the handle is being pulled.
      const next = startWidth - (e.clientX - startX);
      if (Math.abs(e.clientX - startX) > 2) moved = true;
      applySplit(next);
    }

    function end() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      el.paneResizer.classList.remove('is-dragging');
      document.body.classList.remove('is-resizing');
      // Written once, on release — not on every pointermove, which
      // would be a localStorage write per frame.
      if (moved) applySplit(currentSplit(), { persist: true });
    }

    /* On `window`, not on the handle. Pointer capture normally keeps
       the events coming, but the handle is 7px wide and the pointer
       leaves it on the first frame of any real drag — so if capture
       is unavailable or gets released, a handle-scoped listener
       silently stops receiving moves mid-gesture. The window never
       does. */
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  });

  el.paneResizer.addEventListener('keydown', event => {
    const step = event.shiftKey ? SPLIT_STEP * 4 : SPLIT_STEP;
    const { min, max } = splitBounds();
    const keys = {
      ArrowLeft: () => applySplit(currentSplit() + step, { persist: true }),
      ArrowRight: () => applySplit(currentSplit() - step, { persist: true }),
      Home: () => applySplit(max, { persist: true }),
      End: () => applySplit(min, { persist: true }),
      // The same escape hatch the double-click gives a mouse.
      Enter: () => applySplit(null, { persist: true })
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  });

  // Back to whatever the window size says it should be.
  el.paneResizer.addEventListener('dblclick', () => {
    applySplit(null, { persist: true });
    showToast('Reading pane reset.');
  });

  /* A stored width is a px value, and the percentage it represents
     changes as the window does — so the announced value has to be
     recomputed rather than remembered. */
  window.addEventListener('resize', describeSplit);

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
  // ACTIVE FILTERS, AS CHIPS
  // ─────────────────────────────────────────────

  /* The controls that SET a filter are selects in a toolbar. Once
     you have scrolled, nothing on screen says a filter is on — so
     "No matching prompts" reads as "you have no prompts", and a
     short list reads as a short library. These say which filters are
     active and remove one per click. */
  function buildChips(container, chips) {
    container.innerHTML = '';
    container.hidden = chips.length === 0;
    if (!chips.length) return;

    const label = document.createElement('span');
    label.className = 'filter-chips-label';
    label.textContent = 'Filtered by';
    container.appendChild(label);

    chips.forEach(chip => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'filter-chip';
      button.title = `Remove: ${chip.label}`;
      const icon = document.createElement('i');
      icon.className = `fas ${chip.icon}`;
      icon.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.textContent = chip.label;
      const x = document.createElement('span');
      x.className = 'chip-x';
      x.innerHTML = '<i class="fas fa-xmark" aria-hidden="true"></i>';
      button.appendChild(icon);
      button.appendChild(text);
      button.appendChild(x);
      button.setAttribute('aria-label', `Remove filter: ${chip.label}`);
      // Dropping a filter widens the list, so the rows that come
      // back are worth showing arriving.
      button.addEventListener('click', () => { animateNextRender(); chip.clear(); });
      container.appendChild(button);
    });

    if (chips.length > 1) {
      const clearAll = document.createElement('button');
      clearAll.type = 'button';
      clearAll.className = 'filter-chip-clear';
      clearAll.textContent = 'Clear all';
      clearAll.addEventListener('click', () => { animateNextRender(); chips.forEach(c => c.clear(true)); });
      container.appendChild(clearAll);
    }
  }

  function renderLibraryChips() {
    const chips = [];
    if (state.search.trim()) {
      chips.push({
        icon: 'fa-magnifying-glass',
        label: `“${state.search.trim()}”`,
        clear: () => { el.searchInput.value = ''; state.search = ''; el.clearSearchBtn.style.display = 'none'; render(); }
      });
    }
    if (state.category) {
      chips.push({
        icon: 'fa-folder',
        label: state.category,
        clear: () => { state.category = ''; el.categoryFilter.value = ''; render(); }
      });
    }
    if (state.pinnedOnly) {
      chips.push({
        icon: 'fa-star',
        label: 'Pinned only',
        clear: () => {
          state.pinnedOnly = false;
          const button = el.sidebar.querySelector('[data-nav-mode="pinned"]');
          if (button) button.classList.remove('active');
          render();
        }
      });
    }
    buildChips(el.libraryFilterChips, chips);
  }

  function renderHistoryChips() {
    const RANGES = { '1': 'Last 24 hours', '7': 'Last 7 days', '30': 'Last 30 days' };
    const chips = [];
    if (state.historyRange !== 'all') {
      chips.push({
        icon: 'fa-calendar',
        label: RANGES[state.historyRange] || state.historyRange,
        clear: r => { state.historyRange = 'all'; el.historyRange.value = 'all'; if (!r) renderHistory(); }
      });
    }
    if (state.historyProvider) {
      const meta = Settings.PROVIDERS[state.historyProvider];
      chips.push({
        icon: 'fa-microchip',
        label: (meta && meta.label) || state.historyProvider,
        clear: r => { state.historyProvider = ''; el.historyProvider.value = ''; if (!r) renderHistory(); }
      });
    }
    if (state.historyStatus) {
      chips.push({
        icon: state.historyStatus === 'error' ? 'fa-triangle-exclamation' : 'fa-check',
        label: state.historyStatus === 'error' ? 'Failed only' : 'Succeeded only',
        clear: r => { state.historyStatus = ''; el.historyStatus.value = ''; if (!r) renderHistory(); }
      });
    }
    if (state.historyUnsavedOnly) {
      chips.push({
        icon: 'fa-inbox',
        label: 'No saved output',
        clear: r => { state.historyUnsavedOnly = false; el.historyUnsaved.checked = false; if (!r) renderHistory(); }
      });
    }
    buildChips(el.historyFilterChips, chips);

    /* "Clear all" passes true so each chip skips its own re-render;
       one render at the end, not four. */
    const clearAll = el.historyFilterChips.querySelector('.filter-chip-clear');
    if (clearAll) clearAll.addEventListener('click', () => renderHistory());
  }

  function clearHistoryFilters() {
    animateNextRender();
    state.historyRange = 'all';
    state.historyProvider = '';
    state.historyStatus = '';
    state.historyUnsavedOnly = false;
    el.historyRange.value = 'all';
    el.historyProvider.value = '';
    el.historyStatus.value = '';
    el.historyUnsaved.checked = false;
    renderHistory();
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

  /* Copy, not move. `section` is a single column, so relocating a
     prompt genuinely removes it from where it was — which is a
     surprise when all you wanted was to run it as a meta-prompt, and
     it took the pin with it. This leaves the original untouched and
     puts an independent copy in Workshop, ready to be edited into a
     meta-prompt without disturbing the one you rely on.

     A real move is still available, deliberately: change the Section
     field in the prompt editor. */
  function copyToWorkshop(id) {
    const source = Cloud.getPrompts().find(p => p.id === id);
    if (!source) return;

    const newId = Cloud.newId();
    savePrompt({
      ...source,
      id: newId,
      createdAt: newId,
      updatedAt: newId,
      order: newId,
      section: 'workshop',
      // The copy starts unpinned and unexpiring: the pin belongs to
      // the original, and a Workshop prompt is never on a clock.
      pinned: false,
      expiresAt: null,
      revision: 0
    });

    /* Same rule the picker applies: a thread's system message belongs
       to the meta-prompt that started it, so pointing the composer at
       a different one ends the exchange rather than carrying it over
       and answering under rules the new prompt never set. */
    if (state.thread && state.thread.metaPromptId !== newId) endThread();
    state.metaPromptId = newId;

    /* And then GO there. The copy exists to be run, and leaving the
       user in Library looking at the original — which is unchanged,
       so nothing on screen moved — read as the button having done
       nothing at all. On a phone, where Workshop is a tab away
       behind the tab bar, that was the whole of the feedback.
       setSection re-renders, so the render() this replaced is gone. */
    setSection('workshop');
    showToast(`Copied to Workshop. The original stays in ${SECTION_META[source.section].title}.`);
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

  function selectedMeta() {
    return Cloud.getPrompts().find(p => p.id === state.metaPromptId) || null;
  }

  /* Composer context, thread, and the run button label. The picker
     pane it replaced held three items in 280px of permanent chrome;
     the same list is now one keystroke away and takes no space at
     rest. */
  function renderWorkshop() {
    const list = metaPrompts();
    el.viewTitle.textContent = 'Workshop';
    el.resultCount.textContent = list.length;

    if (state.metaPromptId && !list.some(p => p.id === state.metaPromptId)) {
      state.metaPromptId = null;
    }
    if (!state.metaPromptId && list.length) state.metaPromptId = list[0].id;

    const meta = selectedMeta();
    el.composerMetaName.textContent = meta ? meta.title : 'Pick a meta-prompt';
    el.composerMetaChip.classList.toggle('is-primary', Boolean(meta));
    el.composerMetaChip.classList.toggle('is-empty', !meta);
    el.composerMetaChip.disabled = !list.length;
    el.viewPromptBtn.disabled = !meta;

    const creds = Settings.readCredentials();
    const providerMeta = Settings.PROVIDERS[creds.provider];
    const model = Settings.resolveModel(creds.provider, creds);
    const hasKey = Boolean(creds.keys[creds.provider]);
    el.composerModelName.textContent = hasKey ? model : `${providerMeta.label} · no key`;
    el.composerModelChip.title = hasKey
      ? `${providerMeta.label} · ${model} — change in Settings`
      : `${providerMeta.label} has no API key yet — add one in Settings`;
    el.composerModelChip.classList.toggle('is-empty', !hasKey);

    // The button says which of the two things it will do, because in
    // a thread "Run" and "Send a change" are different acts.
    const continuing = Boolean(state.thread && threadReplies() > 0);
    el.workshopRunLabel.textContent = continuing ? 'Send' : 'Run';
    el.workshopRunBtn.disabled = !meta || !hasKey || state.running;

    el.composerHint.textContent = !list.length
      ? 'Create a meta-prompt to start running.'
      : !hasKey
        ? 'Add an API key in Settings to run.'
        : continuing
          ? 'Continuing this exchange — the meta-prompt stays fixed.'
          : 'Press / to switch meta-prompt.';

    renderSendPreview();
    renderThread();
    updateRunControls();
  }

  function threadReplies() {
    return state.thread ? state.thread.messages.filter(m => m.role === 'assistant').length : 0;
  }

  // ─────────────────────────────────────────────
  // THE META-PROMPT PICKER ("/")
  // ─────────────────────────────────────────────

  /* Opened by the chip, or by "/" as the first character of an empty
     composer — the same convention as a slash command, and the
     reason the picker no longer needs a pane of its own. Typing
     filters; Arrow keys move; Enter picks; Escape closes and leaves
     what you had typed alone. */
  function openSlashMenu(query) {
    const list = metaPrompts();
    const term = String(query || '').trim().toLowerCase();
    state.slashItems = term
      ? list.filter(p => p.title.toLowerCase().includes(term) || p.text.toLowerCase().includes(term))
      : list;
    state.slashOpen = true;
    state.slashIndex = Math.max(0, state.slashItems.findIndex(p => p.id === state.metaPromptId));
    el.composerMetaChip.setAttribute('aria-expanded', 'true');
    renderSlashMenu();
  }

  function closeSlashMenu() {
    if (!state.slashOpen) return;
    state.slashOpen = false;
    state.slashItems = [];
    if (el.slashMenu) el.slashMenu.hidden = true;
    if (el.composerMetaChip) el.composerMetaChip.setAttribute('aria-expanded', 'false');
    if (el.workshopInput) el.workshopInput.removeAttribute('aria-activedescendant');
  }

  function renderSlashMenu() {
    el.slashMenu.hidden = false;
    el.slashMenu.innerHTML = '';

    if (!state.slashItems.length) {
      const empty = document.createElement('p');
      empty.className = 'slash-empty';
      empty.textContent = metaPrompts().length
        ? 'No meta-prompt matches.'
        : 'No meta-prompts yet — a meta-prompt is the prompt that writes your prompts.';
      el.slashMenu.appendChild(empty);
      el.workshopInput.removeAttribute('aria-activedescendant');
      return;
    }

    state.slashItems.forEach((p, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `slash-opt-${p.id}`;
      button.className = 'slash-item' +
        (index === state.slashIndex ? ' is-active' : '') +
        (p.id === state.metaPromptId ? ' is-current' : '');
      button.dataset.metaId = p.id;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === state.slashIndex));
      const title = document.createElement('strong');
      title.textContent = p.title;
      const sub = document.createElement('span');
      sub.textContent = p.text.replace(/\s+/g, ' ').slice(0, 110);
      button.appendChild(title);
      button.appendChild(sub);
      el.slashMenu.appendChild(button);
    });

    const active = state.slashItems[state.slashIndex];
    if (active) el.workshopInput.setAttribute('aria-activedescendant', `slash-opt-${active.id}`);
    const activeEl = el.slashMenu.querySelector('.is-active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }

  function chooseMeta(id) {
    const next = Number(id);
    // A thread system message belongs to the meta-prompt that started
    // it; carrying it onto a different one would answer under rules
    // the new prompt never set.
    if (state.thread && state.thread.metaPromptId !== next) endThread();
    state.metaPromptId = next;
    closeSlashMenu();
    // "/" typed to open the picker is a command, not content.
    if (el.workshopInput.value.trim() === '/') el.workshopInput.value = '';
    renderWorkshop();
    el.workshopInput.focus();
  }

  /* The assembled request, shown before it is sent.

     Two modes, and which one applies is a property of the meta-prompt
     rather than a setting:

       · no {{input}}  — the meta-prompt is the system message and the
                         input is a separate user message.
       · {{input}}     — the input is substituted at that exact spot
                         inside the meta-prompt, and the user message
                         becomes a short stand-in.

     Nothing is parsed out of the meta-prompt's own markup. A <prompt>
     tag, or any other structure, is just text unless {{input}} sits
     inside it — so this panel exists to make that visible instead of
     leaving it to be inferred from the output. */
  function renderSendPreview() {
    const meta = Cloud.getPrompts().find(p => p.id === state.metaPromptId);
    const body = el.sendPreviewBody;
    const summary = el.sendPreviewSummary;
    if (!body || !summary) return;

    if (!meta) {
      summary.textContent = 'How this is sent';
      body.innerHTML = '<p class="send-preview-note">Pick a meta-prompt first — press / in the composer.</p>';
      return;
    }

    const input = el.workshopInput.value;
    const assembled = Runner.assemble(meta.text, input);

    // The chip is narrow, so it carries the distinction and the panel
    // carries the detail.
    summary.textContent = assembled.interpolated
      ? 'Input goes inside {{input}}'
      : 'Input sent as a user message';

    /* Clamped, never scrollable. A scroll box nested inside another
       scroll box is two scrollbars competing for the same gesture,
       and it made a long system prompt genuinely hard to read here.
       Long blocks fade out and send you to the full viewer instead. */
    const CLAMP_LINES = 6;
    const block = (role, text, hint) => {
      const body = String(text || '');
      const clamped = body.split('\n').length > CLAMP_LINES || body.length > 420;
      return `<div class="send-block${clamped ? ' is-clamped' : ''}">
         <span class="send-role">${escapeHtml(role)}</span>
         ${hint ? `<span class="send-hint">${escapeHtml(hint)}</span>` : ''}
         <pre>${escapeHtml(body) || '<em>(empty)</em>'}</pre>
       </div>`;
    };

    body.innerHTML =
      block('system', assembled.system,
        assembled.interpolated ? `${meta.title} — with your input substituted` : meta.title) +
      block('user', assembled.user,
        assembled.interpolated ? 'a stand-in, because the input is already inline' : 'your input') +
      // The escape hatch sits where the frustration is, not only in
      // the pane header where it is easy to miss.
      `<button class="btn btn-secondary send-preview-open" type="button" data-open-full-prompt>
         <i class="fas fa-up-right-and-down-left-from-center"></i> Read the full system prompt
       </button>` +
      (assembled.interpolated ? '' :
        `<p class="send-preview-note">To place the input somewhere specific inside the meta-prompt instead — inside a <code>&lt;prompt&gt;</code> tag, say — put <code>{{input}}</code> at that spot and this panel will follow.</p>`);
  }

  /* RUN STATE

     idle → thinking → (streaming) → idle.

     "thinking" exists because eight of the nine providers do not
     stream: runner.js marks only Anthropic `streams: true`, so for
     everything else the whole call is one silent wait. The longest
     recorded run in History is 28.8s. All the app used to show for
     that was the word "Running…" in a caption, which is the same
     thing a hung request looks like. Now it shows a live clock, a
     breathing orb, and a label that moves with the clock, so a slow
     answer is legibly different from a broken one. */
  /* Run state, spoken.

     The thread itself is deliberately NOT an aria-live region: it
     was one, and a streaming answer in a live region is re-announced
     on every token, which is unusable. This is a separate polite
     channel that carries only the transitions — started, finished,
     failed — so the run is followable without listening to it
     arrive one word at a time. */
  function announce(message) {
    if (!el.threadLive) return;
    el.threadLive.textContent = message;
  }

  function setRunPhase(phase) {
    state.runPhase = phase;
    state.running = phase !== 'idle';

    el.workshopRunBtn.hidden = state.running;
    el.workshopStopBtn.hidden = !state.running;
    // The composer stays editable while a run is in flight: the next
    // refinement is usually being typed before the current answer
    // lands, and disabling it threw that away.
    el.workshopRunBtn.disabled = state.running;

    if (state.running) startElapsed();
    else stopElapsed();

    updateRunControls();
  }

  function startElapsed() {
    if (state.elapsedTimer) return;
    state.runStartedAt = Date.now();
    state.elapsedTimer = setInterval(paintElapsed, 100);
    paintElapsed();
  }

  function stopElapsed() {
    clearInterval(state.elapsedTimer);
    state.elapsedTimer = null;
  }

  /* THE WAIT, IN WORDS

     The clock was already honest and already useless on its own: at
     four seconds and at forty it reads the same way, a number next
     to the fixed word "Thinking". On the eight providers that do not
     stream there is nothing else on screen, so a slow call and a
     hung one are the same picture.

     The word now moves with the clock. It does not claim to know
     which of the two is happening — nothing here can know that —
     only that this run has passed the point where the answer would
     usually have landed, which is the fact a person needs to decide
     whether to keep waiting or press Stop.

     Descending, so `find` returns the first rung the clock has
     passed. The 0 rung is what guarantees a match. */
  const WAIT_LADDER = [
    [45, 'Still going'],
    [20, 'Taking a while'],
    [8, 'Still thinking'],
    [0, 'Thinking']
  ];

  /* Written straight into the node rather than through a re-render:
     ten times a second through renderThread would rebuild the whole
     exchange, and a rebuild mid-stream loses the caret position and
     the scroll. */
  function paintElapsed() {
    const chip = el.workshopThread.querySelector('.run-state');
    if (!chip) return;

    const seconds = (Date.now() - state.runStartedAt) / 1000;
    const clock = chip.querySelector('.elapsed');
    if (clock) clock.textContent = `${seconds.toFixed(1)}s`;

    /* Only the silent wait gets the ladder. Once tokens are arriving
       the label belongs to the stream, and the answer appearing on
       screen is its own proof that nothing is stuck. */
    if (state.runPhase !== 'thinking') return;
    const label = chip.querySelector('span:not(.elapsed)');
    const rung = WAIT_LADDER.find(([at]) => seconds >= at)[1];
    // Ten times a second, so only write when it actually changed.
    if (label && label.textContent !== rung) label.textContent = rung;
  }

  function updateRunControls() {
    const hasText = el.workshopInput.value.trim().length > 0;
    const meta = selectedMeta();
    const hasKey = Settings.hasKey(Settings.readCredentials().provider);
    if (!state.running) {
      // A first run may be sent with an empty composer — some
      // meta-prompts need no input at all. A refinement may not:
      // an empty follow-up asks the model nothing.
      const continuing = Boolean(state.thread && threadReplies() > 0);
      el.workshopRunBtn.disabled = !meta || !hasKey || (continuing && !hasText);
    }
    el.workshopClearBtn.hidden = !state.thread && !hasText;
  }

  /* THE EXCHANGE

     v2 was specified as one request and one response with no
     conversation state. That is still what a first Run is — but an
     output you nearly like is worth another turn rather than a
     rewritten meta-prompt, so a thread can now continue.

     state.thread holds the whole exchange:
       system    the assembled meta-prompt, fixed for the thread
       messages  alternating user/assistant turns, oldest first

     The system message never changes once a thread starts. Rebuilding
     it from a since-edited meta-prompt mid-exchange would silently
     change the rules the earlier turns were answered under. */

  // ─────────────────────────────────────────────
  // OUTPUT FORMATTING
  // ─────────────────────────────────────────────

  /* Model output is Markdown far more often than not — headings,
     numbered steps, fenced code — and reading it as one wall of
     monospace throws all of that away.

     Rendering is safe to do on text the model wrote because
     markdown.js escapes every character of the source before it
     parses anything, and the only tags in the result are the ones it
     builds itself. Raw HTML in the output shows up as the characters
     that were typed, and a link is only followed if its scheme is
     http, https or mailto. That property is the whole reason this
     renderer is reused instead of a CDN one. */
  function paintText(container, text, mode) {
    container.textContent = '';
    const raw = String(text || '');

    if (mode === 'markdown' && window.PromptMarkdown) {
      container.className = 'turn-text is-rendered';
      container.innerHTML = window.PromptMarkdown.render(raw);
      decorateCodeBlocks(container, raw);
      return;
    }
    container.className = 'turn-text';
    container.textContent = raw;
  }

  /* A copy button per fenced block. The model's answer is frequently a
     prompt or a snippet meant to be lifted whole, and selecting it by
     hand out of a scrolling pane is the fiddliest part of using this. */
  function decorateCodeBlocks(container) {
    container.querySelectorAll('pre').forEach(pre => {
      if (pre.querySelector('.code-copy')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'code-copy';
      button.textContent = 'Copy';
      button.addEventListener('click', () => {
        const code = pre.querySelector('code');
        copyText(code ? code.textContent : pre.textContent, 'Code copied.');
      });
      pre.appendChild(button);
    });
  }

  /* One setting, three places that show it: the composer bar, the
     reader's own header, and every rendered turn. The buttons are
     found by attribute rather than by id so the reader's pair is
     picked up without a second handler to keep in step. */
  function setOutputMode(mode) {
    state.outputMode = mode === 'raw' ? 'raw' : 'markdown';
    Settings.writePrefs({ outputMode: state.outputMode });
    document.querySelectorAll('[data-output-mode]').forEach(button => {
      const active = button.dataset.outputMode === state.outputMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    renderThread();
    if (el.readerDialog.open) renderReader();
  }

  // ─────────────────────────────────────────────
  // FULL PROMPT VIEWER
  // ─────────────────────────────────────────────

  /* The meta-prompt pane shows the first line and a scrollbar, which
     is no way to read a prompt of any length. This opens the whole
     thing — the assembled system message, exactly as it will be sent,
     not the stored text — so what you read is what runs. */
  function openPromptView() {
    const meta = Cloud.getPrompts().find(p => p.id === state.metaPromptId);
    if (!meta) { showToast('Pick a meta-prompt first.'); return; }

    const assembled = Runner.assemble(meta.text, el.workshopInput.value);
    state.promptView = { title: meta.title, text: assembled.system, id: meta.id };

    el.promptViewTitle.textContent = meta.title;
    el.promptViewNote.textContent = assembled.interpolated
      ? 'Your input has been substituted at {{input}}. This is the exact system message that will be sent.'
      : 'This is the exact system message that will be sent. Your input goes in a separate user message.';

    renderPromptView();
    openDialog(el.promptViewDialog);
  }

  function renderPromptView() {
    if (!state.promptView) return;
    paintText(el.promptViewBody, state.promptView.text, state.promptViewMode);
    el.promptViewBody.classList.add('prompt-view-body');
    document.querySelectorAll('[data-prompt-mode]').forEach(button => {
      const active = button.dataset.promptMode === state.promptViewMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  // ─────────────────────────────────────────────
  // READING MODE
  // ─────────────────────────────────────────────

  /* One answer, the whole viewport.

     An article summary is a document, and in the thread it is read
     through a slot between the turn above it and the composer below
     it. On a phone that slot is a few hundred pixels of a screen
     whose other half is chrome. This hands the viewport to a single
     turn: no composer, no receipt, no neighbouring turns, a reading
     measure and type a size up.

     Deliberately NOT the Fullscreen API. Safari on iPhone implements
     requestFullscreen on no element at all, so on the device this
     was asked for it would silently do nothing. A modal <dialog>
     fills the viewport, makes the rest of the page inert, and gets
     Esc and focus containment from the platform.

     The turn is held by index, not by value: the same index, read
     twice, is the same live turn — and a turn's `run` receipt is
     attached after the answer arrives, so a snapshot taken at open
     time would go stale while the reader was on screen. */
  function openReader(index) {
    const turn = turnAt(index);
    // Nothing to read in a failure: the error sits in the thread with
    // its hint, which is where it is actionable.
    if (!turn || turn.failed || !turn.content) return;
    state.readerIndex = index;
    renderReader();
    openDialog(el.readerDialog, el.readerBody);
  }

  function renderReader() {
    if (state.readerIndex === null) return;
    const turn = turnAt(state.readerIndex);
    // The exchange can end underneath an open reader — Clear, or a
    // meta-prompt swap. Close rather than paint a turn that is gone.
    if (!turn || !turn.content) { closeDialog(el.readerDialog); return; }

    el.readerTitle.textContent = (state.thread && state.thread.metaPromptTitle) || 'Output';
    paintText(el.readerText, turn.content, state.outputMode);
    el.readerMeta.textContent = counts(turn.content);
  }

  el.readerCopy.addEventListener('click', () => {
    const turn = turnAt(state.readerIndex);
    // The Markdown source, never the rendered HTML — the same rule
    // the per-turn Copy follows.
    if (turn && turn.content) copyText(turn.content, 'Output copied.');
  });

  // Esc, the backdrop and the close button all end at the same place,
  // so the index is cleared on `close` rather than in a handler that
  // only one of the three routes reaches.
  el.readerDialog.addEventListener('close', () => { state.readerIndex = null; });

  /* THE EXCHANGE

     state.thread holds the whole conversation:
       system    the assembled meta-prompt, fixed for the thread
       messages  alternating user/assistant turns, oldest first

     The system message never changes once a thread starts.
     Rebuilding it from a since-edited meta-prompt mid-exchange would
     silently change the rules the earlier turns were answered under.

     Each turn also carries what to SHOW, which is not always what
     was sent. When the meta-prompt contains {{input}} the first user
     message on the wire is the stand-in "Follow the instructions
     above…", and showing that instead of what you typed would be a
     lie about your own question. `display` holds your words; that is
     why the first turn can now be rendered at all, where the old
     view skipped it. */
  function startThread(meta, input) {
    const assembled = Runner.assemble(meta.text, input);
    state.thread = {
      metaPromptId: meta.id,
      metaPromptTitle: meta.title,
      system: assembled.system,
      originalInput: input,
      messages: [{
        role: 'user',
        content: assembled.user,
        display: String(input || '').trim() || '(no input — the meta-prompt runs on its own)'
      }]
    };
    return state.thread;
  }

  function endThread() {
    state.thread = null;
    state.lastRun = null;
    renderThread();
    updateRunControls();
    // A reader must not outlive the turn it is reading. renderReader
    // closes itself when the turn is gone; this is what reaches it.
    if (el.readerDialog.open) renderReader();
  }

  // ─────────────────────────────────────────────
  // THREAD RENDERING
  // ─────────────────────────────────────────────

  function turnEl(cls) {
    const node = document.createElement('div');
    node.className = cls;
    return node;
  }

  function runStateChip(phase, label) {
    const chip = turnEl('run-state');
    chip.dataset.state = phase;

    if (phase === 'thinking' || phase === 'streaming') {
      chip.appendChild(turnEl('run-mark is-spinning'));
    } else if (phase === 'ok') {
      chip.appendChild(turnEl('run-mark is-done'));
    }

    const text = document.createElement('span');
    text.textContent = label;
    chip.appendChild(text);

    if (phase === 'thinking' || phase === 'streaming') {
      const clock = document.createElement('span');
      clock.className = 'elapsed';
      clock.textContent = '0.0s';
      chip.appendChild(clock);
    }
    return chip;
  }

  /* One assistant turn: the answer, its receipt, and the actions that
     belong to THAT answer. The four buttons this replaces sat under
     the whole pane and acted on whichever reply happened to be last,
     which in a multi-turn exchange is not a thing you can point at. */
  function buildAssistantTurn(turn, index) {
    const block = turnEl('turn turn-assistant' + (turn.failed ? ' turn-failed' : ''));

    const head = turnEl('turn-head');
    const label = turnEl('turn-label');
    label.innerHTML = '<i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i> Model';
    head.appendChild(label);
    if (turn.run) {
      head.appendChild(runStateChip(turn.run.status === 'error' ? 'error' : 'ok',
        turn.run.status === 'error' ? 'Failed' : 'Done'));
    }
    block.appendChild(head);

    const body = turnEl('turn-body');
    if (turn.failed) {
      const box = turnEl('run-error');
      const strong = document.createElement('strong');
      strong.textContent = turn.content || 'The run failed.';
      box.appendChild(strong);
      if (turn.hint) {
        const span = document.createElement('span');
        span.textContent = turn.hint;
        box.appendChild(span);
      }
      body.appendChild(box);
    } else {
      const text = document.createElement('div');
      paintText(text, turn.content, state.outputMode);
      body.appendChild(text);
    }
    block.appendChild(body);

    if (turn.run) block.appendChild(buildReceipt(turn.run));

    if (!turn.failed) {
      const actions = turnEl('turn-actions');
      // First, because on a phone reading it is what you came to do.
      actions.appendChild(turnAction('fa-up-right-and-down-left-from-center', 'Read', 'read', index));
      actions.appendChild(turnAction('fa-copy', 'Copy', 'copy', index));
      actions.appendChild(turnAction('fa-book', 'Save to Library', 'save-library', index));
      actions.appendChild(turnAction('fa-note-sticky', 'Drop to Scratch', 'save-scratch', index));
      if (turn.run) actions.appendChild(turnAction('fa-receipt', 'Receipt', 'receipt', index));
      block.appendChild(actions);
    }
    return block;
  }

  function turnAction(icon, label, action, index) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'turn-action';
    button.dataset.turnAction = action;
    button.dataset.turnIndex = String(index);
    button.innerHTML = `<i class="fas ${icon}" aria-hidden="true"></i> ${escapeHtml(label)}`;
    return button;
  }

  function buildReceipt(run) {
    const box = turnEl('turn-receipt');
    const bits = [];
    if (run.status === 'error') {
      bits.push(run.requestedModel || '—');
    } else {
      const swapped = run.servedModel && run.requestedModel && run.servedModel !== run.requestedModel;
      bits.push((run.servedModel || run.requestedModel || '—') + (swapped ? ' (swapped)' : ''));
      bits.push(`${(run.inputTokens || 0).toLocaleString()}→${(run.outputTokens || 0).toLocaleString()} tok`);
      bits.push(formatCost(run.costUsd));
    }
    bits.push(`${((run.durationMs || 0) / 1000).toFixed(1)}s`);
    bits.forEach((bit, i) => {
      if (i) {
        const sep = document.createElement('span');
        sep.className = 'receipt-sep';
        sep.textContent = '·';
        box.appendChild(sep);
      }
      const span = document.createElement('span');
      span.textContent = bit;
      box.appendChild(span);
    });
    return box;
  }

  function buildUserTurn(turn, isFirst) {
    const block = turnEl('turn turn-user');
    const head = turnEl('turn-head');
    const label = turnEl('turn-label');
    label.innerHTML = isFirst
      ? '<i class="fas fa-arrow-right-long" aria-hidden="true"></i> Your input'
      : '<i class="fas fa-arrow-turn-up" aria-hidden="true"></i> You asked for a change';
    head.appendChild(label);
    block.appendChild(head);

    const body = turnEl('turn-body');
    const text = turnEl('turn-text');
    text.textContent = turn.display || turn.content;
    body.appendChild(text);
    block.appendChild(body);
    return block;
  }

  function renderThread({ streaming = false } = {}) {
    const thread = state.thread;
    el.workshopThread.innerHTML = '';

    if (!thread) {
      el.workshopThread.appendChild(buildThreadEmpty());
      return;
    }

    thread.messages.forEach((turn, index) => {
      el.workshopThread.appendChild(turn.role === 'user'
        ? buildUserTurn(turn, index === 0)
        : buildAssistantTurn(turn, index));
    });

    if (streaming) el.workshopThread.appendChild(buildLiveTurn());
    scrollThread();
  }

  /* The turn being generated. Until the first token arrives it is an
     orb, because "waiting" and "empty" have to look different. */
  function buildLiveTurn() {
    const block = turnEl('turn turn-assistant');
    const head = turnEl('turn-head');
    const label = turnEl('turn-label');
    label.innerHTML = '<i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i> Model';
    head.appendChild(label);
    head.appendChild(runStateChip(state.runPhase === 'streaming' ? 'streaming' : 'thinking',
      state.runPhase === 'streaming' ? 'Streaming' : 'Thinking'));
    block.appendChild(head);

    const body = turnEl('turn-body');
    const orb = turnEl('thinking-orb');
    orb.id = 'live-orb';
    orb.appendChild(turnEl('orb-core'));
    body.appendChild(orb);

    const text = turnEl('turn-text is-streaming');
    text.id = 'live-turn';
    text.hidden = true;
    body.appendChild(text);

    block.appendChild(body);
    return block;
  }

  function buildThreadEmpty() {
    const box = turnEl('thread-empty');
    const list = metaPrompts();
    const icon = turnEl('empty-state-icon');
    icon.innerHTML = `<i class="fas fa-${list.length ? 'wand-magic-sparkles' : 'screwdriver-wrench'}"></i>`;
    box.appendChild(icon);

    const h2 = document.createElement('h2');
    const p = document.createElement('p');
    if (!list.length) {
      h2.textContent = 'No meta-prompts yet';
      p.textContent = 'A meta-prompt is the prompt that writes your prompts. Create one to start running.';
      box.appendChild(h2);
      box.appendChild(p);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn';
      button.dataset.openPrompt = '';
      button.dataset.sectionHint = 'workshop';
      button.innerHTML = '<i class="fas fa-plus"></i> New meta-prompt';
      box.appendChild(button);
    } else {
      const meta = selectedMeta();
      h2.textContent = meta ? meta.title : 'Pick a meta-prompt';
      p.textContent = meta
        ? 'Paste what you want worked on below, then Run. The answer, the receipt and what to do with it all land here.'
        : 'Press / in the composer to choose which meta-prompt to run.';
      box.appendChild(h2);
      box.appendChild(p);
    }
    return box;
  }

  /* Only scrolls when the reader is already at the bottom. Yanking a
     pane down while someone is reading an earlier turn is worse than
     not following the stream at all. */
  function scrollThread(force) {
    const box = el.threadScroll;
    if (!box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    if (force || atBottom) box.scrollTop = box.scrollHeight;
  }

  // ─────────────────────────────────────────────
  // RUNNING
  // ─────────────────────────────────────────────

  /**
   * One turn of the exchange. With no argument it takes whatever is
   * in the composer: that starts a thread, or continues one if a
   * reply is already on screen. There is no second input to keep in
   * sync, which is what the old refine box was.
   *
   * Every turn is recorded in History as its own run — a refinement
   * costs tokens and can fail exactly like a first attempt, so it
   * earns its own receipt.
   */
  async function runWorkshop() {
    const meta = selectedMeta();
    if (!meta) { showToast('Pick a meta-prompt first — press / in the composer.'); return; }

    const creds = Settings.readCredentials();
    if (!creds.keys[creds.provider]) {
      showToast('Add an API key in Settings first.');
      openSettings();
      return;
    }

    const typed = el.workshopInput.value;
    const isRefine = Boolean(state.thread && threadReplies() > 0);
    if (isRefine && !typed.trim()) { el.workshopInput.focus(); return; }

    if (isRefine) {
      state.thread.messages.push({ role: 'user', content: typed.trim() });
    } else {
      startThread(meta, typed);
    }

    /* The exchange this run belongs to, held by reference for the
       rest of the function. A run is awaited, and the thread can be
       ended underneath it while it is in flight — Clear does it, and
       so does copying a prompt into Workshop from another section.
       Reading state.thread after the await then finds null and the
       answer lands on a TypeError. Writing into the captured object
       instead cannot throw: if it is still the current thread the
       turn appears, and if it is not, the object is orphaned and the
       answer is dropped — but the History row is still written, so
       the tokens that were spent are still accounted for. */
    const thread = state.thread;

    // The composer empties on send, the way a composer should: what
    // you typed is now visible as a turn, so leaving it in the box
    // as well would show it twice.
    el.workshopInput.value = '';
    autoGrowComposer();
    state.lastRun = null;

    setRunPhase('thinking');
    announce(isRefine ? 'Sending your change. Waiting for the model.' : `Running ${meta.title}. Waiting for the model.`);
    renderThread({ streaming: true });
    scrollThread(true);
    renderWorkshopChrome();

    const live = document.getElementById('live-turn');
    const orb = document.getElementById('live-orb');
    state.abortController = new AbortController();
    const startedAt = Date.now();
    let receipt = null;
    let failure = null;
    let sawDelta = false;

    try {
      receipt = await Runner.run({
        system: thread.system,
        messages: thread.messages,
        maxTokens: Cloud.getSettings().defaultMaxTokens,
        signal: state.abortController.signal,
        onDelta: chunk => {
          if (!live) return;
          if (!sawDelta) {
            // The first token: the orb has served its purpose.
            sawDelta = true;
            state.runPhase = 'streaming';
            if (orb) orb.remove();
            live.hidden = false;
            const chip = el.workshopThread.querySelector('.run-state');
            if (chip) {
              chip.dataset.state = 'streaming';
              const label = chip.querySelector('span:not(.elapsed)');
              if (label) label.textContent = 'Streaming';
            }
          }
          live.textContent += chunk;
          scrollThread();
        }
      });
    } catch (error) {
      failure = error;
    } finally {
      setRunPhase('idle');
      state.abortController = null;
    }

    const aborted = failure && failure.name === 'AbortError';

    if (receipt) {
      thread.messages.push({ role: 'assistant', content: receipt.text });
    } else if (isRefine) {
      /* The refinement never got an answer, so drop it back out of
         the thread. Leaving it would send the same unanswered turn
         again on the next attempt and read as a question the model
         ignored. */
      thread.messages.pop();
      // …and give the user their words back, since the composer was
      // cleared on send and they are otherwise gone. Only if the
      // exchange is still the one on screen — pushing them back into
      // a composer the user has since cleared would undo the clear.
      if (state.thread === thread) {
        el.workshopInput.value = typed;
        autoGrowComposer();
      }
    }

    if (aborted) {
      renderThread();
      announce('Run stopped.');
      showToast('Run stopped.');
      renderWorkshopChrome();
      return;
    }

    // A history row is written for success AND failure. A run that
    // errored is exactly the one you want to find later.
    const record = {
      id: Cloud.newId(),
      metaPromptId: meta.id,
      metaPromptTitle: isRefine ? `${meta.title} — refinement` : meta.title,
      provider: receipt ? receipt.provider : creds.provider,
      requestedModel: receipt ? receipt.requestedModel : Settings.resolveModel(creds.provider, creds),
      servedModel: receipt ? receipt.servedModel : '',
      responseId: receipt ? receipt.responseId : '',
      promptVersion: receipt ? receipt.promptVersion : Runner.PROMPT_VERSION,
      input: isRefine ? typed.trim() : typed,
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

    // The receipt is attached to the turn it belongs to, so every
    // answer keeps its own cost and latency instead of one caption
    // describing only the most recent.
    if (receipt) {
      const last = thread.messages[thread.messages.length - 1];
      last.run = state.lastRun;
    } else {
      thread.messages.push({
        role: 'assistant',
        failed: true,
        content: failure ? (failure.message || 'The run failed.') : 'The run failed.',
        hint: failure && failure.hint ? failure.hint : '',
        run: state.lastRun
      });
    }

    if (receipt) {
      const words = String(receipt.text || '').trim().split(/\s+/).filter(Boolean).length;
      announce(`Answer received — about ${words.toLocaleString()} words in ${(receipt.durationMs / 1000).toFixed(1)} seconds.`);
    } else {
      announce(`Run failed: ${failure ? failure.message || 'unknown error' : 'unknown error'}`);
    }

    renderThread();
    scrollThread(true);
    renderWorkshopChrome();
    render();
  }

  /* Chrome only — the chips, the button label, the hint. Separate
     from renderWorkshop because that one also rebuilds the thread,
     and rebuilding the thread from inside a run would throw away the
     streaming node the run is still writing into. */
  function renderWorkshopChrome() {
    const meta = selectedMeta();
    const creds = Settings.readCredentials();
    const hasKey = Boolean(creds.keys[creds.provider]);
    const continuing = Boolean(state.thread && threadReplies() > 0);
    el.workshopRunLabel.textContent = continuing ? 'Send' : 'Run';
    el.composerHint.textContent = !metaPrompts().length
      ? 'Create a meta-prompt to start running.'
      : !hasKey
        ? 'Add an API key in Settings to run.'
        : continuing
          ? 'Continuing this exchange — the meta-prompt stays fixed.'
          : 'Press / to switch meta-prompt.';
    el.composerMetaName.textContent = meta ? meta.title : 'Pick a meta-prompt';
    updateRunControls();
  }

  /* The composer grows with its content up to the cap in the
     stylesheet, so a one-line note gets one line and a pasted
     article gets a scrollbar — rather than both getting the same
     fixed box, which is what a `rows` attribute buys you. */
  function autoGrowComposer() {
    const box = el.workshopInput;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight}px`;
  }

  function turnAt(index) {
    return state.thread && state.thread.messages[index] ? state.thread.messages[index] : null;
  }

  function saveTurnOutput(index, section) {
    const turn = turnAt(index);
    if (!turn || !turn.content) return;
    const meta = selectedMeta();
    const id = Cloud.newId();
    const prompt = {
      id,
      title: `${meta ? meta.title : 'Run'} — ${formatDate(Date.now())}`,
      text: turn.content,
      category: '',
      tags: [],
      notes: turn.run
        ? `From a ${turn.run.servedModel || turn.run.requestedModel} run.`
        : 'From a Workshop run.',
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
    if (turn.run) {
      Cloud.updateRun(turn.run.id, { savedPromptId: id })
        .catch(error => console.error('[ui] could not link run to prompt', error));
    }

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

  /* GROUPING

     The list was flat reverse-chron, so a run from ten minutes ago
     and one from three weeks ago were told apart only by a timestamp
     you had to stop and read. It is now grouped by day, with the
     day's totals on the heading — which is the question you actually
     bring to a run log ("what did today cost?").

     Repeats collapse too. A real History held this, three times in a
     row and identically:

       Clean Up Prompt — refinement · FAILED · toChatMessages is not defined

     That is one fact reported three times. Consecutive failures with
     the same message and the same meta-prompt fold into the first
     row with a count you can expand. Never while selecting, though:
     a checkbox on a folded row would claim to select runs it does
     not cover. */
  function dayKeyOf(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function dayLabelOf(ms) {
    const now = new Date();
    const then = new Date(ms);
    if (dayKeyOf(now.getTime()) === dayKeyOf(ms)) return 'Today';
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (dayKeyOf(yesterday.getTime()) === dayKeyOf(ms)) return 'Yesterday';
    const sixDays = now.getTime() - 6 * 86400000;
    if (ms > sixDays) return then.toLocaleDateString(undefined, { weekday: 'long' });
    return then.toLocaleDateString(undefined, {
      month: 'short', day: 'numeric',
      year: then.getFullYear() === now.getFullYear() ? undefined : 'numeric'
    });
  }

  function sameFailure(a, b) {
    return a.status === 'error' && b.status === 'error' &&
      (a.errorMessage || '') === (b.errorMessage || '') &&
      (a.metaPromptTitle || '') === (b.metaPromptTitle || '');
  }

  function groupRuns(list, collapse) {
    const sorted = list.slice().sort((a, b) => b.createdAt - a.createdAt);
    const days = [];
    sorted.forEach(run => {
      const key = dayKeyOf(run.createdAt);
      let day = days[days.length - 1];
      if (!day || day.key !== key) {
        day = { key, label: dayLabelOf(run.createdAt), runs: [], entries: [] };
        days.push(day);
      }
      day.runs.push(run);

      const prev = day.entries[day.entries.length - 1];
      if (collapse && prev && sameFailure(prev.run, run)) prev.repeats.push(run);
      else day.entries.push({ run, repeats: [] });
    });
    return days;
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
    renderHistoryChips();

    if (!list.length) {
      const filtering = Cloud.getRuns().length > 0;
      el.historyList.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon"><i class="fas fa-clock-rotate-left"></i></div>
          <h2>${filtering ? 'No runs match these filters' : 'No runs yet'}</h2>
          <p>${filtering
            ? 'Try widening the date range or clearing a filter.'
            : 'Every run you make in the Workshop is recorded here — including the ones that fail.'}</p>
          ${filtering
            ? '<button class="btn btn-secondary" type="button" data-action="clear-history-filters"><i class="fas fa-xmark"></i> Clear filters</button>'
            : ''}
        </div>`;
      updateSelectionCount();
      staggerRows = false;
      return;
    }

    let row = 0;
    groupRuns(list, !state.selectMode).forEach(day => {
      const section = document.createElement('div');
      section.className = 'run-day';

      const head = document.createElement('div');
      head.className = 'run-day-head';
      const h3 = document.createElement('h3');
      h3.textContent = day.label;
      const summary = document.createElement('span');
      summary.className = 'run-day-summary';
      summary.textContent = dayTotals(day.runs);
      head.appendChild(h3);
      head.appendChild(summary);
      section.appendChild(head);

      day.entries.forEach(entry => {
        section.appendChild(stagger(createHistoryRow(entry.run, entry.repeats), row++));
        if (entry.repeats.length && state.expandedRepeats.has(entry.run.id)) {
          entry.repeats.forEach(repeat => {
            const node = createHistoryRow(repeat, []);
            node.classList.add('is-repeat');
            section.appendChild(stagger(node, row++));
          });
        }
      });

      el.historyList.appendChild(section);
    });

    updateSelectionCount();
    staggerRows = false;
  }

  function dayTotals(runs) {
    const cost = runs.reduce((sum, r) => sum + (Number(r.costUsd) || 0), 0);
    const tokens = runs.reduce((sum, r) => sum + (r.inputTokens || 0) + (r.outputTokens || 0), 0);
    const failed = runs.filter(r => r.status === 'error').length;
    const bits = [`${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`];
    if (failed) bits.push(`${failed} failed`);
    if (tokens) bits.push(`${tokens.toLocaleString()} tok`);
    if (cost > 0) bits.push(formatCost(cost));
    return bits.join(' · ');
  }

  function createHistoryRow(run, repeats) {
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
    const count = (repeats || []).length;
    const open = state.expandedRepeats.has(run.id);

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
          <span>${escapeHtml(new Date(run.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))}</span>
          <span>${escapeHtml(model)}${swapped ? ' (swapped)' : ''}</span>
          <span>${run.inputTokens.toLocaleString()}→${run.outputTokens.toLocaleString()} tok</span>
          <span>${escapeHtml(formatCost(run.costUsd))}</span>
          <span>${(run.durationMs / 1000).toFixed(1)}s</span>
        </span>
      </button>
      <div class="history-actions">
        ${count ? `<button class="repeat-badge" type="button" data-run-repeats="${run.id}" aria-expanded="${open}" title="${open ? 'Fold these back up' : 'This failed ' + (count + 1) + ' times in a row'}">×${count + 1} <i class="fas fa-chevron-${open ? 'up' : 'down'}"></i></button>` : ''}
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

    /* Only the active provider gets a row. Rendering all nine next to
       a separate "active provider" dropdown made it easy to type a key
       into one provider while another was the one that would actually
       run — which reads as "no API key" on a provider you just
       configured. One row means the key you enter is always the key
       that gets used. Switching the dropdown swaps the row; keys for
       the others stay stored and come back when reselected. */
    const id = creds.provider;
    const meta = Settings.PROVIDERS[id];
    const configured = Settings.PROVIDER_IDS
      .filter(other => other !== id && creds.keys[other])
      .map(other => Settings.PROVIDERS[other].label);

    el.providerRows.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'provider-row';
    row.dataset.provider = id;
    row.innerHTML = `
      <div class="provider-row-head">
        <strong>${escapeHtml(meta.label)}</strong>
        <span class="provider-print">${escapeHtml(Settings.fingerprint(creds.keys[id]))}</span>
        <a class="provider-key-link" href="${escapeHtml(meta.keysUrl)}" target="_blank" rel="noreferrer noopener">Get a key</a>
        <button class="btn" type="button" data-test-provider="${id}"><i class="fas fa-plug"></i> Test connection</button>
      </div>
      <div class="provider-row-fields">
        <label class="sr-only" for="key-${id}">${escapeHtml(meta.label)} API key</label>
        <input type="password" id="key-${id}" data-key-input="${id}" placeholder="${escapeHtml(meta.placeholder)}" autocomplete="off" spellcheck="false">
        <label class="sr-only" for="model-${id}">${escapeHtml(meta.label)} model</label>
        <select id="model-${id}" data-model-input="${id}"></select>
      </div>
      <p class="provider-test-note" data-test-note="${id}"></p>
      <div class="provider-models" data-models="${id}" hidden></div>
      ${configured.length ? `<p class="provider-stored">Keys also stored for ${escapeHtml(configured.join(', '))}.</p>` : ''}`;
    el.providerRows.appendChild(row);

    row.querySelector(`[data-key-input="${id}"]`).value = creds.keys[id];
    populateModelSelect(id, creds);

    // Effort is an Anthropic control; the rest ignore it.
    el.settingsEffort.closest('.form-control').hidden = !meta.supportsEffort;

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
      el.paletteInput.removeAttribute('aria-activedescendant');
      return;
    }
    state.paletteItems.forEach((item, index) => {
      const active = index === state.paletteIndex;
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `palette-opt-${index}`;
      button.className = 'palette-item' + (active ? ' is-active' : '');
      button.dataset.paletteIndex = index;
      button.setAttribute('role', 'option');
      // The visual highlight moves with the arrow keys; without this
      // the announcement did not move with it.
      button.setAttribute('aria-selected', String(active));
      const icon = document.createElement('i');
      icon.className = `fas ${item.icon}`;
      icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = item.label;
      const hint = document.createElement('small');
      hint.textContent = item.hint;
      button.appendChild(icon);
      button.appendChild(label);
      button.appendChild(hint);
      el.paletteResults.appendChild(button);
    });
    // Focus stays in the text field; this is what tells a screen
    // reader which option the field is currently pointing at.
    el.paletteInput.setAttribute('aria-activedescendant', `palette-opt-${state.paletteIndex}`);
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
      const next = !state.pinnedOnly;
      /* Pinned renders into the list view. Toggling it from Workshop
         or History left those views on screen, so the filter appeared
         to do nothing at all — land on a section that can show a list
         first. setSection clears the flag, so it is set afterwards. */
      if (next && SECTION_META[state.section].view !== 'list') setSection('library');
      state.pinnedOnly = next;
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
    animateNextRender();
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
      // Every row is rebuilt in a different shape, so the reveal
      // reads as the change rather than as decoration.
      animateNextRender();
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
      'to-workshop': () => copyToWorkshop(id),
      use: () => { state.metaPromptId = id; setSection('workshop'); },
      versions: () => openVersions(id)
    };
    const action = actions[button.dataset.detailAction];
    if (action) action();
  });

  // Workshop — the composer
  //
  // The form owns the submit, so Enter behaviour, the button and the
  // keyboard shortcut all reach the same place.
  el.composer.addEventListener('submit', event => {
    event.preventDefault();
    if (!state.running) runWorkshop();
  });

  el.workshopStopBtn.addEventListener('click', () => {
    if (state.abortController) state.abortController.abort();
  });

  el.workshopInput.addEventListener('input', () => {
    autoGrowComposer();
    renderSendPreview();
    updateRunControls();

    // "/" as the first character of an empty composer opens the
    // picker; anything after it filters. Typed anywhere else it is
    // just a slash, because prompts contain slashes.
    const value = el.workshopInput.value;
    if (value.startsWith('/')) openSlashMenu(value.slice(1));
    else closeSlashMenu();
  });

  /* Composer keys. Enter sends and Shift+Enter makes a newline —
     except while the picker is open, where the keys belong to it. */
  el.workshopInput.addEventListener('keydown', event => {
    if (state.slashOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const count = state.slashItems.length;
        if (!count) return;
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        state.slashIndex = (state.slashIndex + delta + count) % count;
        renderSlashMenu();
        return;
      }
      if (event.key === 'Enter' && state.slashItems.length) {
        event.preventDefault();
        chooseMeta(state.slashItems[state.slashIndex].id);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSlashMenu();
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey && !(event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (!el.workshopRunBtn.disabled) el.composer.requestSubmit();
    }
  });

  el.composerMetaChip.addEventListener('click', () => {
    if (state.slashOpen) { closeSlashMenu(); return; }
    openSlashMenu('');
    el.workshopInput.focus();
  });

  el.slashMenu.addEventListener('click', event => {
    const button = event.target.closest('[data-meta-id]');
    if (button) chooseMeta(button.dataset.metaId);
  });

  el.composerModelChip.addEventListener('click', openSettings);

  el.composerPreviewChip.addEventListener('click', () => {
    state.previewOpen = !state.previewOpen;
    el.sendPreviewBody.hidden = !state.previewOpen;
    el.composerPreviewChip.setAttribute('aria-expanded', String(state.previewOpen));
    el.composerPreviewChip.classList.toggle('is-primary', state.previewOpen);
  });

  el.workshopClearBtn.addEventListener('click', () => {
    el.workshopInput.value = '';
    autoGrowComposer();
    closeSlashMenu();
    endThread();
    renderWorkshop();
    el.workshopInput.focus();
  });

  /* Per-turn actions, delegated: the thread is rebuilt on every
     render, so binding per button would rebind on every token. */
  el.workshopThread.addEventListener('click', event => {
    const button = event.target.closest('[data-turn-action]');
    if (!button) return;
    const index = Number(button.dataset.turnIndex);
    const turn = turnAt(index);
    if (!turn) return;

    const actions = {
      read: () => openReader(index),
      // The raw Markdown source, never the rendered HTML.
      copy: () => copyText(turn.content, 'Output copied.'),
      'save-library': () => saveTurnOutput(index, 'library'),
      'save-scratch': () => saveTurnOutput(index, 'scratch'),
      receipt: () => { if (turn.run) openRunDetail(turn.run.id); }
    };
    const action = actions[button.dataset.turnAction];
    if (action) action();
  });

  // A click anywhere else closes the picker. Pointerdown rather than
  // click, so it closes before a control underneath acts on it.
  document.addEventListener('pointerdown', event => {
    if (!state.slashOpen) return;
    if (event.target.closest('#slash-menu, #composer-meta-chip, #workshop-input')) return;
    closeSlashMenu();
  });

  document.querySelectorAll('[data-output-mode]').forEach(button => {
    button.addEventListener('click', () => setOutputMode(button.dataset.outputMode));
  });

  document.querySelectorAll('[data-prompt-mode]').forEach(button => {
    button.addEventListener('click', () => {
      state.promptViewMode = button.dataset.promptMode;
      renderPromptView();
    });
  });

  el.viewPromptBtn.addEventListener('click', openPromptView);

  // The preview is re-rendered on every keystroke, so its button is
  // reached by delegation rather than rebound each time.
  el.sendPreviewBody.addEventListener('click', event => {
    if (event.target.closest('[data-open-full-prompt]')) openPromptView();
  });

  el.promptViewCopy.addEventListener('click', () => {
    // Always the source text, never the rendered HTML.
    if (state.promptView) copyText(state.promptView.text, 'Prompt copied.');
  });

  el.promptViewEdit.addEventListener('click', () => {
    if (!state.promptView) return;
    const id = state.promptView.id;
    closeDialog(el.promptViewDialog);
    openPromptEditor(id);
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
    const repeats = event.target.closest('[data-run-repeats]');
    const clearFilters = event.target.closest('[data-action="clear-history-filters"]');

    if (clearFilters) { clearHistoryFilters(); return; }
    if (repeats) {
      const id = Number(repeats.dataset.runRepeats);
      if (state.expandedRepeats.has(id)) state.expandedRepeats.delete(id);
      else state.expandedRepeats.add(id);
      renderHistory();
      return;
    }
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

  el.settingsProvider.addEventListener('change', () => {
    // Save whatever is typed in the current row before swapping it out.
    collectCredentials();
    renderSettings();
    renderWorkshop();
  });

  el.settingsEffort.addEventListener('change', collectCredentials);

  /* `input` as well as `change`: a password field only fires `change`
     on blur, so a key typed and left focused was not saved yet, and the
     run panel went on reporting "no API key" for a provider that
     looked configured. */
  ['input', 'change'].forEach(eventName => {
    el.providerRows.addEventListener(eventName, event => {
      const keyInput = event.target.closest('[data-key-input]');
      const modelInput = event.target.closest('[data-model-input]');
      if (!keyInput && !modelInput) return;

      const creds = collectCredentials();
      const active = el.providerRows.querySelector('.provider-print');
      if (active && keyInput) {
        active.textContent = Settings.fingerprint(creds.keys[keyInput.dataset.keyInput]);
      }
      // Repopulating the model list on every keystroke would fight the
      // open dropdown, so that waits for the field to settle.
      if (eventName === 'change' && keyInput) populateModelSelect(keyInput.dataset.keyInput, creds);
      renderWorkshop();
    });
  });

  // Clicking a listed model pins it, so the list doubles as the picker.
  el.providerRows.addEventListener('click', event => {
    const chip = event.target.closest('[data-pick-model]');
    if (chip) {
      const select = el.providerRows.querySelector(`[data-model-input="${chip.dataset.pickProvider}"]`);
      if (select) {
        if (![...select.options].some(o => o.value === chip.dataset.pickModel)) {
          const option = document.createElement('option');
          option.value = chip.dataset.pickModel;
          option.textContent = chip.dataset.pickModel;
          select.appendChild(option);
        }
        select.value = chip.dataset.pickModel;
      }
      collectCredentials();
      el.providerRows.querySelectorAll('[data-pick-model]').forEach(other => {
        other.classList.toggle('is-active', other === chip);
      });
      renderWorkshop();
      showToast(`Model set to ${chip.dataset.pickModel}.`);
      return;
    }

    const button = event.target.closest('[data-test-provider]');
    if (!button) return;
    const providerId = button.dataset.testProvider;
    const creds = collectCredentials();
    const note = el.providerRows.querySelector(`[data-test-note="${providerId}"]`);
    note.className = 'provider-test-note';
    note.textContent = 'Testing…';
    button.disabled = true;

    const list = el.providerRows.querySelector(`[data-models="${providerId}"]`);

    /* Listing models IS the connection test. A 200 from that endpoint
       means the key reached the provider and was accepted, and it
       establishes that without spending a token on a throwaway
       generation. The list it returns is also the only trustworthy
       answer to "which models can this key use" — access is a property
       of the account, and it changes without warning. */
    Runner.listModels(providerId, creds.keys[providerId], { force: true })
      .then(result => {
        note.className = 'provider-test-note is-ok';
        note.textContent = `Connected. ${result.models.length} ${result.models.length === 1 ? 'model' : 'models'} available to this key.`;

        list.hidden = false;
        list.innerHTML = '';
        const active = Settings.resolveModel(providerId, Settings.readCredentials());
        result.models.forEach(model => {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'model-chip' + (model === active ? ' is-active' : '');
          chip.dataset.pickModel = model;
          chip.dataset.pickProvider = providerId;
          chip.textContent = model;
          list.appendChild(chip);
        });

        populateModelSelect(providerId, Settings.readCredentials());
        renderWorkshop();
      })
      .catch(error => {
        note.className = 'provider-test-note is-error';
        note.textContent = [error.message, error.hint].filter(Boolean).join(' ');
        list.hidden = true;
        list.innerHTML = '';
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
    /* "/" opens the palette everywhere EXCEPT the Workshop composer,
       where it opens the meta-prompt picker instead — the composer
       handles that itself, and `typing` already excludes it here. */
    if (event.key === '/' && !typing && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      openPalette();
      return;
    }
    if (meta && event.key === 'Enter' && state.section === 'workshop' && !state.running) {
      event.preventDefault();
      // One composer, so there is no longer a second box whose
      // contents this had to guess between.
      if (!el.workshopRunBtn.disabled) el.composer.requestSubmit();
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
      if (state.slashOpen) closeSlashMenu();
      else if (document.body.classList.contains('sidebar-open')) closeSidebar();
      else closePromptDetail();
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

  // Only the first occurrence of a given failure is surfaced, so a
  // retry loop cannot bury the screen in identical toasts.
  let lastSyncProblem = '';

  Cloud.on('status', ({ state: syncState, message, detail }) => {
    if (syncState === 'error' && detail && detail !== lastSyncProblem) {
      lastSyncProblem = detail;
      showToast(detail);
      console.error('[ui] sync problem:', detail);
    }
    if (syncState === 'synced') lastSyncProblem = '';
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
    // null is the common case and leaves the responsive default alone.
    applySplit(prefs.detailWidth);
    el.sortSelect.value = state.sort;
    updateViewButtons();
    setOutputMode(state.outputMode);

    /* The shortcut has always worked; nothing said so. Label it with
       the modifier this machine actually uses — telling a Windows user
       to press ⌘ is worse than saying nothing. */
    const isMac = /Mac|iPhone|iPad/.test(
      (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent
    );
    const runKbd = $('run-kbd');
    if (runKbd) runKbd.textContent = isMac ? '⌘↵' : 'Ctrl+↵';
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

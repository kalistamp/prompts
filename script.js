// These are public browser credentials. The service-role key must never be
// placed in this repository or sent to the browser.
const SUPABASE_CONFIG = {
    url: "https://baiojghilzxhkebfblzv.supabase.co",
    publishableKey: "sb_publishable_nfLVr5Krdld9pxxr4f2CYQ_bsn0TNxx",
    schema: "prompts"
};

const LOCAL_DB_NAME = 'prompt-studio';
const LOCAL_DB_VERSION = 1;
const DELTA_PAGE_SIZE = 500;
const PROMPT_COLUMNS = [
    'id', 'title', 'prompt_text', 'category', 'tags', 'notes', 'pinned',
    'created_at', 'updated_at', 'sort_order', 'deleted_at', 'revision'
].join(',');

// Label for the virtual "Pinned" section rendered above the real categories.
// It is a display shortcut only — pinned prompts still live in (and also
// render inside) their own category.
const PINNED_SECTION = "📌 Pinned";

// State
let appData = {
    lastModified: 0,
    prompts: [],
    deleted: []
};
let editState = { isEditing: false, id: null };
let supabaseClient = null;
let currentUser = null;
let syncTimeout = null;
let cloudRevision = 0;
let pullPromise = null;
let flushPromise = null;
let sessionStartPromise = null;
let localDbPromise = null;
let localWriteQueue = Promise.resolve();
let pendingMutations = new Map();
let mutationSequence = 0;
let selectedPromptId = null;
let showPinnedOnly = false;
let lastFocusedElement = null;
let pendingDeleteId = null;

// View state: 'large' (Large Icons), 'list' (List), 'compact' (Compact)
let currentView = localStorage.getItem('promptManagerView') || 'large';
if (!['large', 'list', 'compact'].includes(currentView)) currentView = 'large';
// IDs of prompts whose body is currently expanded (list/compact views only).
let expandedIds = new Set();
// Categories the user has explicitly collapsed. Persisted so open/closed state
// survives re-renders (reorder/edit/toggle) AND page reloads. Absence = open.
let collapsedCategories = new Set(loadCollapsedState());

function loadCollapsedState() {
    try {
        const raw = localStorage.getItem('promptManagerCollapsed');
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

function saveCollapsedState() {
    localStorage.setItem('promptManagerCollapsed', JSON.stringify([...collapsedCategories]));
}

// DOM Elements
const themeToggle = document.getElementById('theme-toggle');
const syncBtn = document.getElementById('sync-btn');
const settingsBtn = document.getElementById('settings-btn');
const addPromptBtn = document.getElementById('add-prompt-btn');

const settingsModal = document.getElementById('settings-modal');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const signOutBtn = document.getElementById('sign-out-btn');
const accountEmail = document.getElementById('account-email');
const cloudStatus = document.getElementById('cloud-status');
const authScreen = document.getElementById('auth-screen');
const appContainer = document.getElementById('app-container');
const loginForm = document.getElementById('login-form');
const loginEmail = document.getElementById('login-email');
const loginPassword = document.getElementById('login-password');
const loginError = document.getElementById('login-error');

const promptModal = document.getElementById('prompt-modal');
const promptForm = document.getElementById('prompt-form');
const promptModalTitle = document.getElementById('prompt-modal-title');
const promptTitle = document.getElementById('prompt-title');
const promptCategory = document.getElementById('prompt-category');
const promptTags = document.getElementById('prompt-tags');
const promptText = document.getElementById('prompt-text');
const promptNotes = document.getElementById('prompt-notes');
const closePromptBtn = document.getElementById('close-prompt-btn');
const closePromptIcon = document.getElementById('close-prompt-icon');
const closeSettingsIcon = document.getElementById('close-settings-icon');
const deleteModal = document.getElementById('delete-modal');
const cancelDeleteBtn = document.getElementById('cancel-delete-btn');
const confirmDeleteBtn = document.getElementById('confirm-delete-btn');

const promptsContainer = document.getElementById('prompts-container');
const searchInput = document.getElementById('search-input');
const clearSearchBtn = document.getElementById('clear-search-btn');
const categoryFilter = document.getElementById('category-filter');
const sortSelect = document.getElementById('sort-select');
const categoryList = document.getElementById('category-list');
const editorCount = document.getElementById('editor-count');
const workspaceSidebar = document.getElementById('workspace-sidebar');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');
const sidebarCloseBtn = document.getElementById('sidebar-close-btn');
const mobileMenuBtn = document.getElementById('mobile-menu-btn');
const sidebarCategories = document.getElementById('sidebar-categories');
const allPromptsCount = document.getElementById('all-prompts-count');
const pinnedPromptsCount = document.getElementById('pinned-prompts-count');
const sidebarSyncBtn = document.getElementById('sidebar-sync-btn');
const sidebarSyncLabel = document.getElementById('sidebar-sync-label');
const sidebarStatusDot = document.getElementById('sidebar-status-dot');
const sidebarAccountEmail = document.getElementById('sidebar-account-email');
const currentViewTitle = document.getElementById('current-view-title');
const currentResultCount = document.getElementById('current-result-count');
const saveState = document.getElementById('save-state');
const saveStateLabel = document.getElementById('save-state-label');
const detailPanel = document.getElementById('detail-panel');
const detailEmpty = document.getElementById('detail-empty');
const detailContent = document.getElementById('detail-content');

// Initialize
async function init() {
    initTheme();

    // Remove obsolete Gist credentials left by an older deployment.
    localStorage.removeItem('promptGithubToken');
    localStorage.removeItem('promptGistId');

    if (!window.supabase) {
        loginError.textContent = "Cloud library failed to load. Check your connection and refresh.";
        return;
    }

    supabaseClient = window.supabase.createClient(
        SUPABASE_CONFIG.url,
        SUPABASE_CONFIG.publishableKey
    );
    supabaseClient.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT' && currentUser) endUserSession();
        if (event === 'SIGNED_IN' && session?.user) {
            setTimeout(() => startUserSession(session.user), 0);
        }
    });

    const { data, error } = await supabaseClient.auth.getSession();
    if (error) {
        loginError.textContent = error.message;
        return;
    }

    if (data.session?.user) await startUserSession(data.session.user);
}

// Theme Logic
function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.body.setAttribute('data-theme', 'dark');
    } else {
        document.body.removeAttribute('data-theme');
    }
    updateThemeUI();
}

function updateThemeUI() {
    const isDark = document.body.getAttribute('data-theme') === 'dark';
    themeToggle.innerHTML = `<i class="fas fa-${isDark ? 'sun' : 'moon'}"></i>`;
    themeToggle.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.content = isDark ? '#0b1120' : '#f5f7fb';
}

themeToggle.addEventListener('click', () => {
    if (document.body.getAttribute('data-theme') === 'dark') {
        document.body.removeAttribute('data-theme');
        localStorage.setItem('theme', 'light');
    } else {
        document.body.setAttribute('data-theme', 'dark');
        localStorage.setItem('theme', 'dark');
    }
    updateThemeUI();
});

// Data Management
function openLocalDb() {
    if (localDbPromise) return localDbPromise;
    localDbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('prompts')) {
                const store = db.createObjectStore('prompts', { keyPath: ['userId', 'id'] });
                store.createIndex('by_user', 'userId', { unique: false });
            }
            if (!db.objectStoreNames.contains('outbox')) {
                const store = db.createObjectStore('outbox', { keyPath: ['userId', 'id'] });
                store.createIndex('by_user', 'userId', { unique: false });
            }
            if (!db.objectStoreNames.contains('meta')) {
                db.createObjectStore('meta', { keyPath: 'userId' });
            }
        };
        request.onsuccess = () => resolve(request.result);
    });
    return localDbPromise;
}

function idbRequest(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function idbTransactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('Local database transaction aborted.'));
    });
}

async function readUserStore(storeName, userId) {
    const db = await openLocalDb();
    const transaction = db.transaction(storeName, 'readonly');
    const request = transaction.objectStore(storeName).index('by_user').getAll(IDBKeyRange.only(userId));
    const rows = await idbRequest(request);
    await idbTransactionDone(transaction);
    return rows;
}

function persistLocalBatch({ upserts = [], deletes = [], outboxPuts = [], outboxDeletes = [], revision = cloudRevision } = {}) {
    const userId = currentUser?.id;
    if (!userId) return Promise.resolve();

    localWriteQueue = localWriteQueue
        .catch(error => console.error('Previous local database write failed:', error))
        .then(async () => {
            const db = await openLocalDb();
            const transaction = db.transaction(['prompts', 'outbox', 'meta'], 'readwrite');
            const promptStore = transaction.objectStore('prompts');
            const outboxStore = transaction.objectStore('outbox');

            upserts.forEach(prompt => promptStore.put({ ...prompt, userId }));
            deletes.forEach(id => promptStore.delete([userId, Number(id)]));
            outboxPuts.forEach(mutation => outboxStore.put({ ...mutation, userId }));
            outboxDeletes.forEach(id => outboxStore.delete([userId, Number(id)]));
            transaction.objectStore('meta').put({ userId, cloudRevision: Number(revision || 0) });
            await idbTransactionDone(transaction);
        });
    return localWriteQueue;
}

async function loadLocalData() {
    appData = normalizeData(null);
    cloudRevision = 0;
    pendingMutations = new Map();

    try {
        const db = await openLocalDb();
        const [promptRows, outboxRows] = await Promise.all([
            readUserStore('prompts', currentUser.id),
            readUserStore('outbox', currentUser.id)
        ]);
        const metaTransaction = db.transaction('meta', 'readonly');
        const meta = await idbRequest(metaTransaction.objectStore('meta').get(currentUser.id));
        await idbTransactionDone(metaTransaction);

        appData.prompts = promptRows.map(({ userId, ...prompt }) => normalizeData({ prompts: [prompt] }).prompts[0]);
        pendingMutations = new Map(outboxRows.map(({ userId, ...mutation }) => [Number(mutation.id), mutation]));
        cloudRevision = Number(meta?.cloudRevision || 0);

        // One-time migration from the former whole-document localStorage cache.
        const legacyRaw = localStorage.getItem('promptManagerData');
        if (legacyRaw && appData.prompts.length === 0 && pendingMutations.size === 0) {
            const legacy = normalizeData(JSON.parse(legacyRaw));
            appData = legacy;
            const changes = legacy.prompts.map(prompt => createUpsertMutation(prompt));
            const deletions = legacy.deleted.map(item => createDeleteMutation({
                id: item.id,
                deletedAt: item.deletedAt,
                revision: 0
            }));
            [...changes, ...deletions].forEach(mutation => pendingMutations.set(mutation.id, mutation));
            await persistLocalBatch({
                upserts: legacy.prompts,
                outboxPuts: [...changes, ...deletions]
            });
        }
        localStorage.removeItem('promptManagerData');
    } catch (error) {
        console.error('Error loading local data:', error);
        appData = normalizeData(null);
        cloudRevision = 0;
        pendingMutations = new Map();
        showToast('Local offline storage is unavailable; cloud sync will still work for this session.');
    }
}

function createUpsertMutation(prompt, expectedRevision = null) {
    const previous = pendingMutations.get(Number(prompt.id));
    return {
        id: Number(prompt.id),
        action: 'upsert',
        expectedRevision: Number(expectedRevision ?? previous?.expectedRevision ?? prompt.revision ?? 0),
        prompt: { ...prompt },
        mutationId: `${Date.now()}-${++mutationSequence}`
    };
}

function createDeleteMutation({ id, deletedAt, revision }) {
    const previous = pendingMutations.get(Number(id));
    return {
        id: Number(id),
        action: 'delete',
        deletedAt: Number(deletedAt || Date.now()),
        expectedRevision: Number(previous?.expectedRevision ?? revision ?? 0),
        mutationId: `${Date.now()}-${++mutationSequence}`
    };
}

function saveLocalData(changedPrompts = [], deletedRecords = []) {
    appData.lastModified = Date.now();
    const mutations = [
        ...changedPrompts.map(prompt => createUpsertMutation(prompt)),
        ...deletedRecords.map(record => createDeleteMutation(record))
    ];
    mutations.forEach(mutation => pendingMutations.set(mutation.id, mutation));
    void persistLocalBatch({
        upserts: changedPrompts,
        deletes: deletedRecords.map(record => record.id),
        outboxPuts: mutations
    });
    populateCategories();
    queueCloudSave();
}

function normalizeData(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const prompts = Array.isArray(source.prompts)
        ? source.prompts.filter(p => p && Number.isFinite(Number(p.id))).map(p => ({
            ...p,
            id: Number(p.id),
            title: String(p.title || ''),
            text: String(p.text || ''),
            category: String(p.category || ''),
            tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
            notes: String(p.notes || ''),
            pinned: Boolean(p.pinned),
            createdAt: Number(p.createdAt || p.id || Date.now()),
            updatedAt: Number(p.updatedAt || p.createdAt || p.id || Date.now()),
            order: Number.isFinite(Number(p.order)) ? Number(p.order) : Number(p.createdAt || p.id || Date.now()),
            revision: Number(p.revision || 0)
        }))
        : [];
    const deleted = Array.isArray(source.deleted)
        ? source.deleted
            .filter(item => item && Number.isFinite(Number(item.id)))
            .map(item => ({ id: Number(item.id), deletedAt: Number(item.deletedAt || 0) }))
        : [];

    return {
        lastModified: Number(source.lastModified || 0),
        prompts,
        deleted
    };
}

// Ensures every prompt has a numeric `order` field, used for Custom Order
// sort/drag-and-drop. Existing prompts from an older backup fall back to
// their creation time so their initial
// custom order matches the order they were originally added in.
function ensureOrderField() {
    appData.prompts.forEach(p => {
        if (typeof p.order !== 'number') {
            p.order = p.createdAt || p.id || Date.now();
        }
    });
}

// ---------------------------------------------------------------------------
// Render
//
// Category open/closed state is kept in `collapsedCategories` (persisted), NOT
// in the DOM. Every re-render reapplies it, so reordering, editing, or toggling
// a prompt body no longer snaps categories shut. A category is OPEN by default
// and only closed if the user explicitly collapsed it.
//
// A virtual "Pinned" section renders first when any filtered prompt has
// `pinned: true`. Pinned prompts appear BOTH there and in their real category;
// the pinned copies are never reorderable (order is owned by the home
// category). The pinned flag lives on the prompt object, so it syncs through
// Supabase across devices.
// ---------------------------------------------------------------------------
function renderPrompts() {
    const searchTerm = searchInput.value.toLowerCase();
    const category = categoryFilter.value;
    const sort = sortSelect.value;
    const isFiltering = searchTerm.length > 0 || category !== '' || showPinnedOnly;
    // Reordering is only active in Custom Order and only on an unfiltered list
    // (reordering a filtered subset would silently move hidden items).
    const canReorder = sort === 'custom' && !isFiltering;

    const filtered = appData.prompts.filter(p => {
        const matchesSearch = p.title.toLowerCase().includes(searchTerm) ||
                               p.text.toLowerCase().includes(searchTerm) ||
                               p.category.toLowerCase().includes(searchTerm) ||
                               p.notes.toLowerCase().includes(searchTerm) ||
                               (p.tags && p.tags.some(t => t.toLowerCase().includes(searchTerm)));
        const matchesCategory = category === "" || p.category === category;
        const matchesPinned = !showPinnedOnly || p.pinned;
        return matchesSearch && matchesCategory && matchesPinned;
    });

    promptsContainer.innerHTML = '';
    updateWorkspaceNavigation(filtered.length, category, searchTerm);

    if (selectedPromptId && !filtered.some(prompt => prompt.id === selectedPromptId)) {
        selectedPromptId = null;
    }
    if (!selectedPromptId && filtered.length && window.matchMedia('(min-width: 1000px)').matches) {
        selectedPromptId = filtered[0].id;
    }

    if (filtered.length === 0) {
        const firstPrompt = appData.prompts.length === 0;
        promptsContainer.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon"><i class="fas fa-${firstPrompt ? 'wand-magic-sparkles' : 'magnifying-glass'}"></i></div>
                <h2>${firstPrompt ? 'Create your first prompt' : 'No matching prompts'}</h2>
                <p>${firstPrompt ? 'Build a private, searchable library of the prompts you use most.' : 'Try another search, category, or library view.'}</p>
                ${firstPrompt ? '<button class="btn" type="button" data-open-prompt><i class="fas fa-plus"></i> New prompt</button>' : '<button class="btn btn-secondary" type="button" data-action="clear-filters"><i class="fas fa-xmark"></i> Clear filters</button>'}
            </div>`;
        renderDetail();
        return;
    }

    if (sort === 'custom' && !isFiltering) {
        const hint = document.createElement('div');
        hint.className = 'reorder-hint';
        hint.innerHTML = '<i class="fas fa-grip-vertical"></i> Drag the handle — or use the up/down arrows — to reorder within a category. Saved automatically.';
        promptsContainer.appendChild(hint);
    } else if (sort === 'custom' && isFiltering) {
        const hint = document.createElement('div');
        hint.className = 'reorder-hint';
        hint.innerHTML = '<i class="fas fa-circle-info"></i> Clear search and category filters to reorder prompts.';
        promptsContainer.appendChild(hint);
    }

    if (showPinnedOnly) {
        sortPrompts(filtered, sort);
        promptsContainer.appendChild(
            buildCategorySection(PINNED_SECTION, filtered, false, true, 'pinned-section')
        );
        renderDetail();
        return;
    }

    // Virtual pinned section (respects the active search/filter).
    const pinned = filtered.filter(p => p.pinned);
    if (pinned.length > 0) {
        sortPrompts(pinned, sort);
        // Pinned copies are never reorderable — order belongs to the home category.
        promptsContainer.appendChild(
            buildCategorySection(PINNED_SECTION, pinned, false, isFiltering, 'pinned-section')
        );
    }

    // Group by category
    const grouped = {};
    filtered.forEach(p => {
        const cat = p.category || 'Uncategorized';
        (grouped[cat] = grouped[cat] || []).push(p);
    });

    const sortedCategories = Object.keys(grouped).sort((a, b) => {
        if (a === 'Uncategorized') return 1;
        if (b === 'Uncategorized') return -1;
        return a.localeCompare(b);
    });

    sortedCategories.forEach(cat => {
        const catPrompts = grouped[cat];
        sortPrompts(catPrompts, sort);
        promptsContainer.appendChild(
            buildCategorySection(cat, catPrompts, canReorder, isFiltering, '')
        );
    });

    renderDetail();
}

function updateWorkspaceNavigation(resultCount, category, searchTerm) {
    allPromptsCount.textContent = appData.prompts.length;
    pinnedPromptsCount.textContent = appData.prompts.filter(prompt => prompt.pinned).length;
    currentResultCount.textContent = resultCount;

    let title = 'All prompts';
    if (showPinnedOnly) title = 'Pinned';
    else if (category) title = category;
    else if (searchTerm) title = 'Search results';
    currentViewTitle.textContent = title;

    document.querySelectorAll('[data-nav-mode]').forEach(button => {
        const active = button.dataset.navMode === (showPinnedOnly ? 'pinned' : (!category ? 'all' : ''));
        button.classList.toggle('active', active);
    });
    sidebarCategories.querySelectorAll('[data-category]').forEach(button => {
        button.classList.toggle('active', !showPinnedOnly && button.dataset.category === category);
    });
    document.querySelectorAll('.mobile-tab[data-mobile-action]').forEach(button => {
        const action = button.dataset.mobileAction;
        button.classList.toggle('active', (action === 'pinned' && showPinnedOnly) || (action === 'library' && !showPinnedOnly));
    });
}

// Builds one collapsible category section. Extracted so the virtual Pinned
// section and the real categories share identical behavior (open/closed
// persistence, header toggle, grid/view classes).
function buildCategorySection(cat, catPrompts, canReorder, isFiltering, extraClass) {
    const section = document.createElement('div');
    section.className = 'category-section' + (extraClass ? ' ' + extraClass : '');
    // Open if filtering (show all matches) or not explicitly collapsed.
    const isOpen = isFiltering || !collapsedCategories.has(cat);
    if (isOpen) section.classList.add('expanded');

    const contentId = `category-content-${String(cat).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${catPrompts[0]?.id || 'empty'}`;
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'category-header';
    header.setAttribute('aria-expanded', String(isOpen));
    header.setAttribute('aria-controls', contentId);
    header.addEventListener('click', () => {
        const nowOpen = section.classList.toggle('expanded');
        header.setAttribute('aria-expanded', String(nowOpen));
        if (nowOpen) collapsedCategories.delete(cat);
        else collapsedCategories.add(cat);
        saveCollapsedState();
    });
    header.innerHTML = `
        <i class="fas fa-chevron-right arrow-icon"></i>
        <h2>${escapeHtml(cat)}</h2>
        <span class="category-count">${catPrompts.length}</span>
    `;

    const content = document.createElement('div');
    content.className = 'category-content';
    content.id = contentId;
    const contentInner = document.createElement('div');
    contentInner.className = 'category-content-inner';

    const grid = document.createElement('div');
    grid.className = 'prompts-grid view-' + currentView;

    catPrompts.forEach((p, idx) => {
        grid.appendChild(createItem(p, cat, canReorder, idx, catPrompts.length));
    });

    contentInner.appendChild(grid);
    content.appendChild(contentInner);
    section.appendChild(header);
    section.appendChild(content);
    return section;
}

function sortPrompts(list, sort) {
    list.sort((a, b) => {
        if (sort === 'date-desc') return b.updatedAt - a.updatedAt;
        if (sort === 'date-asc') return a.updatedAt - b.updatedAt;
        if (sort === 'name-asc') return a.title.localeCompare(b.title);
        if (sort === 'name-desc') return b.title.localeCompare(a.title);
        if (sort === 'custom') return (a.order ?? 0) - (b.order ?? 0);
        return 0;
    });
}

function populateCategories() {
    const categories = new Set(appData.prompts.map(p => p.category).filter(c => c));
    const sortedCategories = [...categories].sort((a, b) => a.localeCompare(b));

    // Update datalist (used by the Add/Edit form's category input)
    categoryList.innerHTML = '';
    sortedCategories.forEach(c => {
        const option = document.createElement('option');
        option.value = c;
        categoryList.appendChild(option);
    });

    // Update the filter dropdown, preserving the current selection
    const currentFilter = categoryFilter.value;
    categoryFilter.innerHTML = '<option value="">All categories</option>';
    sortedCategories.forEach(c => {
        const option = document.createElement('option');
        option.value = c;
        option.textContent = c;
        categoryFilter.appendChild(option);
    });
    categoryFilter.value = currentFilter;

    sidebarCategories.innerHTML = '';
    sortedCategories.forEach(category => {
        const count = appData.prompts.filter(prompt => prompt.category === category).length;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'nav-item';
        button.dataset.category = category;
        button.innerHTML = '<span><i class="fas fa-folder"></i><span class="nav-category-name"></span></span><span class="nav-count"></span>';
        button.querySelector('.nav-category-name').textContent = category;
        button.querySelector('.nav-count').textContent = count;
        sidebarCategories.appendChild(button);
    });
    updateWorkspaceNavigation(
        Number(currentResultCount.textContent || appData.prompts.length),
        categoryFilter.value,
        searchInput.value.trim().toLowerCase()
    );
}

// Whether a body is long enough to warrant a Show more / less control in the
// current view. Large view always shows the full body, so never needs one.
function bodyNeedsToggle(text) {
    if (!text) return false;
    const lineBreaks = (text.match(/\n/g) || []).length;
    if (currentView === 'compact') return text.length > 60 || lineBreaks >= 1;
    if (currentView === 'list') return text.length > 170 || lineBreaks >= 3;
    return text.length > 300 || lineBreaks >= 5;
}

// Character + rough token count for a prompt body. Tokens are estimated at
// ~4 characters/token (the common English heuristic) — close enough to judge
// whether a prompt fits a context window, which is all a card needs.
function countsFor(text) {
    const chars = (text || '').length;
    const tokens = Math.max(1, Math.round(chars / 4));
    if (currentView === 'large') {
        return `${chars.toLocaleString()} chars · ~${tokens.toLocaleString()} tokens`;
    }
    return `${chars.toLocaleString()} ch · ~${tokens.toLocaleString()} tok`;
}

// One unified item component for all three views. The view is expressed purely
// through the container class (view-large / view-list / view-compact), which
// drives how much of the body shows when collapsed. The full body text is
// ALWAYS in the DOM, so expand/collapse is a pure CSS class toggle with no
// re-render — which is what makes it reliable on mobile.
function createItem(p, cat, canReorder, idx, total) {
    const item = document.createElement('div');
    item.className = 'prompt-item';
    item.dataset.id = p.id;
    item.dataset.category = cat;
    if (selectedPromptId === p.id) item.classList.add('is-selected');

    const expanded = expandedIds.has(p.id);
    if (expanded) item.classList.add('is-expanded');

    const tagsHtml = (p.tags && p.tags.length)
        ? p.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')
        : '';
    const updated = p.updatedAt ? new Date(p.updatedAt).toLocaleDateString() : '';
    const needsToggle = bodyNeedsToggle(p.text);
    const largeView = currentView === 'large';
    const counts = countsFor(p.text);

    const reorderBtns = canReorder ? `
        <button class="tool-btn" data-action="move" data-id="${p.id}" data-direction="-1" title="Move up" aria-label="Move up" ${idx === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
        <button class="tool-btn" data-action="move" data-id="${p.id}" data-direction="1" title="Move down" aria-label="Move down" ${idx === total - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button>` : '';

    // Pin/unpin star. Solid amber star = pinned; hollow star = not pinned.
    const pinBtn = `<button class="tool-btn pin-btn${p.pinned ? ' pinned' : ''}" data-action="pin" data-id="${p.id}" title="${p.pinned ? 'Unpin' : 'Pin to top'}" aria-label="${p.pinned ? 'Unpin' : 'Pin to top'}" aria-pressed="${p.pinned ? 'true' : 'false'}"><i class="${p.pinned ? 'fas' : 'far'} fa-star"></i></button>`;

    // Large view gets a prominent Copy button in the footer, so the tools row
    // there is edit/delete only. List/compact keep copy in the tools row.
    const copyInTools = largeView ? '' : `<button class="tool-btn" data-action="copy" data-id="${p.id}" title="Copy" aria-label="Copy ${escapeHtml(p.title)}"><i class="fas fa-copy"></i></button>`;

    item.innerHTML = `
        <div class="item-top">
            ${canReorder ? `<button class="drag-handle" aria-label="Drag to reorder" title="Drag to reorder"><i class="fas fa-grip-vertical"></i></button>` : ''}
            <button class="prompt-open" type="button" data-action="open" data-id="${p.id}" aria-label="Open ${escapeHtml(p.title)}">
                <span class="item-head">
                    <span class="item-title">${escapeHtml(p.title)}</span>
                    ${!largeView && updated ? `<span class="item-meta">${updated}</span>` : ''}
                    ${!largeView ? `<span class="item-meta item-counts">${counts}</span>` : ''}
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
        ${tagsHtml ? `<div class="item-tags">${tagsHtml}</div>` : ''}
        <div class="prompt-body">${escapeHtml(p.text)}</div>
        ${needsToggle ? `<button class="preview-toggle" data-action="expand" data-id="${p.id}">${expanded
            ? '<i class="fas fa-chevron-up"></i> Show less'
            : '<i class="fas fa-chevron-down"></i> Show more'}</button>` : ''}
        ${largeView ? `<div class="item-footer">
            <button class="copy-btn" data-action="copy" data-id="${p.id}" aria-label="Copy ${escapeHtml(p.title)}"><i class="fas fa-copy"></i> Copy</button>
            <span class="item-meta"><span class="item-counts">${counts}</span>${updated ? ` · Updated ${updated}` : ''}</span>
        </div>` : ''}
    `;

    if (canReorder) {
        const handle = item.querySelector('.drag-handle');
        if (handle) handle.addEventListener('pointerdown', (e) => startPointerDrag(e, item, p.id, cat));
    }
    return item;
}

function renderDetail() {
    const prompt = appData.prompts.find(item => item.id === selectedPromptId);
    if (!prompt) {
        detailEmpty.hidden = false;
        detailContent.hidden = true;
        detailContent.innerHTML = '';
        return;
    }

    const tags = (prompt.tags || []).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
    const category = prompt.category || 'Uncategorized';
    const updated = prompt.updatedAt ? new Date(prompt.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    const created = prompt.createdAt ? new Date(prompt.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    const charCount = prompt.text.length;
    const tokenCount = Math.max(1, Math.round(charCount / 4));
    const counts = `${charCount.toLocaleString()} chars · ~${tokenCount.toLocaleString()} tokens`;

    detailEmpty.hidden = true;
    detailContent.hidden = false;
    detailContent.innerHTML = `
        <div class="detail-mobile-header">
            <button class="detail-back" type="button" data-detail-action="close"><i class="fas fa-chevron-left"></i> Library</button>
            <button class="icon-btn" type="button" data-detail-action="edit" aria-label="Edit ${escapeHtml(prompt.title)}"><i class="fas fa-pen"></i></button>
        </div>
        <div class="detail-kicker">
            <span class="detail-category">${escapeHtml(category)}</span>
            <button class="tool-btn pin-btn${prompt.pinned ? ' pinned' : ''}" type="button" data-detail-action="pin" aria-label="${prompt.pinned ? 'Unpin' : 'Pin'} ${escapeHtml(prompt.title)}" aria-pressed="${prompt.pinned ? 'true' : 'false'}"><i class="${prompt.pinned ? 'fas' : 'far'} fa-star"></i></button>
        </div>
        <h2 class="detail-title">${escapeHtml(prompt.title)}</h2>
        ${tags ? `<div class="detail-tags">${tags}</div>` : ''}
        <div class="detail-meta">
            <span><i class="far fa-clock"></i> Updated ${escapeHtml(updated)}</span>
            <span><i class="far fa-calendar"></i> Created ${escapeHtml(created)}</span>
            <span class="item-counts"><i class="fas fa-text-width"></i> ${escapeHtml(counts)}</span>
        </div>
        <p class="detail-prompt-label">Prompt</p>
        <div class="detail-prompt">${escapeHtml(prompt.text)}</div>
        ${prompt.notes ? `<div class="detail-notes"><p class="detail-notes-label">Notes</p>${escapeHtml(prompt.notes)}</div>` : ''}
        <div class="detail-actions">
            <button class="btn" type="button" data-detail-action="copy"><i class="fas fa-copy"></i> Copy prompt</button>
            <button class="icon-btn" type="button" data-detail-action="edit" aria-label="Edit prompt"><i class="fas fa-pen"></i></button>
            <button class="icon-btn danger" type="button" data-detail-action="delete" aria-label="Delete prompt"><i class="fas fa-trash"></i></button>
        </div>`;
}

window.openPromptDetail = function(id) {
    if (!appData.prompts.some(prompt => prompt.id === id)) return;
    selectedPromptId = id;
    promptsContainer.querySelectorAll('.prompt-item').forEach(item => {
        item.classList.toggle('is-selected', Number(item.dataset.id) === id);
    });
    renderDetail();
    detailPanel.classList.add('is-open');
    detailPanel.scrollTop = 0;
};

window.closePromptDetail = function() {
    detailPanel.classList.remove('is-open');
};

// ---- View switching ----
window.setView = function(view) {
    if (view === currentView) return;
    currentView = view;
    localStorage.setItem('promptManagerView', view);
    // Fresh view: large implies everything expanded; list/compact start collapsed.
    expandedIds = new Set();
    updateViewButtons();
    renderPrompts();
};

function updateViewButtons() {
    document.querySelectorAll('.view-btn').forEach(btn => {
        btn.classList.remove('active');
        btn.setAttribute('aria-pressed', 'false');
    });
    const map = { large: 'view-large', list: 'view-list', compact: 'view-compact' };
    const activeBtn = document.getElementById(map[currentView]);
    if (activeBtn) {
        activeBtn.classList.add('active');
        activeBtn.setAttribute('aria-pressed', 'true');
    }
}

// ---- Expand / collapse (targeted DOM toggle — no re-render) ----
// A pinned prompt renders twice (Pinned section + its home category), so this
// updates EVERY instance of the id, with `expandedIds` as the source of truth.
window.toggleExpand = function(id) {
    const items = promptsContainer.querySelectorAll('.prompt-item[data-id="' + id + '"]');
    if (!items.length) return;
    const nowExpanded = !expandedIds.has(id);
    if (nowExpanded) expandedIds.add(id);
    else expandedIds.delete(id);
    items.forEach(item => {
        item.classList.toggle('is-expanded', nowExpanded);
        const btn = item.querySelector('.preview-toggle');
        if (btn) {
            btn.innerHTML = nowExpanded
                ? '<i class="fas fa-chevron-up"></i> Show less'
                : '<i class="fas fa-chevron-down"></i> Show more';
        }
    });
};

// ---- Pin / unpin ----
// The flag is stored on the prompt object itself, so it round-trips through
// saveLocalData() -> Supabase and follows the user across devices.
window.togglePin = function(id) {
    const prompt = appData.prompts.find(p => p.id === id);
    if (!prompt) return;
    prompt.pinned = !prompt.pinned;
    prompt.updatedAt = Date.now();
    saveLocalData([prompt]);
    renderPrompts();
    showToast(prompt.pinned ? "Pinned to top." : "Unpinned.");
};

// ---------------------------------------------------------------------------
// Pointer-based drag reordering
//
// Uses Pointer Events instead of the HTML5 drag API, because HTML5 drag does
// not fire on touchscreens. `touch-action: none` on the handle stops the page
// from scrolling mid-drag, and implicit pointer capture (touch) plus an
// explicit setPointerCapture (mouse) keep move events flowing to us while the
// dragged item is set to pointer-events:none so elementFromPoint can see what
// is underneath the finger/cursor.
// ---------------------------------------------------------------------------
let dragState = null;

function startPointerDrag(e, item, id, category) {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // left button only
    e.preventDefault();
    dragState = { item, id, category, container: item.parentElement, pointerId: e.pointerId };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* older browsers */ }
    item.classList.add('dragging');
    document.body.classList.add('is-dragging');
    document.addEventListener('pointermove', onPointerDragMove);
    document.addEventListener('pointerup', endPointerDrag);
    document.addEventListener('pointercancel', endPointerDrag);
}

function onPointerDragMove(e) {
    if (!dragState) return;
    e.preventDefault();
    const below = document.elementFromPoint(e.clientX, e.clientY);
    if (!below) return;
    const target = below.closest('.prompt-item');
    if (!target || target === dragState.item) return;
    if (target.parentElement !== dragState.container) return;      // same category grid only
    if (target.dataset.category !== String(dragState.category)) return;
    const rect = target.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    dragState.container.insertBefore(dragState.item, before ? target : target.nextSibling);
}

function endPointerDrag() {
    if (!dragState) return;
    const { item, container, category } = dragState;
    item.classList.remove('dragging');
    document.body.classList.remove('is-dragging');
    document.removeEventListener('pointermove', onPointerDragMove);
    document.removeEventListener('pointerup', endPointerDrag);
    document.removeEventListener('pointercancel', endPointerDrag);
    const orderedIds = Array.from(container.querySelectorAll('.prompt-item')).map(n => Number(n.dataset.id));
    dragState = null;
    commitOrder(category, orderedIds);
}

// Persists only rows whose order actually changed, then re-renders to refresh
// arrow states. Row-level cloud sync avoids rewriting unrelated prompts.
function commitOrder(category, orderedIds) {
    const indexById = new Map(orderedIds.map((id, i) => [id, i]));
    const changedAt = Date.now();
    const changedPrompts = [];
    appData.prompts.forEach(p => {
        if ((p.category || 'Uncategorized') === category && indexById.has(p.id)) {
            const nextOrder = indexById.get(p.id);
            if (p.order !== nextOrder) {
                p.order = nextOrder;
                p.updatedAt = changedAt;
                changedPrompts.push(p);
            }
        }
    });
    if (changedPrompts.length) saveLocalData(changedPrompts);
    renderPrompts();
}

// Arrow-button reordering: reliable, accessible alternative to dragging.
window.movePrompt = function(id, direction) {
    const prompt = appData.prompts.find(p => p.id === id);
    if (!prompt) return;
    const category = prompt.category || 'Uncategorized';
    const catPrompts = appData.prompts.filter(p => (p.category || 'Uncategorized') === category);
    catPrompts.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    const idx = catPrompts.findIndex(p => p.id === id);
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= catPrompts.length) return;

    const tmp = catPrompts[idx].order;
    catPrompts[idx].order = catPrompts[swapIdx].order;
    catPrompts[swapIdx].order = tmp;
    const changedAt = Date.now();
    catPrompts[idx].updatedAt = changedAt;
    catPrompts[swapIdx].updatedAt = changedAt;

    saveLocalData([catPrompts[idx], catPrompts[swapIdx]]);
    renderPrompts();
};


// Actions
function openModal(modal, preferredFocus) {
    if (!modal) return;
    lastFocusedElement = document.activeElement;
    modal.classList.add('active');
    requestAnimationFrame(() => {
        const target = preferredFocus || modal.querySelector('input, textarea, button, select');
        target?.focus();
    });
}

function closeModal(modal) {
    if (!modal) return;
    modal.classList.remove('active');
    if (modal === deleteModal) pendingDeleteId = null;
    if (lastFocusedElement instanceof HTMLElement) lastFocusedElement.focus();
    lastFocusedElement = null;
}

function openNewPromptEditor() {
    promptForm.reset();
    editorCount.textContent = '0 characters';
    editState = { isEditing: false, id: null };
    promptModalTitle.textContent = 'Add new prompt';
    openModal(promptModal, promptTitle);
}

window.copyPrompt = function(id) {
    const prompt = appData.prompts.find(p => p.id === id);
    if (prompt) {
        navigator.clipboard.writeText(prompt.text).then(() => {
            showToast("Copied to clipboard!");
        }).catch(() => showToast('Unable to copy. Select the prompt text and copy it manually.'));
    }
}

window.deletePrompt = function(id) {
    const prompt = appData.prompts.find(p => p.id === id);
    if (!prompt) return;
    pendingDeleteId = id;
    deleteModal.querySelector('#delete-title').textContent = `Delete “${prompt.title}”?`;
    openModal(deleteModal, cancelDeleteBtn);
}

function performDelete() {
    const id = pendingDeleteId;
    const prompt = appData.prompts.find(p => p.id === id);
    if (!prompt) return closeModal(deleteModal);
    const deletedAt = Date.now();
    appData.prompts = appData.prompts.filter(p => p.id !== id);
    expandedIds.delete(id);
    if (selectedPromptId === id) {
        selectedPromptId = null;
        window.closePromptDetail();
    }
    closeModal(deleteModal);
    saveLocalData([], [{ id, deletedAt, revision: prompt.revision || 0 }]);
    renderPrompts();
    showToast('Prompt deleted.');
}

window.editPrompt = function(id) {
    const prompt = appData.prompts.find(p => p.id === id);
    if (!prompt) return;

    promptTitle.value = prompt.title;
    promptCategory.value = prompt.category || '';
    promptTags.value = prompt.tags ? prompt.tags.join(', ') : '';
    promptText.value = prompt.text;
    promptNotes.value = prompt.notes || '';
    editorCount.textContent = `${prompt.text.length.toLocaleString()} characters`;

    editState = { isEditing: true, id: id };
    promptModalTitle.textContent = "Edit prompt";
    openModal(promptModal, promptTitle);
}

// Event Listeners
document.querySelectorAll('.view-btn[data-view]').forEach(button => {
    button.addEventListener('click', () => window.setView(button.dataset.view));
});

promptsContainer.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (!button || !promptsContainer.contains(button)) return;
    if (button.dataset.action === 'clear-filters') {
        searchInput.value = '';
        categoryFilter.value = '';
        showPinnedOnly = false;
        clearSearchBtn.style.display = 'none';
        renderPrompts();
        return;
    }
    const id = Number(button.dataset.id);
    if (!Number.isFinite(id)) return;

    const actions = {
        move: () => window.movePrompt(id, Number(button.dataset.direction)),
        open: () => window.openPromptDetail(id),
        pin: () => window.togglePin(id),
        copy: () => window.copyPrompt(id),
        edit: () => window.editPrompt(id),
        delete: () => window.deletePrompt(id),
        expand: () => window.toggleExpand(id)
    };
    actions[button.dataset.action]?.();
});

detailContent.addEventListener('click', event => {
    const button = event.target.closest('button[data-detail-action]');
    if (!button) return;
    const actions = {
        close: () => window.closePromptDetail(),
        copy: () => window.copyPrompt(selectedPromptId),
        pin: () => window.togglePin(selectedPromptId),
        edit: () => window.editPrompt(selectedPromptId),
        delete: () => window.deletePrompt(selectedPromptId)
    };
    actions[button.dataset.detailAction]?.();
});

searchInput.addEventListener('input', () => {
    clearSearchBtn.style.display = searchInput.value.length > 0 ? 'flex' : 'none';
    renderPrompts();
});

clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearSearchBtn.style.display = 'none';
    searchInput.focus();
    renderPrompts();
});

categoryFilter.addEventListener('change', () => {
    showPinnedOnly = false;
    renderPrompts();
});
sortSelect.addEventListener('change', renderPrompts);

document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-open-prompt]');
    if (trigger) openNewPromptEditor();
});

closePromptBtn.addEventListener('click', () => closeModal(promptModal));
closePromptIcon.addEventListener('click', () => closeModal(promptModal));

function openSidebar() {
    document.body.classList.add('sidebar-open');
    mobileMenuBtn.setAttribute('aria-expanded', 'true');
}

function closeSidebar() {
    document.body.classList.remove('sidebar-open');
    mobileMenuBtn.setAttribute('aria-expanded', 'false');
}

mobileMenuBtn.setAttribute('aria-expanded', 'false');
mobileMenuBtn.addEventListener('click', openSidebar);
sidebarCloseBtn.addEventListener('click', closeSidebar);
sidebarBackdrop.addEventListener('click', closeSidebar);

workspaceSidebar.addEventListener('click', event => {
    const modeButton = event.target.closest('[data-nav-mode]');
    const categoryButton = event.target.closest('[data-category]');
    if (modeButton) {
        showPinnedOnly = modeButton.dataset.navMode === 'pinned';
        categoryFilter.value = '';
        selectedPromptId = null;
        renderPrompts();
        closeSidebar();
    } else if (categoryButton) {
        showPinnedOnly = false;
        categoryFilter.value = categoryButton.dataset.category;
        selectedPromptId = null;
        renderPrompts();
        closeSidebar();
    }
});

document.querySelector('.mobile-tabbar').addEventListener('click', event => {
    const button = event.target.closest('[data-mobile-action]');
    if (!button) return;
    const action = button.dataset.mobileAction;
    if (action === 'library' || action === 'pinned') {
        showPinnedOnly = action === 'pinned';
        categoryFilter.value = '';
        selectedPromptId = null;
        renderPrompts();
        document.querySelector('.library-panel').scrollTop = 0;
    } else if (action === 'categories') {
        openSidebar();
    } else if (action === 'settings') {
        accountEmail.textContent = currentUser?.email || 'Unknown account';
        openModal(settingsModal, closeSettingsBtn);
    }
});

sidebarSyncBtn.addEventListener('click', async () => {
    await syncFromCloud(true);
});

promptText.addEventListener('input', () => {
    editorCount.textContent = `${promptText.value.length.toLocaleString()} characters`;
});

document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', event => {
        if (event.target === modal) closeModal(modal);
    });
});

document.addEventListener('keydown', event => {
    const activeModal = [...document.querySelectorAll('.modal.active')].pop();
    if (activeModal) {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeModal(activeModal);
            return;
        }
        if (event.key === 'Tab') {
            const focusable = [...activeModal.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
                .filter(element => element.offsetParent !== null);
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
        return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInput.focus();
        searchInput.select();
    } else if (event.key === 'Escape') {
        if (document.body.classList.contains('sidebar-open')) closeSidebar();
        else window.closePromptDetail();
    }
});

promptForm.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const tagsArray = promptTags.value.split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0);

    const promptData = {
        title: promptTitle.value.trim(),
        category: promptCategory.value.trim(),
        tags: tagsArray,
        text: promptText.value.trim(),
        notes: promptNotes.value.trim(),
        updatedAt: Date.now()
    };

    let savedPrompt;
    if (editState.isEditing) {
        appData.prompts = appData.prompts.map(p => {
            if (p.id === editState.id) {
                savedPrompt = { ...p, ...promptData };
                return savedPrompt;
            }
            return p;
        });
    } else {
        const newId = Date.now();
        savedPrompt = {
            ...promptData,
            id: newId,
            createdAt: newId,
            order: newId, // sorts after existing (typically smaller) order values in Custom Order
            revision: 0
        };
        appData.prompts.push(savedPrompt);
    }

    selectedPromptId = savedPrompt.id;
    saveLocalData([savedPrompt]);
    renderPrompts();
    closeModal(promptModal);
    if (window.matchMedia('(max-width: 999px)').matches) window.openPromptDetail(savedPrompt.id);
});

// Settings & Sync
settingsBtn.addEventListener('click', () => {
    accountEmail.textContent = currentUser?.email || 'Unknown account';
    openModal(settingsModal, closeSettingsBtn);
});

closeSettingsBtn.addEventListener('click', () => closeModal(settingsModal));
closeSettingsIcon.addEventListener('click', () => closeModal(settingsModal));
cancelDeleteBtn.addEventListener('click', () => closeModal(deleteModal));
confirmDeleteBtn.addEventListener('click', performDelete);

signOutBtn.addEventListener('click', async () => {
    signOutBtn.disabled = true;
    const { error } = await supabaseClient.auth.signOut();
    signOutBtn.disabled = false;
    if (error) {
        showToast(error.message);
        return;
    }
    closeModal(settingsModal);
    endUserSession();
});

loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    loginError.textContent = '';
    const submitButton = loginForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    submitButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signing in…';

    try {
        const authRequest = supabaseClient.auth.signInWithPassword({
            email: loginEmail.value.trim(),
            password: loginPassword.value
        });
        const { data, error } = await withTimeout(authRequest, 15000);

        if (error) throw error;
        if (!data?.user) throw new Error('Sign-in succeeded but no user session was returned. Please refresh and try again.');

        loginPassword.value = '';
        await startUserSession(data.user);
    } catch (error) {
        console.error('Sign-in failed:', error);
        loginError.textContent = error.message || 'Sign-in failed. Please refresh and try again.';
    } finally {
        submitButton.disabled = false;
        submitButton.innerHTML = '<i class="fas fa-right-to-bracket"></i> Sign in';
    }
});

syncBtn.addEventListener('click', async () => {
    await syncFromCloud(true);
});

function startUserSession(user) {
    if (!user) return Promise.reject(new Error('No authenticated user session was returned.'));
    if (currentUser?.id === user.id && sessionStartPromise) return sessionStartPromise;
    if (currentUser?.id === user.id) {
        document.body.classList.add('is-authenticated');
        authScreen.hidden = true;
        appContainer.hidden = false;
        return Promise.resolve();
    }
    currentUser = user;
    cloudRevision = 0;
    accountEmail.textContent = user.email || user.id;
    sidebarAccountEmail.textContent = user.email || 'Cloud workspace';
    document.body.classList.add('is-authenticated');
    authScreen.hidden = true;
    appContainer.hidden = false;
    const userId = user.id;
    const task = (async () => {
        await loadLocalData();
        if (currentUser?.id !== userId) return;
        ensureOrderField();
        updateViewButtons();
        renderPrompts();
        populateCategories();
        // Do not hold the login screen open while cloud data loads. Sync errors
        // are reported inside syncFromCloud and cached data remains usable.
        void syncFromCloud(false);
    })();
    const trackedTask = task.finally(() => {
        if (sessionStartPromise === trackedTask) sessionStartPromise = null;
    });
    sessionStartPromise = trackedTask;
    return trackedTask;
}

function withTimeout(promise, milliseconds) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Sign-in timed out. Check your connection and try again.')), milliseconds);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function endUserSession() {
    const previousUserId = currentUser?.id;
    currentUser = null;
    sessionStartPromise = null;
    cloudRevision = 0;
    pendingMutations = new Map();
    selectedPromptId = null;
    showPinnedOnly = false;
    clearTimeout(syncTimeout);
    appData = normalizeData(null);
    localStorage.removeItem('promptManagerData');
    if (previousUserId) void clearLocalUserData(previousUserId);
    document.body.classList.remove('is-authenticated');
    document.body.classList.remove('sidebar-open');
    detailPanel.classList.remove('is-open');
    appContainer.hidden = true;
    authScreen.hidden = false;
    loginEmail.focus();
}

async function clearLocalUserData(userId) {
    try {
        await localWriteQueue.catch(() => {});
        const db = await openLocalDb();
        const transaction = db.transaction(['prompts', 'outbox', 'meta'], 'readwrite');
        ['prompts', 'outbox'].forEach(storeName => {
            const request = transaction.objectStore(storeName).index('by_user').openCursor(IDBKeyRange.only(userId));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return;
                cursor.delete();
                cursor.continue();
            };
        });
        transaction.objectStore('meta').delete(userId);
        await idbTransactionDone(transaction);
    } catch (error) {
        console.error('Unable to clear local user data:', error);
    }
}

function queueCloudSave(delay = 700) {
    if (!currentUser) return;
    clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => { void flushPendingChanges(); }, delay);
}

function setCloudState(state, message) {
    const icons = {
        syncing: '<i class="fas fa-spinner fa-spin"></i>',
        synced: '<i class="fas fa-check"></i>',
        error: '<i class="fas fa-exclamation-triangle"></i>'
    };
    syncBtn.innerHTML = icons[state] || '<i class="fas fa-cloud"></i>';
    cloudStatus.textContent = message;
    saveState.dataset.state = state;
    sidebarSyncBtn.dataset.state = state;
    saveStateLabel.textContent = state === 'synced' ? 'Saved' : message;
    sidebarSyncLabel.textContent = state === 'synced' ? 'All changes saved' : message;
    syncBtn.setAttribute('aria-label', state === 'syncing' ? 'Syncing prompts' : state === 'error' ? 'Sync failed. Retry' : 'Sync prompts');
    if (state === 'synced') {
        setTimeout(() => { syncBtn.innerHTML = '<i class="fas fa-cloud"></i>'; }, 1500);
    }
}

function promptFromCloudRow(row) {
    return normalizeData({ prompts: [{
        id: row.id,
        title: row.title,
        text: row.prompt_text,
        category: row.category,
        tags: row.tags,
        notes: row.notes,
        pinned: row.pinned,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        order: row.sort_order,
        revision: row.revision
    }] }).prompts[0];
}

function mutationToPayload(mutation) {
    if (mutation.action === 'delete') {
        return {
            id: mutation.id,
            action: 'delete',
            expected_revision: mutation.expectedRevision,
            deleted_at: mutation.deletedAt
        };
    }

    const prompt = mutation.prompt;
    return {
        id: mutation.id,
        action: 'upsert',
        expected_revision: mutation.expectedRevision,
        title: prompt.title,
        text: prompt.text,
        category: prompt.category || '',
        tags: prompt.tags || [],
        notes: prompt.notes || '',
        pinned: Boolean(prompt.pinned),
        created_at: prompt.createdAt,
        updated_at: prompt.updatedAt,
        sort_order: prompt.order
    };
}

function nextMutationBatch() {
    const batch = [];
    let encodedBytes = 2;
    for (const mutation of pendingMutations.values()) {
        const payload = mutationToPayload(mutation);
        const payloadBytes = new Blob([JSON.stringify(payload)]).size + 1;
        if (batch.length && (batch.length >= 100 || encodedBytes + payloadBytes > 900000)) break;
        batch.push({ mutation, payload });
        encodedBytes += payloadBytes;
    }
    return batch;
}

function flushPendingChanges() {
    if (!currentUser || pendingMutations.size === 0) return Promise.resolve();
    if (flushPromise) return flushPromise;

    let retryImmediately = false;
    const task = performCloudFlush()
        .then(shouldRetry => { retryImmediately = Boolean(shouldRetry); })
        .finally(() => {
            if (flushPromise === task) flushPromise = null;
            if (retryImmediately && currentUser && pendingMutations.size > 0) queueCloudSave(0);
        });
    flushPromise = task;
    return task;
}

async function performCloudFlush() {
    if (pullPromise) await pullPromise;
    if (!currentUser || pendingMutations.size === 0) return false;

    const userId = currentUser.id;
    const batch = nextMutationBatch();
    if (!batch.length) return false;
    setCloudState('syncing', 'Saving…');

    try {
        await localWriteQueue.catch(() => {});
        const { data, error } = await supabaseClient
            .schema(SUPABASE_CONFIG.schema)
            .rpc('apply_prompt_changes', {
                changes: batch.map(item => item.payload)
            });
        if (error) throw error;
        if (currentUser?.id !== userId) return false;

        const resultsById = new Map((data || []).map(row => [Number(row.prompt_id), row]));
        const outboxDeletes = [];
        const outboxPuts = [];
        const localUpserts = [];

        batch.forEach(({ mutation }) => {
            const result = resultsById.get(mutation.id);
            if (!result) return;
            cloudRevision = Math.max(cloudRevision, Number(result.new_revision || 0));

            const currentMutation = pendingMutations.get(mutation.id);
            const localPrompt = appData.prompts.find(prompt => prompt.id === mutation.id);
            if (localPrompt) {
                localPrompt.revision = Number(result.new_revision || 0);
                localUpserts.push(localPrompt);
            }

            if (currentMutation?.mutationId === mutation.mutationId) {
                pendingMutations.delete(mutation.id);
                outboxDeletes.push(mutation.id);
            } else if (currentMutation) {
                currentMutation.expectedRevision = Number(result.new_revision || 0);
                if (currentMutation.prompt) currentMutation.prompt.revision = Number(result.new_revision || 0);
                outboxPuts.push(currentMutation);
            }
        });

        await persistLocalBatch({
            upserts: localUpserts,
            outboxPuts,
            outboxDeletes,
            revision: cloudRevision
        });
        setCloudState('synced', 'Synced');
        return pendingMutations.size > 0;
    } catch (error) {
        if (String(error.message).includes('PROMPT_VERSION_CONFLICT') || error.code === '40001') {
            // Pull a full, authoritative revision snapshot. Pending local rows
            // remain in the outbox and are rebased before the queued retry.
            return await syncFromCloud(false, true, true);
        }
        console.error('Error saving to Supabase:', error);
        setCloudState('error', 'Sync failed');
        showToast('Cloud save failed. Your changes remain queued locally.');
        return false;
    }
}

function syncFromCloud(showSuccess = false, forceFull = false, fromConflict = false) {
    if (!currentUser) return Promise.resolve();

    if (!pullPromise) {
        const task = performCloudPull(forceFull, fromConflict).finally(() => {
            if (pullPromise === task) pullPromise = null;
            if (currentUser && pendingMutations.size > 0) queueCloudSave(0);
        });
        pullPromise = task;
    }

    return pullPromise.then(() => {
        if (showSuccess) showToast('Cloud sync complete.');
        return true;
    }).catch(() => {
        // performCloudPull already recorded the diagnostic and preserved the
        // local cache. Keep event-handler callers from producing an unhandled
        // promise rejection while the user is offline.
        return false;
    });
}

async function performCloudPull(forceFull, fromConflict) {
    if (flushPromise && !fromConflict) await flushPromise;
    if (!currentUser) return;

    const userId = currentUser.id;
    const startingRevision = forceFull ? 0 : cloudRevision;
    let pageCursor = startingRevision;
    let newestRevision = cloudRevision;
    const localUpserts = new Map();
    const localDeletes = new Set();
    const outboxPuts = new Map();
    let changed = false;
    setCloudState('syncing', 'Checking…');

    try {
        while (true) {
            const { data, error } = await supabaseClient
                .schema(SUPABASE_CONFIG.schema)
                .from('prompt_items')
                .select(PROMPT_COLUMNS)
                .eq('user_id', userId)
                .gt('revision', pageCursor)
                .order('revision', { ascending: true })
                .limit(DELTA_PAGE_SIZE);
            if (error) throw error;
            if (currentUser?.id !== userId) return;
            if (!data?.length) break;

            data.forEach(row => {
                const id = Number(row.id);
                const revision = Number(row.revision || 0);
                pageCursor = Math.max(pageCursor, revision);
                newestRevision = Math.max(newestRevision, revision);
                const pending = pendingMutations.get(id);

                if (pending) {
                    pending.expectedRevision = revision;
                    if (pending.prompt) pending.prompt.revision = revision;
                    const localPrompt = appData.prompts.find(prompt => prompt.id === id);
                    if (localPrompt) localPrompt.revision = revision;
                    outboxPuts.set(id, pending);
                    return;
                }

                const existingIndex = appData.prompts.findIndex(prompt => prompt.id === id);
                if (row.deleted_at !== null) {
                    if (existingIndex >= 0) appData.prompts.splice(existingIndex, 1);
                    localDeletes.add(id);
                } else {
                    const cloudPrompt = promptFromCloudRow(row);
                    if (existingIndex >= 0) appData.prompts[existingIndex] = cloudPrompt;
                    else appData.prompts.push(cloudPrompt);
                    localUpserts.set(id, cloudPrompt);
                }
                changed = true;
            });

            if (data.length < DELTA_PAGE_SIZE) break;
        }

        cloudRevision = newestRevision;
        await persistLocalBatch({
            upserts: [...localUpserts.values()],
            deletes: [...localDeletes],
            outboxPuts: [...outboxPuts.values()],
            revision: cloudRevision
        });

        if (changed) {
            ensureOrderField();
            renderPrompts();
            populateCategories();
        }
        setCloudState('synced', 'Synced');
    } catch (error) {
        console.error('Error loading from Supabase:', error);
        setCloudState('error', 'Sync failed');
        showToast('Cloud sync failed. Locally cached prompts remain available.');
        throw error;
    }
}

// Utils
function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

function showToast(message) {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.className = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

// Run
init().catch(error => {
    console.error('Application initialization failed:', error);
    loginError.textContent = error.message || 'The application could not start. Please refresh and try again.';
});

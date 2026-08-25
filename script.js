// These are public browser credentials. The service-role key must never be
// placed in this repository or sent to the browser.
const SUPABASE_CONFIG = {
    url: "https://baiojghilzxhkebfblzv.supabase.co",
    publishableKey: "sb_publishable_nfLVr5Krdld9pxxr4f2CYQ_bsn0TNxx",
    schema: "prompts"
};

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
let cloudVersion = 0;
let syncTimeout = null;
let syncInFlight = false;
let syncQueued = false;

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

const promptsContainer = document.getElementById('prompts-container');
const searchInput = document.getElementById('search-input');
const clearSearchBtn = document.getElementById('clear-search-btn');
const categoryFilter = document.getElementById('category-filter');
const sortSelect = document.getElementById('sort-select');
const categoryList = document.getElementById('category-list');

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
        themeToggle.innerHTML = '<i class="fas fa-sun"></i>';
    } else {
        document.body.removeAttribute('data-theme');
        themeToggle.innerHTML = '<i class="fas fa-moon"></i>';
    }
}

themeToggle.addEventListener('click', () => {
    if (document.body.getAttribute('data-theme') === 'dark') {
        document.body.removeAttribute('data-theme');
        localStorage.setItem('theme', 'light');
        themeToggle.innerHTML = '<i class="fas fa-moon"></i>';
    } else {
        document.body.setAttribute('data-theme', 'dark');
        localStorage.setItem('theme', 'dark');
        themeToggle.innerHTML = '<i class="fas fa-sun"></i>';
    }
});

// Data Management
function loadLocalData() {
    try {
        const stored = localStorage.getItem('promptManagerData');
        if (stored) {
            appData = normalizeData(JSON.parse(stored));
        } else {
            appData = normalizeData(null);
        }
    } catch (e) {
        console.error("Error loading local data", e);
        appData = normalizeData(null);
    }
}

function saveLocalData() {
    appData.lastModified = Date.now();
    localStorage.setItem('promptManagerData', JSON.stringify(appData));
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
            order: Number.isFinite(Number(p.order)) ? Number(p.order) : Number(p.createdAt || p.id || Date.now())
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

function mergeData(localValue, cloudValue) {
    const local = normalizeData(localValue);
    const cloud = normalizeData(cloudValue);
    const promptsById = new Map();
    const deletedById = new Map();

    [...cloud.prompts, ...local.prompts].forEach(prompt => {
        const existing = promptsById.get(prompt.id);
        if (!existing || prompt.updatedAt >= existing.updatedAt) promptsById.set(prompt.id, prompt);
    });
    [...cloud.deleted, ...local.deleted].forEach(item => {
        const existing = deletedById.get(item.id) || 0;
        if (item.deletedAt > existing) deletedById.set(item.id, item.deletedAt);
    });

    const prompts = [...promptsById.values()].filter(prompt => {
        const deletedAt = deletedById.get(prompt.id) || 0;
        return prompt.updatedAt > deletedAt;
    });

    return {
        lastModified: Math.max(local.lastModified, cloud.lastModified),
        prompts,
        deleted: [...deletedById].map(([id, deletedAt]) => ({ id, deletedAt }))
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
    const isFiltering = searchTerm.length > 0 || category !== '';
    // Reordering is only active in Custom Order and only on an unfiltered list
    // (reordering a filtered subset would silently move hidden items).
    const canReorder = sort === 'custom' && !isFiltering;

    const filtered = appData.prompts.filter(p => {
        const matchesSearch = p.title.toLowerCase().includes(searchTerm) ||
                              p.text.toLowerCase().includes(searchTerm) ||
                              (p.tags && p.tags.some(t => t.toLowerCase().includes(searchTerm)));
        const matchesCategory = category === "" || p.category === category;
        return matchesSearch && matchesCategory;
    });

    promptsContainer.innerHTML = '';

    if (filtered.length === 0) {
        promptsContainer.innerHTML = '<p class="empty-state">No prompts found. Create one with “New Prompt”.</p>';
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

    const header = document.createElement('div');
    header.className = 'category-header';
    header.addEventListener('click', () => {
        const nowOpen = section.classList.toggle('expanded');
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

    // Update datalist (used by the Add/Edit form's category input)
    categoryList.innerHTML = '';
    categories.forEach(c => {
        const option = document.createElement('option');
        option.value = c;
        categoryList.appendChild(option);
    });

    // Update the filter dropdown, preserving the current selection
    const currentFilter = categoryFilter.value;
    categoryFilter.innerHTML = '<option value="">All Categories</option>';
    categories.forEach(c => {
        const option = document.createElement('option');
        option.value = c;
        option.textContent = c;
        categoryFilter.appendChild(option);
    });
    categoryFilter.value = currentFilter;
}

// Whether a body is long enough to warrant a Show more / less control in the
// current view. Large view always shows the full body, so never needs one.
function bodyNeedsToggle(text) {
    if (!text) return false;
    if (currentView === 'large') return false;
    const lineBreaks = (text.match(/\n/g) || []).length;
    if (currentView === 'compact') return text.length > 60 || lineBreaks >= 1;
    return text.length > 170 || lineBreaks >= 3; // list
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

    // Large view is always expanded; list/compact remember per-prompt state.
    const expanded = currentView === 'large' || expandedIds.has(p.id);
    if (expanded) item.classList.add('is-expanded');

    const tagsHtml = (p.tags && p.tags.length)
        ? p.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')
        : '';
    const updated = p.updatedAt ? new Date(p.updatedAt).toLocaleDateString() : '';
    const needsToggle = bodyNeedsToggle(p.text);
    const largeView = currentView === 'large';
    const counts = countsFor(p.text);

    const reorderBtns = canReorder ? `
        <button class="tool-btn" onclick="movePrompt(${p.id}, -1)" title="Move up" aria-label="Move up" ${idx === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
        <button class="tool-btn" onclick="movePrompt(${p.id}, 1)" title="Move down" aria-label="Move down" ${idx === total - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button>` : '';

    // Pin/unpin star. Solid amber star = pinned; hollow star = not pinned.
    const pinBtn = `<button class="tool-btn pin-btn${p.pinned ? ' pinned' : ''}" onclick="togglePin(${p.id})" title="${p.pinned ? 'Unpin' : 'Pin to top'}" aria-label="${p.pinned ? 'Unpin' : 'Pin to top'}" aria-pressed="${p.pinned ? 'true' : 'false'}"><i class="${p.pinned ? 'fas' : 'far'} fa-star"></i></button>`;

    // Large view gets a prominent Copy button in the footer, so the tools row
    // there is edit/delete only. List/compact keep copy in the tools row.
    const copyInTools = largeView ? '' : `<button class="tool-btn" onclick="copyPrompt(${p.id})" title="Copy"><i class="fas fa-copy"></i></button>`;

    item.innerHTML = `
        <div class="item-top">
            ${canReorder ? `<button class="drag-handle" aria-label="Drag to reorder" title="Drag to reorder"><i class="fas fa-grip-vertical"></i></button>` : ''}
            <div class="item-head">
                <span class="item-title">${escapeHtml(p.title)}</span>
                ${!largeView && updated ? `<span class="item-meta">${updated}</span>` : ''}
                ${!largeView ? `<span class="item-meta item-counts">${counts}</span>` : ''}
            </div>
            <div class="item-tools">
                ${reorderBtns}
                ${pinBtn}
                ${copyInTools}
                <button class="tool-btn" onclick="editPrompt(${p.id})" title="Edit"><i class="fas fa-edit"></i></button>
                <button class="tool-btn danger" onclick="deletePrompt(${p.id})" title="Delete"><i class="fas fa-trash"></i></button>
            </div>
        </div>
        ${tagsHtml ? `<div class="item-tags">${tagsHtml}</div>` : ''}
        <div class="prompt-body">${escapeHtml(p.text)}</div>
        ${needsToggle ? `<button class="preview-toggle" onclick="toggleExpand(${p.id})">${expanded
            ? '<i class="fas fa-chevron-up"></i> Show less'
            : '<i class="fas fa-chevron-down"></i> Show more'}</button>` : ''}
        ${largeView ? `<div class="item-footer">
            <button class="copy-btn" onclick="copyPrompt(${p.id})"><i class="fas fa-copy"></i> Copy</button>
            <span class="item-meta"><span class="item-counts">${counts}</span>${updated ? ` · Updated ${updated}` : ''}</span>
        </div>` : ''}
    `;

    if (canReorder) {
        const handle = item.querySelector('.drag-handle');
        if (handle) handle.addEventListener('pointerdown', (e) => startPointerDrag(e, item, p.id, cat));
    }
    return item;
}

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
    document.querySelectorAll('.view-btn').forEach(btn => btn.classList.remove('active'));
    const map = { large: 'view-large', list: 'view-list', compact: 'view-compact' };
    const activeBtn = document.getElementById(map[currentView]);
    if (activeBtn) activeBtn.classList.add('active');
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
    saveLocalData();
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

// Writes a new order to every prompt in the category based on DOM sequence,
// persists (which pushes to Supabase), and re-renders to refresh arrow states.
function commitOrder(category, orderedIds) {
    const indexById = new Map(orderedIds.map((id, i) => [id, i]));
    const changedAt = Date.now();
    appData.prompts.forEach(p => {
        if ((p.category || 'Uncategorized') === category && indexById.has(p.id)) {
            p.order = indexById.get(p.id);
            p.updatedAt = changedAt;
        }
    });
    saveLocalData();
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

    saveLocalData();
    renderPrompts();
};


// Actions
window.copyPrompt = function(id) {
    const prompt = appData.prompts.find(p => p.id === id);
    if (prompt) {
        navigator.clipboard.writeText(prompt.text).then(() => {
            showToast("Copied to clipboard!");
        });
    }
}

window.deletePrompt = function(id) {
    if (confirm("Are you sure you want to delete this prompt?")) {
        const deletedAt = Date.now();
        appData.prompts = appData.prompts.filter(p => p.id !== id);
        appData.deleted = appData.deleted.filter(item => item.id !== id);
        appData.deleted.push({ id, deletedAt });
        expandedIds.delete(id);
        saveLocalData();
        renderPrompts();
    }
}

window.editPrompt = function(id) {
    const prompt = appData.prompts.find(p => p.id === id);
    if (!prompt) return;

    promptTitle.value = prompt.title;
    promptCategory.value = prompt.category || '';
    promptTags.value = prompt.tags ? prompt.tags.join(', ') : '';
    promptText.value = prompt.text;
    promptNotes.value = prompt.notes || '';

    editState = { isEditing: true, id: id };
    promptModalTitle.textContent = "Edit Prompt";
    promptModal.classList.add('active');
}

// Event Listeners
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

categoryFilter.addEventListener('change', renderPrompts);
sortSelect.addEventListener('change', renderPrompts);

addPromptBtn.addEventListener('click', () => {
    promptForm.reset();
    editState = { isEditing: false, id: null };
    promptModalTitle.textContent = "Add New Prompt";
    promptModal.classList.add('active');
});

closePromptBtn.addEventListener('click', () => {
    promptModal.classList.remove('active');
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

    if (editState.isEditing) {
        appData.prompts = appData.prompts.map(p => {
            if (p.id === editState.id) {
                return { ...p, ...promptData };
            }
            return p;
        });
    } else {
        const newId = Date.now();
        appData.deleted = appData.deleted.filter(item => item.id !== newId);
        appData.prompts.push({
            ...promptData,
            id: newId,
            createdAt: newId,
            order: newId // sorts after existing (typically smaller) order values in Custom Order
        });
    }

    saveLocalData();
    renderPrompts();
    promptModal.classList.remove('active');
});

// Settings & Sync
settingsBtn.addEventListener('click', () => {
    accountEmail.textContent = currentUser?.email || 'Unknown account';
    settingsModal.classList.add('active');
});

closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.remove('active');
});

signOutBtn.addEventListener('click', async () => {
    signOutBtn.disabled = true;
    const { error } = await supabaseClient.auth.signOut();
    signOutBtn.disabled = false;
    if (error) {
        showToast(error.message);
        return;
    }
    settingsModal.classList.remove('active');
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

async function startUserSession(user) {
    if (!user) throw new Error('No authenticated user session was returned.');
    if (currentUser?.id === user.id) {
        document.body.classList.add('is-authenticated');
        authScreen.hidden = true;
        appContainer.hidden = false;
        return;
    }
    currentUser = user;
    cloudVersion = 0;
    accountEmail.textContent = user.email || user.id;
    document.body.classList.add('is-authenticated');
    authScreen.hidden = true;
    appContainer.hidden = false;
    loadLocalData();
    ensureOrderField();
    updateViewButtons();
    renderPrompts();
    populateCategories();
    // Do not hold the login screen open while cloud data loads. Sync errors are
    // reported inside syncFromCloud and the locally cached app remains usable.
    void syncFromCloud(false);
}

function withTimeout(promise, milliseconds) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Sign-in timed out. Check your connection and try again.')), milliseconds);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function endUserSession() {
    currentUser = null;
    cloudVersion = 0;
    appData = normalizeData(null);
    localStorage.removeItem('promptManagerData');
    document.body.classList.remove('is-authenticated');
    appContainer.hidden = true;
    authScreen.hidden = false;
    loginEmail.focus();
}

function queueCloudSave() {
    if (!currentUser) return;
    clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => pushToCloud(true), 700);
}

function setCloudState(state, message) {
    const icons = {
        syncing: '<i class="fas fa-spinner fa-spin"></i>',
        synced: '<i class="fas fa-check"></i>',
        error: '<i class="fas fa-exclamation-triangle"></i>'
    };
    syncBtn.innerHTML = icons[state] || '<i class="fas fa-cloud"></i>';
    cloudStatus.textContent = message;
    if (state === 'synced') {
        setTimeout(() => { syncBtn.innerHTML = '<i class="fas fa-cloud"></i>'; }, 1500);
    }
}

async function pushToCloud(allowRetry) {
    if (!currentUser) return;
    if (syncInFlight) {
        syncQueued = true;
        return;
    }
    syncInFlight = true;
    setCloudState('syncing', 'Saving…');

    try {
        const { data, error } = await supabaseClient
            .schema(SUPABASE_CONFIG.schema)
            .rpc('save_data', {
                expected_version: cloudVersion,
                new_data: appData
            });

        if (error) throw error;
        cloudVersion = Number(data);
        setCloudState('synced', 'Synced');
    } catch (error) {
        if (allowRetry && String(error.message).includes('PROMPTS_VERSION_CONFLICT')) {
            syncInFlight = false;
            await syncFromCloud(false);
            return;
        }
        console.error('Error saving to Supabase:', error);
        setCloudState('error', 'Sync failed');
        showToast(`Cloud save failed: ${error.message}`);
    } finally {
        syncInFlight = false;
        if (syncQueued) {
            syncQueued = false;
            queueCloudSave();
        }
    }
}

async function syncFromCloud(showSuccess) {
    if (!currentUser) return;
    if (syncInFlight) {
        syncQueued = true;
        return;
    }
    setCloudState('syncing', 'Checking…');

    try {
        const { data, error } = await supabaseClient
            .schema(SUPABASE_CONFIG.schema)
            .from('prompt_data')
            .select('data, version')
            .eq('user_id', currentUser.id)
            .maybeSingle();

        if (error) throw error;

        if (!data) {
            cloudVersion = 0;
            await pushToCloud(false);
            if (showSuccess) showToast('Cloud storage initialized.');
            return;
        }

        const cloudData = normalizeData(data.data);
        const merged = mergeData(appData, cloudData);
        const needsCloudUpdate = JSON.stringify(merged) !== JSON.stringify(cloudData);
        appData = merged;
        cloudVersion = Number(data.version || 0);
        ensureOrderField();
        localStorage.setItem('promptManagerData', JSON.stringify(appData));
        renderPrompts();
        populateCategories();

        if (needsCloudUpdate) {
            await pushToCloud(true);
        } else {
            setCloudState('synced', 'Synced');
        }
        if (showSuccess) showToast('Cloud sync complete.');
    } catch (error) {
        console.error('Error loading from Supabase:', error);
        setCloudState('error', 'Sync failed');
        showToast(`Cloud sync failed: ${error.message}`);
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

const GIST_FILENAME = "prompts-data.json";

// State
let GITHUB_TOKEN = localStorage.getItem('promptGithubToken') || "";
let GIST_ID = localStorage.getItem('promptGistId') || "";
let appData = {
    lastModified: 0,
    prompts: []
};
let editState = { isEditing: false, id: null };

// View state: 'large' (Large Icons), 'list' (List), 'compact' (Compact)
let currentView = localStorage.getItem('promptManagerView') || 'large';
// IDs of prompts whose body is currently expanded (list/compact views only).
let expandedIds = new Set();
// Categories the user has explicitly collapsed. Persisted so open/closed state
// survives re-renders (reorder/edit/toggle) AND page reloads. Absence = open.
let collapsedCategories = new Set(loadCollapsedState());

function loadCollapsedState() {
    try {
        const raw = localStorage.getItem('promptManagerCollapsed');
        return raw ? JSON.parse(raw) : [];
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
const githubTokenInput = document.getElementById('github-token-input');
const gistIdInput = document.getElementById('gist-id-input');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const closeSettingsBtn = document.getElementById('close-settings-btn');

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
function init() {
    initTheme();
    loadLocalData();
    ensureOrderField();
    updateViewButtons();
    renderPrompts();
    populateCategories();
    if (GITHUB_TOKEN && GIST_ID) {
        syncFromCloud();
    }
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
            appData = JSON.parse(stored);
            if (!appData.prompts) appData = { lastModified: Date.now(), prompts: [] };
        }
    } catch (e) {
        console.error("Error loading local data", e);
    }
}

function saveLocalData() {
    appData.lastModified = Date.now();
    localStorage.setItem('promptManagerData', JSON.stringify(appData));
    populateCategories();
    saveToGist();
}

// Ensures every prompt has a numeric `order` field, used for Custom Order
// sort/drag-and-drop. Existing prompts (from before this feature, or synced
// from an older Gist) fall back to their creation time so their initial
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

        const section = document.createElement('div');
        section.className = 'category-section';
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
        promptsContainer.appendChild(section);
    });
}

function sortPrompts(list, sort) {
    list.sort((a, b) => {
        if (sort === 'date-desc') return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
        if (sort === 'date-asc') return (a.updatedAt ?? 0) - (b.updatedAt ?? 0);
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

    const reorderBtns = canReorder ? `
        <button class="tool-btn" onclick="movePrompt(${p.id}, -1)" title="Move up" aria-label="Move up" ${idx === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
        <button class="tool-btn" onclick="movePrompt(${p.id}, 1)" title="Move down" aria-label="Move down" ${idx === total - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button>` : '';

    // Large view gets a prominent Copy button in the footer, so the tools row
    // there is edit/delete only. List/compact keep copy in the tools row.
    const copyInTools = largeView ? '' : `<button class="tool-btn" onclick="copyPrompt(${p.id})" title="Copy"><i class="fas fa-copy"></i></button>`;

    item.innerHTML = `
        <div class="item-top">
            ${canReorder ? `<button class="drag-handle" aria-label="Drag to reorder" title="Drag to reorder"><i class="fas fa-grip-vertical"></i></button>` : ''}
            <div class="item-head">
                <span class="item-title">${escapeHtml(p.title)}</span>
                ${!largeView && updated ? `<span class="item-meta">${updated}</span>` : ''}
            </div>
            <div class="item-tools">
                ${reorderBtns}
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
            ${updated ? `<span class="item-meta">Updated ${updated}</span>` : ''}
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
window.toggleExpand = function(id) {
    const item = promptsContainer.querySelector('.prompt-item[data-id="' + id + '"]');
    if (!item) return;
    const nowExpanded = item.classList.toggle('is-expanded');
    if (nowExpanded) expandedIds.add(id);
    else expandedIds.delete(id);
    const btn = item.querySelector('.preview-toggle');
    if (btn) {
        btn.innerHTML = nowExpanded
            ? '<i class="fas fa-chevron-up"></i> Show less'
            : '<i class="fas fa-chevron-down"></i> Show more';
    }
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
// persists (which pushes to the Gist), and re-renders to refresh arrow states.
function commitOrder(category, orderedIds) {
    const indexById = new Map(orderedIds.map((id, i) => [id, i]));
    appData.prompts.forEach(p => {
        if ((p.category || 'Uncategorized') === category && indexById.has(p.id)) {
            p.order = indexById.get(p.id);
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

    saveLocalData();
    renderPrompts();
};


// Actions
window.copyPrompt = function(id) {
    const prompt = appData.prompts.find(p => p.id === id);
    if (prompt) {
        navigator.clipboard.writeText(prompt.text).then(() => {
            showToast("Copied to clipboard!");
        }).catch(() => {
            showToast("Copy failed — clipboard unavailable.");
        });
    }
}

window.deletePrompt = function(id) {
    if (confirm("Are you sure you want to delete this prompt?")) {
        appData.prompts = appData.prompts.filter(p => p.id !== id);
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
    githubTokenInput.value = GITHUB_TOKEN;
    gistIdInput.value = GIST_ID;
    settingsModal.classList.add('active');
});

closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.remove('active');
});

saveSettingsBtn.addEventListener('click', () => {
    GITHUB_TOKEN = githubTokenInput.value.trim();
    GIST_ID = gistIdInput.value.trim();
    
    localStorage.setItem('promptGithubToken', GITHUB_TOKEN);
    localStorage.setItem('promptGistId', GIST_ID);
    
    settingsModal.classList.remove('active');
    
    if (GITHUB_TOKEN && GIST_ID) {
        syncFromCloud();
    }
});

syncBtn.addEventListener('click', () => {
    syncFromCloud();
});

let syncTimeout;
function saveToGist() {
    if (!GITHUB_TOKEN || !GIST_ID) return;
    
    clearTimeout(syncTimeout);
    syncTimeout = setTimeout(async () => {
        syncBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        try {
            const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    files: {
                        [GIST_FILENAME]: {
                            content: JSON.stringify(appData, null, 2)
                        }
                    }
                })
            });
            
            if (!response.ok) throw new Error(`GitHub API Error: ${response.status}`);
            
            syncBtn.innerHTML = '<i class="fas fa-check"></i>';
            setTimeout(() => syncBtn.innerHTML = '<i class="fas fa-cloud"></i>', 2000);
        } catch (error) {
            console.error("Error saving to Gist:", error);
            syncBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i>';
            setTimeout(() => syncBtn.innerHTML = '<i class="fas fa-cloud"></i>', 3000);
        }
    }, 1000);
}

async function syncFromCloud() {
    if (!GITHUB_TOKEN || !GIST_ID) {
        showToast("Please configure sync settings first.");
        return;
    }
    
    syncBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    
    try {
        const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            },
            cache: 'no-store'
        });
        
        if (!response.ok) throw new Error(`GitHub API Error: ${response.status}`);
        
        const gist = await response.json();
        
        if (gist.files && gist.files[GIST_FILENAME]) {
            const content = gist.files[GIST_FILENAME].content;
            const cloudData = JSON.parse(content);
            
            if (!cloudData.lastModified) {
                // Handle legacy or empty
                if (appData.prompts.length > 0) saveToGist();
            } else {
                // Compare timestamps
                if (cloudData.lastModified > appData.lastModified) {
                    appData = cloudData;
                    ensureOrderField();
                    localStorage.setItem('promptManagerData', JSON.stringify(appData));
                    renderPrompts();
                    populateCategories();
                    showToast("Synced from cloud.");
                } else if (appData.lastModified > cloudData.lastModified) {
                    saveToGist();
                    showToast("Synced to cloud.");
                } else {
                    showToast("Already up to date.");
                }
            }
            
            syncBtn.innerHTML = '<i class="fas fa-cloud"></i>';
        } else {
            saveToGist();
        }
    } catch (error) {
        console.error("Error loading from Gist:", error);
        syncBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i>';
        setTimeout(() => syncBtn.innerHTML = '<i class="fas fa-cloud"></i>', 3000);
        showToast("Sync failed. Check credentials.");
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
init();

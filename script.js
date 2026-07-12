const GIST_FILENAME = "prompts-data.json";

// State
let GITHUB_TOKEN = localStorage.getItem('promptGithubToken') || "";
let GIST_ID = localStorage.getItem('promptGistId') || "";
let appData = {
    lastModified: 0,
    prompts: []
};
let editState = { isEditing: false, id: null };

// View state: 'large' (Large Icons), 'list' (List), 'details' (Details)
let currentView = localStorage.getItem('promptManagerView') || 'large';
// IDs of prompts whose body is currently expanded (manual expand/collapse state)
let expandedIds = new Set();
// Drag-and-drop state (used only when sort-select === 'custom')
let dragSrcId = null;
let dragSrcCategory = null;

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
    if (currentView === 'large') {
        appData.prompts.forEach(p => expandedIds.add(p.id));
    }
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

// Render
function renderPrompts() {
    const searchTerm = searchInput.value.toLowerCase();
    const category = categoryFilter.value;
    const sort = sortSelect.value;
    const isFiltering = searchTerm.length > 0 || category !== '';
    // Reordering (drag-and-drop / arrow buttons) is only active when the
    // person has explicitly chosen Custom Order, and only while browsing an
    // unfiltered category (dragging within a filtered subset would silently
    // reorder items that aren't visible, which is confusing).
    const canReorder = sort === 'custom' && !isFiltering;

    let filtered = appData.prompts.filter(p => {
        const matchesSearch = p.title.toLowerCase().includes(searchTerm) || 
                              p.text.toLowerCase().includes(searchTerm) || 
                              (p.tags && p.tags.some(t => t.toLowerCase().includes(searchTerm)));
        const matchesCategory = category === "" || p.category === category;
        return matchesSearch && matchesCategory;
    });

    promptsContainer.innerHTML = '';

    if (filtered.length === 0) {
        promptsContainer.innerHTML = '<p class="empty-state">No prompts found.</p>';
        return;
    }

    if (sort === 'custom') {
        const hint = document.createElement('div');
        hint.className = 'reorder-hint';
        hint.innerHTML = isFiltering
            ? '<i class="fas fa-circle-info"></i> Clear search/category filters to drag and reorder prompts.'
            : '<i class="fas fa-grip-vertical"></i> Drag prompts by the handle (or use the arrow buttons) to reorder within a category. Order is saved automatically.';
        promptsContainer.appendChild(hint);
    }

    // Group by category
    const grouped = {};
    filtered.forEach(p => {
        const cat = p.category || 'Uncategorized';
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(p);
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
        if (isFiltering) {
            section.classList.add('expanded');
        }

        const header = document.createElement('div');
        header.className = 'category-header';
        header.onclick = () => section.classList.toggle('expanded');

        header.innerHTML = `
            <i class="fas fa-chevron-right arrow-icon"></i>
            <h2>${escapeHtml(cat)}</h2>
            <span class="category-count">${catPrompts.length}</span>
        `;

        const content = document.createElement('div');
        content.className = 'category-content';

        const contentInner = document.createElement('div');
        contentInner.className = 'category-content-inner';

        let itemsContainer;
        if (currentView === 'list') {
            itemsContainer = document.createElement('div');
            itemsContainer.className = 'prompts-list';
            catPrompts.forEach((p, idx) => {
                itemsContainer.appendChild(createListRow(p, cat, canReorder, idx, catPrompts.length));
            });
        } else if (currentView === 'details') {
            itemsContainer = document.createElement('div');
            itemsContainer.className = 'prompts-table';
            itemsContainer.appendChild(createDetailsHeaderRow());
            catPrompts.forEach((p, idx) => {
                itemsContainer.appendChild(createDetailsRow(p, cat, canReorder, idx, catPrompts.length));
            });
        } else {
            itemsContainer = document.createElement('div');
            itemsContainer.className = 'prompts-grid';
            catPrompts.forEach((p, idx) => {
                itemsContainer.appendChild(createLargeCard(p, cat, canReorder, idx, catPrompts.length));
            });
        }

        contentInner.appendChild(itemsContainer);
        content.appendChild(contentInner);
        section.appendChild(header);
        section.appendChild(content);
        promptsContainer.appendChild(section);
    });
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

// A prompt body only gets a collapse/expand control if it's actually long
// enough to warrant one. Short prompts just render in full, no control needed.
function promptNeedsToggle(text) {
    if (!text) return false;
    const lineBreaks = (text.match(/\n/g) || []).length;
    return text.length > 220 || lineBreaks > 4;
}

// ---- Large Icons view ----
function createLargeCard(p, cat, canReorder, idx, total) {
    const card = document.createElement('div');
    card.className = 'prompt-card';
    card.dataset.id = p.id;
    card.dataset.category = cat;
    if (canReorder) card.draggable = true;

    const tagsHtml = p.tags ? p.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('') : '';
    const isExpanded = expandedIds.has(p.id);
    const needsToggle = promptNeedsToggle(p.text);
    const previewClass = needsToggle ? (isExpanded ? 'expanded' : 'collapsed') : '';

    card.innerHTML = `
        <div class="card-header">
            <span class="drag-handle ${canReorder ? '' : 'drag-handle-hidden'}" title="Drag to reorder">${canReorder ? '<i class="fas fa-grip-vertical"></i>' : ''}</span>
            <div class="card-title">${escapeHtml(p.title)}</div>
        </div>
        <div class="card-tags">${tagsHtml}</div>
        <div class="card-preview ${previewClass}">${escapeHtml(p.text)}</div>
        ${needsToggle ? `<button class="preview-toggle" onclick="toggleExpand(${p.id})" aria-label="${isExpanded ? 'Show less' : 'Show more'}">
            <i class="fas fa-chevron-${isExpanded ? 'up' : 'down'}"></i> ${isExpanded ? 'Show less' : 'Show more'}
        </button>` : ''}
        <div class="card-footer">
            <button class="copy-btn" onclick="copyPrompt(${p.id})">
                <i class="fas fa-copy"></i> Copy
            </button>
            <div class="card-actions">
                ${canReorder ? `
                    <button class="action-icon" onclick="movePrompt(${p.id}, -1)" title="Move up" aria-label="Move up" ${idx === 0 ? 'disabled' : ''}><i class="fas fa-chevron-up"></i></button>
                    <button class="action-icon" onclick="movePrompt(${p.id}, 1)" title="Move down" aria-label="Move down" ${idx === total - 1 ? 'disabled' : ''}><i class="fas fa-chevron-down"></i></button>
                ` : ''}
                <button class="action-icon" onclick="editPrompt(${p.id})" title="Edit"><i class="fas fa-edit"></i></button>
                <button class="action-icon delete" onclick="deletePrompt(${p.id})" title="Delete"><i class="fas fa-trash"></i></button>
            </div>
        </div>
    `;

    if (canReorder) attachDragHandlers(card);
    return card;
}

// ---- List view ----
function createListRow(p, cat, canReorder, idx, total) {
    const row = document.createElement('div');
    row.className = 'prompt-row';
    row.dataset.id = p.id;
    row.dataset.category = cat;
    if (canReorder) row.draggable = true;

    const isExpanded = expandedIds.has(p.id);
    const tagsHtml = tagsPreviewHtml(p.tags, 3);

    row.innerHTML = `
        <span class="drag-handle ${canReorder ? '' : 'drag-handle-hidden'}" title="Drag to reorder">${canReorder ? '<i class="fas fa-grip-vertical"></i>' : ''}</span>
        <button class="row-expand-toggle" onclick="toggleExpand(${p.id})" title="${isExpanded ? 'Collapse' : 'Expand'}" aria-label="${isExpanded ? 'Collapse' : 'Expand'}">
            <i class="fas fa-chevron-${isExpanded ? 'down' : 'right'}"></i>
        </button>
        <div class="row-title">${escapeHtml(p.title)}</div>
        <div class="row-tags">${tagsHtml}</div>
        <div class="row-actions">
            ${canReorder ? `
                <button class="action-icon" onclick="movePrompt(${p.id}, -1)" title="Move up" aria-label="Move up" ${idx === 0 ? 'disabled' : ''}><i class="fas fa-chevron-up"></i></button>
                <button class="action-icon" onclick="movePrompt(${p.id}, 1)" title="Move down" aria-label="Move down" ${idx === total - 1 ? 'disabled' : ''}><i class="fas fa-chevron-down"></i></button>
            ` : ''}
            <button class="action-icon" onclick="copyPrompt(${p.id})" title="Copy"><i class="fas fa-copy"></i></button>
            <button class="action-icon" onclick="editPrompt(${p.id})" title="Edit"><i class="fas fa-edit"></i></button>
            <button class="action-icon delete" onclick="deletePrompt(${p.id})" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
        ${isExpanded ? `<div class="row-preview">${escapeHtml(p.text)}</div>` : ''}
    `;

    if (canReorder) attachDragHandlers(row);
    return row;
}

// ---- Details view ----
function createDetailsHeaderRow() {
    const header = document.createElement('div');
    header.className = 'prompt-detail-row prompt-detail-header';
    header.innerHTML = `
        <span></span>
        <span></span>
        <span>Title</span>
        <span>Tags</span>
        <span>Updated</span>
        <span></span>
    `;
    return header;
}

function createDetailsRow(p, cat, canReorder, idx, total) {
    const row = document.createElement('div');
    row.className = 'prompt-detail-row';
    row.dataset.id = p.id;
    row.dataset.category = cat;
    if (canReorder) row.draggable = true;

    const isExpanded = expandedIds.has(p.id);
    const tagsHtml = tagsPreviewHtml(p.tags, 2);
    const updatedStr = p.updatedAt ? new Date(p.updatedAt).toLocaleDateString() : '—';

    row.innerHTML = `
        <span class="drag-handle ${canReorder ? '' : 'drag-handle-hidden'}" title="Drag to reorder">${canReorder ? '<i class="fas fa-grip-vertical"></i>' : ''}</span>
        <button class="row-expand-toggle" onclick="toggleExpand(${p.id})" title="${isExpanded ? 'Collapse' : 'Expand'}" aria-label="${isExpanded ? 'Collapse' : 'Expand'}">
            <i class="fas fa-chevron-${isExpanded ? 'down' : 'right'}"></i>
        </button>
        <div class="row-title">${escapeHtml(p.title)}</div>
        <div class="row-tags">${tagsHtml}</div>
        <div class="row-updated">${updatedStr}</div>
        <div class="row-actions">
            ${canReorder ? `
                <button class="action-icon" onclick="movePrompt(${p.id}, -1)" title="Move up" aria-label="Move up" ${idx === 0 ? 'disabled' : ''}><i class="fas fa-chevron-up"></i></button>
                <button class="action-icon" onclick="movePrompt(${p.id}, 1)" title="Move down" aria-label="Move down" ${idx === total - 1 ? 'disabled' : ''}><i class="fas fa-chevron-down"></i></button>
            ` : ''}
            <button class="action-icon" onclick="copyPrompt(${p.id})" title="Copy"><i class="fas fa-copy"></i></button>
            <button class="action-icon" onclick="editPrompt(${p.id})" title="Edit"><i class="fas fa-edit"></i></button>
            <button class="action-icon delete" onclick="deletePrompt(${p.id})" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
        ${isExpanded ? `<div class="row-preview">${escapeHtml(p.text)}</div>` : ''}
    `;

    if (canReorder) attachDragHandlers(row);
    return row;
}

function tagsPreviewHtml(tags, max) {
    if (!tags || tags.length === 0) return '';
    const shown = tags.slice(0, max).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
    const extra = tags.length > max ? `<span class="tag">+${tags.length - max}</span>` : '';
    return shown + extra;
}

// ---- View switching ----
window.setView = function(view) {
    if (view === currentView) return;
    currentView = view;
    localStorage.setItem('promptManagerView', view);
    // Large Icons shows full bodies by default; List/Details start collapsed.
    expandedIds = new Set();
    if (view === 'large') {
        appData.prompts.forEach(p => expandedIds.add(p.id));
    }
    updateViewButtons();
    renderPrompts();
}

function updateViewButtons() {
    document.querySelectorAll('.view-btn').forEach(btn => btn.classList.remove('active'));
    const map = { large: 'view-large', list: 'view-list', details: 'view-details' };
    const activeBtn = document.getElementById(map[currentView]);
    if (activeBtn) activeBtn.classList.add('active');
}

// ---- Expand/collapse ----
window.toggleExpand = function(id) {
    if (expandedIds.has(id)) {
        expandedIds.delete(id);
    } else {
        expandedIds.add(id);
    }
    renderPrompts();
}

// ---- Drag-and-drop reordering ----
function attachDragHandlers(el) {
    el.addEventListener('dragstart', handleDragStart);
    el.addEventListener('dragover', handleDragOver);
    el.addEventListener('dragleave', handleDragLeave);
    el.addEventListener('drop', handleDrop);
    el.addEventListener('dragend', handleDragEnd);
}

function handleDragStart(e) {
    dragSrcId = Number(e.currentTarget.dataset.id);
    dragSrcCategory = e.currentTarget.dataset.category;
    e.currentTarget.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(dragSrcId)); } catch (err) { /* Firefox needs this set, ignore failures elsewhere */ }
}

function handleDragOver(e) {
    e.preventDefault();
    const el = e.currentTarget;
    if (Number(el.dataset.id) === dragSrcId) return;
    const rect = el.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    el.classList.toggle('drag-over-above', before);
    el.classList.toggle('drag-over-below', !before);
}

function handleDragLeave(e) {
    e.currentTarget.classList.remove('drag-over-above', 'drag-over-below');
}

function handleDrop(e) {
    e.preventDefault();
    const el = e.currentTarget;
    const targetId = Number(el.dataset.id);
    const targetCategory = el.dataset.category;
    const insertAbove = el.classList.contains('drag-over-above');
    el.classList.remove('drag-over-above', 'drag-over-below');

    if (dragSrcId === null || dragSrcId === targetId) return;
    // Reordering only makes sense within the same category grouping.
    // Cross-category drags are silently ignored; use Edit to change category.
    if (dragSrcCategory !== targetCategory) {
        dragSrcId = null;
        dragSrcCategory = null;
        return;
    }
    reorderWithinCategory(dragSrcId, targetId, insertAbove, targetCategory);
    dragSrcId = null;
    dragSrcCategory = null;
}

function handleDragEnd(e) {
    e.currentTarget.classList.remove('dragging');
    document.querySelectorAll('.drag-over-above, .drag-over-below').forEach(el => {
        el.classList.remove('drag-over-above', 'drag-over-below');
    });
    dragSrcId = null;
    dragSrcCategory = null;
}

function reorderWithinCategory(draggedId, targetId, insertAbove, category) {
    const catPrompts = appData.prompts.filter(p => (p.category || 'Uncategorized') === category);
    catPrompts.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    const draggedIndex = catPrompts.findIndex(p => p.id === draggedId);
    if (draggedIndex === -1) return;
    const [draggedItem] = catPrompts.splice(draggedIndex, 1);

    const targetIndex = catPrompts.findIndex(p => p.id === targetId);
    if (targetIndex === -1) {
        catPrompts.push(draggedItem);
    } else {
        const insertIndex = insertAbove ? targetIndex : targetIndex + 1;
        catPrompts.splice(insertIndex, 0, draggedItem);
    }

    // Re-number sequentially so the new visual order is captured exactly.
    catPrompts.forEach((p, idx) => { p.order = idx; });

    saveLocalData();
    renderPrompts();
}

// Arrow-button reordering (accessible / touch-friendly alternative to drag)
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
}

function populateCategories() {
    const categories = new Set(appData.prompts.map(p => p.category).filter(c => c));
    
    // Update datalist
    categoryList.innerHTML = '';
    categories.forEach(c => {
        const option = document.createElement('option');
        option.value = c;
        categoryList.appendChild(option);
    });

    // Update filter dropdown
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
        if (currentView === 'large') expandedIds.add(newId);
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
                    if (currentView === 'large') {
                        expandedIds = new Set(appData.prompts.map(p => p.id));
                    }
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

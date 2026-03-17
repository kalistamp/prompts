const GIST_FILENAME = "prompts-data.json";

// State
let GITHUB_TOKEN = localStorage.getItem('promptGithubToken') || "";
let GIST_ID = localStorage.getItem('promptGistId') || "";
let appData = {
    lastModified: 0,
    prompts: []
};
let editState = { isEditing: false, id: null };

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

// Render
function renderPrompts() {
    const searchTerm = searchInput.value.toLowerCase();
    const category = categoryFilter.value;
    const sort = sortSelect.value;

    let filtered = appData.prompts.filter(p => {
        const matchesSearch = p.title.toLowerCase().includes(searchTerm) || 
                              p.text.toLowerCase().includes(searchTerm) || 
                              (p.tags && p.tags.some(t => t.toLowerCase().includes(searchTerm)));
        const matchesCategory = category === "" || p.category === category;
        return matchesSearch && matchesCategory;
    });

    filtered.sort((a, b) => {
        if (sort === 'date-desc') return b.updatedAt - a.updatedAt;
        if (sort === 'date-asc') return a.updatedAt - b.updatedAt;
        if (sort === 'name-asc') return a.title.localeCompare(b.title);
        if (sort === 'name-desc') return b.title.localeCompare(a.title);
        return 0;
    });

    promptsContainer.innerHTML = '';
    
    if (filtered.length === 0) {
        promptsContainer.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 40px;">No prompts found.</p>';
        return;
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

    const isFiltering = searchTerm.length > 0 || category !== '';

    sortedCategories.forEach(cat => {
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
            <span class="category-count">${grouped[cat].length}</span>
        `;

        const content = document.createElement('div');
        content.className = 'category-content';

        const contentInner = document.createElement('div');
        contentInner.className = 'category-content-inner';

        const grid = document.createElement('div');
        grid.className = 'prompts-grid';

        grouped[cat].forEach(p => {
            const card = document.createElement('div');
            card.className = 'prompt-card';
            
            const tagsHtml = p.tags ? p.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('') : '';
            
            card.innerHTML = `
                <div class="card-header">
                    <div class="card-title">${escapeHtml(p.title)}</div>
                </div>
                <div class="card-tags">${tagsHtml}</div>
                <div class="card-preview">${escapeHtml(p.text)}</div>
                <div class="card-footer">
                    <button class="copy-btn" onclick="copyPrompt(${p.id})">
                        <i class="fas fa-copy"></i> Copy
                    </button>
                    <div class="card-actions">
                        <button class="action-icon" onclick="editPrompt(${p.id})" title="Edit"><i class="fas fa-edit"></i></button>
                        <button class="action-icon delete" onclick="deletePrompt(${p.id})" title="Delete"><i class="fas fa-trash"></i></button>
                    </div>
                </div>
            `;
            grid.appendChild(card);
        });

        contentInner.appendChild(grid);
        content.appendChild(contentInner);
        section.appendChild(header);
        section.appendChild(content);
        promptsContainer.appendChild(section);
    });
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
        appData.prompts.push({
            ...promptData,
            id: Date.now(),
            createdAt: Date.now()
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

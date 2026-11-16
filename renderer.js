const selectFileBtn = document.getElementById('selectFileBtn');
const fileInput = document.getElementById('fileInput');
const startBtn = document.getElementById('startBtn');
const clearAllBtn = document.getElementById('clearAllBtn');
const toggleViewBtn = document.getElementById('toggleViewBtn');
const toggleViewLabel = document.getElementById('toggleViewLabel');
const openOutputsBtn = document.getElementById('openOutputsBtn');
const aiSettingsBtn = document.getElementById('aiSettingsBtn');
const aiSettingsModal = document.getElementById('aiSettingsModal');
const saveAiSettingsBtn = document.getElementById('saveAiSettingsBtn');
const closeAiSettingsBtn = document.getElementById('closeAiSettingsBtn');
const geminiApiKeyInput = document.getElementById('geminiApiKeyInput');
const wandToleranceInput = document.getElementById('wandToleranceInput');
const aiTitleBanner = document.getElementById('aiTitleBanner');
const aiTitleText = document.getElementById('aiTitleText');

const nightModeCheckbox = document.getElementById('nightModeCheckbox');

const checkUpdateBtn = document.getElementById('checkUpdateBtn');
const appVersionBadge = document.getElementById('appVersionBadge');
const updateModalOverlay = document.getElementById('updateModalOverlay');
const updateVersionPill = document.getElementById('updateVersionPill');
const updateNotesBox = document.getElementById('updateNotesBox');
const updateStatusText = document.getElementById('updateStatusText');
const confirmUpdateBtn = document.getElementById('confirmUpdateBtn');
const confirmUpdateLabel = document.getElementById('confirmUpdateLabel');
const closeUpdateModalBtn = document.getElementById('closeUpdateModalBtn');
const toastBanner = document.getElementById('toastBanner');

const controls = document.getElementById('controls');
const hudMainWorkspace = document.getElementById('hudMainWorkspace');
const progressWrapper = document.getElementById('progressWrapper');
const progressText = document.getElementById('progressText');
const progressBar = document.getElementById('progressBar');
const percentText = document.getElementById('percentText');

const refreshGalleryBtn = document.getElementById('refreshGalleryBtn');
const clearGalleryBtn = document.getElementById('clearGalleryBtn');
const galleryGrid = document.getElementById('galleryGrid');
const galleryContainer = document.getElementById('galleryContainer');

const filePreviewBox = document.getElementById('filePreviewBox');
const processingPreviewContainer = document.getElementById('processingPreviewContainer');
const processingImage = document.getElementById('processingImage');
const scannerLine = document.getElementById('scannerLine');
const mainHudCard = document.getElementById('mainHudCard');

let selectedFiles = [];
let fileIdCounter = 0;
let isViewVisible = false;

const ICON_CLOSE_SVG = `
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"></line>
    <line x1="6" y1="6" x2="18" y2="18"></line>
  </svg>
`;

const ICON_CHECK_SVG = `
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>
`;

function showToast(msg, duration = 3500) {
  if (!toastBanner) return;
  toastBanner.textContent = msg;
  toastBanner.style.display = 'block';
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    toastBanner.style.display = 'none';
  }, duration);
}

// ==========================================================
// DAY / NIGHT THEME TOGGLE
// ==========================================================
const savedNightMode = localStorage.getItem('mydesigns_night_mode') === 'true';
if (nightModeCheckbox) {
  nightModeCheckbox.checked = savedNightMode;
  document.body.classList.toggle('night-mode', savedNightMode);

  nightModeCheckbox.addEventListener('change', () => {
    const isNight = nightModeCheckbox.checked;
    document.body.classList.toggle('night-mode', isNight);
    localStorage.setItem('mydesigns_night_mode', isNight ? 'true' : 'false');
  });
}

// ==========================================================
// LIVE AUTO-UPDATE POPUP LOGIC
// ==========================================================
if (window.api.onAppVersion) {
  window.api.onAppVersion((ver) => {
    if (appVersionBadge && ver) {
      appVersionBadge.textContent = `v${ver}`;
    }
  });
}

if (checkUpdateBtn) {
  checkUpdateBtn.addEventListener('click', () => {
    showToast('Checking online for updates...');
    window.api.checkForUpdate(true);
  });
}

if (window.api.onUpdateAvailable) {
  window.api.onUpdateAvailable((info) => {
    if (isViewVisible) {
      setWebsiteViewMode(false);
    }
    updateVersionPill.textContent = `v${info.currentVersion} -> v${info.newVersion}`;
    updateNotesBox.textContent = info.notes || 'New features and improvements are ready to install.';
    updateStatusText.style.display = 'none';
    confirmUpdateBtn.disabled = false;
    confirmUpdateLabel.textContent = 'Update & Restart Now';
    closeUpdateModalBtn.style.display = 'inline-flex';
    updateModalOverlay.style.display = 'flex';
  });
}

if (confirmUpdateBtn) {
  confirmUpdateBtn.addEventListener('click', () => {
    confirmUpdateBtn.disabled = true;
    confirmUpdateLabel.textContent = 'Updating...';
    closeUpdateModalBtn.style.display = 'none';
    updateStatusText.style.display = 'block';
    updateStatusText.style.color = 'var(--brand-blue)';
    updateStatusText.textContent = 'Downloading latest files...';
    window.api.startLiveUpdate();
  });
}

if (closeUpdateModalBtn) {
  closeUpdateModalBtn.addEventListener('click', () => {
    updateModalOverlay.style.display = 'none';
  });
}

if (window.api.onUpdateStatus) {
  window.api.onUpdateStatus((status) => {
    if (status.type === 'progress') {
      updateStatusText.style.display = 'block';
      updateStatusText.style.color = 'var(--brand-blue)';
      updateStatusText.textContent = status.message;
    } else if (status.type === 'error') {
      updateStatusText.style.display = 'block';
      updateStatusText.style.color = '#ef4444';
      updateStatusText.textContent = status.message;
      confirmUpdateBtn.disabled = false;
      confirmUpdateLabel.textContent = 'Retry Update';
      closeUpdateModalBtn.style.display = 'inline-flex';
    } else if (status.type === 'toast') {
      showToast(status.message, 4000);
    }
  });
}

// ==========================================================
// AI KEY & TOLERANCE SETTINGS
// ==========================================================
if (geminiApiKeyInput) geminiApiKeyInput.value = localStorage.getItem('mydesigns_gemini_key') || '';
if (wandToleranceInput) wandToleranceInput.value = localStorage.getItem('mydesigns_wand_tol') || '10';

if (openOutputsBtn) {
  openOutputsBtn.addEventListener('click', () => {
    window.api.startTask({ action: 'open-output-folder' });
  });
}

if (aiSettingsBtn) {
  aiSettingsBtn.addEventListener('click', () => {
    aiSettingsModal.style.display = 'flex';
  });
}

if (closeAiSettingsBtn) {
  closeAiSettingsBtn.addEventListener('click', () => {
    aiSettingsModal.style.display = 'none';
  });
}

if (saveAiSettingsBtn) {
  saveAiSettingsBtn.addEventListener('click', () => {
    localStorage.setItem('mydesigns_gemini_key', geminiApiKeyInput.value.trim());
    localStorage.setItem('mydesigns_wand_tol', wandToleranceInput.value.trim() || '10');
    aiSettingsModal.style.display = 'none';
    showToast('AI Key and tolerance settings saved.');
  });
}

// ==========================================================
// WEBSITE VIEW TOGGLE & QUEUE LOGIC
// ==========================================================
function setWebsiteViewMode(visible) {
  isViewVisible = visible;
  document.body.classList.toggle('view-active', isViewVisible);
  if (toggleViewLabel) {
    toggleViewLabel.textContent = isViewVisible ? 'Hide Website' : 'Show Website / Login';
  }
  window.api.toggleView(isViewVisible);
}

toggleViewBtn.addEventListener('click', () => {
  setWebsiteViewMode(!isViewVisible);
});

selectFileBtn.addEventListener('click', () => fileInput.click());

clearAllBtn.addEventListener('click', () => {
  selectedFiles = [];
  filePreviewBox.innerHTML = '';
  updateQueueText();
});

function updateQueueText() {
  let textEl = document.getElementById('previewCountText');
  if (!textEl) {
    textEl = document.createElement('span');
    textEl.id = 'previewCountText';
    textEl.style.color = 'var(--brand-blue)';
    textEl.style.fontSize = '11.5px';
    textEl.style.fontWeight = '600';
    textEl.style.width = '100%';
    textEl.style.textAlign = 'center';
    textEl.style.marginTop = '2px';
    filePreviewBox.appendChild(textEl);
  }

  textEl.textContent = `${selectedFiles.length} image(s) queued for processing`;

  if (selectedFiles.length === 0) {
    filePreviewBox.style.display = 'none';
    hudMainWorkspace.classList.remove('active');
    startBtn.disabled = true;
    clearAllBtn.style.display = 'none';
  } else {
    hudMainWorkspace.classList.add('active');
    filePreviewBox.style.display = 'flex';
    startBtn.disabled = false;
    clearAllBtn.style.display = 'inline-flex';
  }
}

async function processSelectedFiles(filesArray) {
  if (filesArray.length > 0) {
    const existingText = document.getElementById('previewCountText');
    if (existingText) existingText.remove();

    const imageFiles = filesArray.filter(file => file.type.startsWith('image/'));

    for (const file of imageFiles) {
      const base64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => resolve(event.target.result);
        reader.readAsDataURL(file);
      });

      const currentId = 'thumb-' + fileIdCounter++;
      selectedFiles.push({ id: currentId, name: file.name, type: file.type, data: base64 });

      const wrapper = document.createElement('div');
      wrapper.className = 'thumb-wrapper';
      wrapper.id = 'wrapper-' + currentId;

      const img = document.createElement('img');
      img.src = base64;
      img.title = file.name;

      const delBtn = document.createElement('div');
      delBtn.className = 'delete-btn';
      delBtn.innerHTML = ICON_CLOSE_SVG;
      delBtn.title = 'Remove from queue';

      const checkmark = document.createElement('div');
      checkmark.className = 'checkmark';
      checkmark.innerHTML = ICON_CHECK_SVG;

      delBtn.onclick = () => {
        selectedFiles = selectedFiles.filter(f => f.id !== currentId);
        wrapper.remove();
        updateQueueText();
      };

      wrapper.appendChild(img);
      wrapper.appendChild(checkmark);
      wrapper.appendChild(delBtn);
      filePreviewBox.appendChild(wrapper);
    }
    updateQueueText();
  }
}

fileInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  await processSelectedFiles(files);
  fileInput.value = '';
});

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
  document.body.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
  }, false);
});

['dragenter', 'dragover'].forEach(eventName => {
  mainHudCard.addEventListener(eventName, () => {
    mainHudCard.classList.add('drag-over');
  }, false);
});

['dragleave', 'drop'].forEach(eventName => {
  mainHudCard.addEventListener(eventName, () => {
    mainHudCard.classList.remove('drag-over');
  }, false);
});

mainHudCard.addEventListener('drop', async (e) => {
  const files = Array.from(e.dataTransfer.files);
  await processSelectedFiles(files);
});

// ==========================================================
// GALLERY & WORKFLOW LOGIC
// ==========================================================
refreshGalleryBtn.addEventListener('click', () => {
  galleryGrid.innerHTML = '<p class="gallery-empty-msg" style="color: var(--brand-blue);">Scanning active designs on canvas...</p>';
  window.api.refreshGallery();
});

if (clearGalleryBtn) {
  clearGalleryBtn.addEventListener('click', () => {
    galleryGrid.innerHTML = '<p class="gallery-empty-msg">Gallery cleared. Click "Refresh" to view active canvas designs.</p>';
  });
}

window.api.onGalleryData((images) => {
  galleryGrid.innerHTML = '';
  if (!images || images.length === 0) {
    galleryGrid.innerHTML = '<p class="gallery-empty-msg">No active designs detected on canvas.</p>';
    return;
  }
  images.forEach(src => {
    const img = document.createElement('img');
    img.src = src;
    galleryGrid.appendChild(img);
  });
});

function startProcessMode(title, isVectorize) {
  controls.style.display = 'none';
  galleryContainer.style.display = 'none';
  if (aiTitleBanner) aiTitleBanner.classList.add('visible');

  document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.style.display = 'none';
  });

  hudMainWorkspace.classList.add('active');
  progressWrapper.style.display = 'block';
  progressBar.style.width = '0%';
  percentText.textContent = '0%';
  progressText.textContent = title;
  progressText.style.color = 'var(--brand-blue)';
  scannerLine.style.background = 'linear-gradient(90deg, transparent, #0ea5e9, #ffffff, #0ea5e9, transparent)';

  if (isVectorize && selectedFiles.length > 0) {
    processingImage.src = selectedFiles[0].data;
    processingPreviewContainer.style.display = 'flex';
  } else {
    processingPreviewContainer.style.display = 'none';
  }

  setWebsiteViewMode(true);
}

startBtn.addEventListener('click', () => {
  if (selectedFiles.length === 0) return;
  startProcessMode('Initializing batch processing pipeline...', true);
  const savedApiKey = localStorage.getItem('mydesigns_gemini_key') || '';
  const savedTol = Number(localStorage.getItem('mydesigns_wand_tol') || '10');
  window.api.startTask({
    files: selectedFiles,
    apiKey: savedApiKey,
    tolerance: savedTol
  });
});

window.api.onProgressUpdate((data) => {
  if (data.aiTitle && aiTitleBanner && aiTitleText) {
    aiTitleBanner.classList.add('visible');
    aiTitleText.textContent = `AI Title: ${data.aiTitle}`;
  }
  if (data.percent !== undefined) {
    progressBar.style.width = data.percent + '%';
    percentText.textContent = data.percent + '%';
  }
  if (data.text !== undefined) {
    progressText.textContent = data.text;
  }

  if (data.activeIndex !== undefined && data.activeIndex >= 0) {
    const activeFile = selectedFiles[data.activeIndex];
    if (activeFile) {
      processingImage.src = activeFile.data;

      if (data.isCompleted) {
        const thumbWrapper = document.getElementById('wrapper-' + activeFile.id);
        if (thumbWrapper) {
          thumbWrapper.classList.add('completed');
        }

        const countText = document.getElementById('previewCountText');
        if (countText) {
          const remaining = selectedFiles.length - (data.activeIndex + 1);
          countText.textContent = remaining > 0
            ? `${remaining} image(s) remaining in queue...`
            : 'All queued images completed and saved.';
        }
      }
    }
  }
});

window.api.onStatusUpdate((message) => {
  const isError = /error|failed|timeout/i.test(message) || message.includes('❌');
  const isSuccess = /completed|saved|cleaned|success/i.test(message) || message.includes('✅');

  if (isSuccess || isError) {
    progressText.textContent = message;
    progressText.style.color = isError ? '#ef4444' : 'var(--brand-blue)';

    setTimeout(() => {
      selectedFiles = [];
      filePreviewBox.innerHTML = '';
      filePreviewBox.style.display = 'none';
      hudMainWorkspace.classList.remove('active');
      if (aiTitleBanner) aiTitleBanner.classList.remove('visible');
      startBtn.disabled = true;
      clearAllBtn.style.display = 'none';

      controls.style.display = 'flex';
      toggleViewBtn.style.display = 'inline-flex';
      progressWrapper.style.display = 'none';
      processingPreviewContainer.style.display = 'none';
      galleryContainer.style.display = 'flex';
      setWebsiteViewMode(false);
      window.api.refreshGallery();
    }, 3500);
  }
});

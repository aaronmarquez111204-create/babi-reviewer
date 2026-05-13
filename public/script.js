let questions = [];
let currentIndex = 0;
let score = 0;
let selectedOption = null;
let timerInterval;
let timeLeft = 30; // 30 seconds per question
let selectedFileBase64 = null;
let quizLibrary = [];
let studyGuideLibrary = [];
let userAnswers = [];
let questionsAnswered = [];
let isPaused = false;
let studyHistory = [];      // Track all quiz results
let weakPointsTracker = {}; // Track missed categories: { Category: Count }
let currentQuizId = null;   // To identify if it's a library quiz
let currentQuizTitle = "AI Assistant Quiz";
let currentFlashcardIndex = 0;
let currentFlashcardContent = ""; // Temp storage for flashcard summary
let loadingTimerInterval = null;  // Elapsed seconds for the loading bar
let performanceChart = null;      // Chart.js instance
let currentFlashcardSet = [];    // Data for the active flashcard session
let isNCLEXMode = false;         // Global toggle for strict testing
let currentView = 'dashboard';   // Track active sidebar view

/** Show & start the fill loading bar + elapsed timer */
function showLoading(statusText) {
  const overlay = document.getElementById('loading-overlay');
  const statusEl = document.getElementById('loading-status');
  const timerEl = document.getElementById('loading-timer');
  const bar = document.getElementById('loading-fill-bar');

  if (statusEl && statusText) statusEl.textContent = statusText;
  if (timerEl) timerEl.textContent = '0s elapsed';
  if (bar) bar.style.width = '0%';
  overlay.style.display = 'flex';

  // Animate bar: fills quickly at first, then slows near 90%
  let progress = 0;
  let seconds = 0;
  clearInterval(loadingTimerInterval);
  loadingTimerInterval = setInterval(() => {
    seconds++;
    if (timerEl) timerEl.textContent = seconds + 's elapsed';

    // Progress curve: fast start, slow near the end
    if (progress < 90) {
      const increment = progress < 40 ? 8 : progress < 70 ? 4 : 1;
      progress = Math.min(progress + increment, 90);
      if (bar) bar.style.width = progress + '%';
    }
  }, 1000);
}

/** Complete the fill bar to 100% and hide the overlay */
function hideLoading() {
  const bar = document.getElementById('loading-fill-bar');
  // Snap to 100% so it feels "done"
  if (bar) {
    bar.style.width = '100%';
  }
  setTimeout(() => {
    document.getElementById('loading-overlay').style.display = 'none';
    if (bar) bar.style.width = '0%';
    clearInterval(loadingTimerInterval);
    loadingTimerInterval = null;
  }, 350); // Short pause at 100% before hiding
}



/**
 * Universal Backend Bridge
 * Detects if running on a Web Server (Render/Local) or Google Apps Script
 */
const isGAS = (typeof google !== 'undefined' && google.script && google.script.run);
const isWeb = !isGAS;

async function callBackend(funcName, args = {}) {
  if (isWeb) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000); // 90s timeout

    return fetch(`/api/${funcName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {}),
      signal: controller.signal
    }).then(response => {
      clearTimeout(timeoutId);
      if (!response.ok) {
        return response.text().then(text => {
          throw new Error(text || response.statusText);
        });
      }
      return response.json();
    }).catch(err => {
      clearTimeout(timeoutId);
      hideLoading();
      if (err.name === 'AbortError') {
        throw new Error("Request timed out. Your internet or the tunnel link might be slow.");
      }
      throw err;
    });
  } else {
    return new Promise((resolve, reject) => {
      google.script.run
        .withSuccessHandler(resolve)
        .withFailureHandler(err => {
          hideLoading(); // Safety: Always hide on failure
          reject(err);
        })[funcName](...Object.values(args));
    });
  }
}

/**
 * Settings Management
 */
function toggleSettings() {
  const modal = document.getElementById('settings-modal');
  modal.style.display = modal.style.display === 'none' ? 'flex' : 'none';
}

function checkApiKeyStatus() {
  if (isWeb) {
    fetch('/api/getHasApiKey', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(r => r.json()).then(hasKey => {
        if (!hasKey) setTimeout(toggleSettings, 1000);
      });
  } else {
    google.script.run.withSuccessHandler(hasKey => {
      if (!hasKey) setTimeout(toggleSettings, 1000);
    }).getHasApiKey();
  }
}

/**
 * NEW: Audio Review (Text-to-Speech)
 */
function speakText(text) {
  if (!text) return;
  // Stop any current speaking
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.9; // Slightly slower for clarity
  utterance.pitch = 1;
  window.speechSynthesis.speak(utterance);
}

/**
 * Sidebar Navigation: Switch between different sections
 */
function switchView(viewId) {
  currentView = viewId;
  
  // Update Nav Active State
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => item.classList.remove('active'));
  
  const activeNav = document.getElementById(`nav-${viewId}`);
  if (activeNav) activeNav.classList.add('active');
  
  // Update View Visibility
  const views = document.querySelectorAll('.view-section');
  views.forEach(view => view.classList.remove('active'));
  
  const targetView = document.getElementById(`view-${viewId}`);
  if (targetView) targetView.classList.add('active');

  // Trigger specific view logic
  if (viewId === 'dashboard') {
    updateBentoInsights();
    updateSRS(); // NEW: Refresh due quizes
  }
}

function saveSettings() {
  const key = document.getElementById('api-key-input').value;
  if (!key) return alert("Please enter a valid API Key");

  if (isWeb) {
    callBackend('setApiKey', { key }).then(() => {
      alert('API Key saved securely!');
      toggleSettings();
      checkApiKeyStatus();
    }).catch(err => alert(err.message));
  } else {
    google.script.run
      .withSuccessHandler(() => {
        alert("API Key saved securely!");
        toggleSettings();
      })
      .setApiKey(key);
  }
}

function runDiagnosticTest() {
  const btn = event.target;
  const originalText = btn.textContent;
  btn.textContent = "Testing...";
  btn.disabled = true;

  const modelSelect = document.getElementById('model-select');
  const selectedModel = modelSelect ? modelSelect.value : null;

  if (isWeb) {
    callBackend('testAiConnection', { selectedModel }).then(res => {
      btn.textContent = originalText;
      btn.disabled = false;
      alert('DIAGNOSTIC RESULT:\n\n' + res);
    }).catch(err => {
      btn.textContent = originalText;
      btn.disabled = false;
      alert('CRITICAL CONNECTION FAILURE:\n\n' + err.message);
    });
  } else {
    google.script.run
      .withSuccessHandler(result => {
        btn.textContent = originalText;
        btn.disabled = false;
        alert("DIAGNOSTIC RESULT:\n\n" + result);
      })
      .withFailureHandler(err => {
        btn.textContent = originalText;
        btn.disabled = false;
        alert("CRITICAL CONNECTION FAILURE:\n\n" + err.message);
      })
      .testAiConnection(selectedModel);
  }
}

function scanModels(btnEl) {
  const btn = btnEl || event.target;
  const originalText = btn.textContent;
  btn.textContent = "Scanning...";
  btn.disabled = true;

  document.getElementById('scan-status').textContent = "Scanning for available models...";

  if (isWeb) {
    fetch('/api/listAvailableModels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(r => r.json()).then(models => {
        btn.textContent = originalText;
        btn.disabled = false;
        renderModels(models || []);
      }).catch(err => {
        btn.textContent = originalText;
        btn.disabled = false;
        document.getElementById('scan-status').textContent = "Scan failed.";
      });
  } else {
    google.script.run
      .withSuccessHandler(models => {
        btn.textContent = originalText;
        btn.disabled = false;
        renderModels(models || []);
      })
      .withFailureHandler(err => {
        btn.textContent = originalText;
        btn.disabled = false;
        document.getElementById('scan-status').textContent = "Scan failed: " + err.message;
      })
      .listAvailableModels();
  }
}

function renderModels(models) {
  const select = document.getElementById('model-select');
  select.innerHTML = '';

  if (!models || models.length === 0) {
    document.getElementById('scan-status').textContent = "No models found or invalid API key.";
    return;
  }

  models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.name;
    opt.textContent = m.displayName || m.name;
    select.appendChild(opt);
  });
  document.getElementById('scan-status').textContent = `Found ${models.length} models.`;
}
function handleFileSelect(input) {
  const file = input.files[0];
  if (!file) return;

  document.getElementById('file-status').textContent = "Reading file...";

  const reader = new FileReader();
  reader.onload = function (e) {
    const base64 = e.target.result.split(',')[1];
    selectedFileBase64 = base64;
    document.getElementById('file-status').textContent = "Ready: " + file.name;
  };
  reader.onerror = () => {
    alert("Error reading file.");
    document.getElementById('file-status').textContent = "Upload PDF Reviewer";
  };
  reader.readAsDataURL(file);
}

function generateAIQuiz() {
  const contextText = document.getElementById('ai-context').value;
  if (!contextText || contextText.trim().length < 50) {
    alert("Please paste more text from your PDF (at least 50 characters) to help the AI generate good questions.");
    return;
  }
  const count = parseInt(document.getElementById('ai-count').value);

  const modelSelect = document.getElementById('model-select');
  const selectedModel = modelSelect ? modelSelect.value : null;

  const statusMessages = [
    "Babi is analyzing your text...",
    "Identifying key nursing concepts...",
    "Drafting clinical questions...",
    "Polishing rationales..."
  ];

  showLoading(statusMessages[0]);
  let msgIndex = 1;
  const interval = setInterval(() => {
    document.getElementById('loading-status').textContent = statusMessages[msgIndex % statusMessages.length];
    msgIndex++;
  }, 2500);

  if (isWeb) {
    callBackend('generateQuiz', { contextText, count, selectedModel }).then(res => {
      clearInterval(interval);
      // Server returns the array directly, not wrapped in an object
      handleQuizSuccess(Array.isArray(res) ? res : res.questions);
    }).catch(err => {
      clearInterval(interval);
      handleQuizFailure(err);
    });
  } else {
    google.script.run
      .withSuccessHandler(data => {
        clearInterval(interval);
        handleQuizSuccess(data);
      })
      .withFailureHandler(err => {
        clearInterval(interval);
        handleQuizFailure(err);
      })
      .generateQuizFromText(contextText, count, selectedModel);
  }
}

function handleQuizSuccess(data) {
  hideLoading();

  if (!data || data.length === 0) {
    alert("The AI couldn't generate questions from that text. Try pasting a larger section!");
    return;
  }

  const newQuiz = {
    id: Date.now(),
    title: document.getElementById('ai-title').value.trim() || 'Untitled AI Quiz',
    questions: data
  };
  quizLibrary.push(newQuiz);
  localStorage.setItem('babisQuizLibrary', JSON.stringify(quizLibrary));
  document.getElementById('ai-title').value = '';

  currentQuizTitle = newQuiz.title;
  currentQuizId = newQuiz.id;

  questions = data;
  shuffleArray(questions);
  document.getElementById('start-screen').style.display = 'none';
  document.getElementById('quiz-screen').style.display = 'block';
  document.getElementById('total-count').textContent = questions.length;
  document.getElementById('max-score').textContent = questions.length;
  currentIndex = 0;
  score = 0;
  loadQuestion();
  startTimer();
  renderLibrary();
  updateBentoInsights();
  switchLibraryTab('quizzes'); // Ensure they see the new quiz
}

function handleQuizFailure(err) {
  hideLoading();
  console.error("AI Generation Failed:", err);
  const msg = err.message || "Unknown error";
  if (msg.includes("503") || msg.includes("overloaded")) {
    alert("Babi's AI is currently very busy! Please wait a moment and try clicking 'Generate Quiz' again, or switch to a different model in Settings.");
  } else if (msg.includes("429") || msg.includes("quota")) {
    alert("You've reached your free AI limit! Google only allows 15-20 requests per minute for free. Please wait about 45-60 seconds and try again, or switch to a different 'Flash' model in Settings to continue immediately.");
  } else {
    alert("AI Processing Failed:\n\n" + msg);
  }
}

function startLibraryQuiz(id) {
  const quiz = quizLibrary.find(q => q.id === id);
  if (!quiz) return;
  currentQuizTitle = quiz.title;
  currentQuizId = quiz.id;
  questions = quiz.questions;
  userAnswers = new Array(questions.length).fill(null);
  questionsAnswered = new Array(questions.length).fill(false);
  shuffleArray(questions);

  document.getElementById('start-screen').style.display = 'none';
  document.getElementById('quiz-screen').style.display = 'block';
  document.getElementById('total-count').textContent = questions.length;
  document.getElementById('max-score').textContent = questions.length;
  currentIndex = 0;
  score = 0;

  // Check NCLEX Mode
  isNCLEXMode = document.getElementById('nclex-mode-toggle').checked;
  if (isNCLEXMode) {
    timeLeft = 60; // NCLEX allows roughly 60s per question
  } else {
    timeLeft = 30;
  }

  loadQuestion();
  startTimer();
}

function goHome() {
  document.getElementById('result-screen').style.display = 'none';
  document.getElementById('quiz-screen').style.display = 'none';
  switchView('dashboard');
  checkSavedData();
}

function showDashboard() {
  goHome();
}

function checkSavedData() {
  try {
    // Load Quizzes
    const savedQuizzes = localStorage.getItem('babisQuizLibrary');
    if (savedQuizzes) {
      quizLibrary = JSON.parse(savedQuizzes);
    } else {
      const oldSaved = localStorage.getItem('babisReviewerData');
      if (oldSaved) {
        quizLibrary = [{
          id: Date.now(),
          title: "My Pre-Library Saved Quiz",
          questions: JSON.parse(oldSaved)
        }];
        localStorage.setItem('babisQuizLibrary', JSON.stringify(quizLibrary));
        localStorage.removeItem('babisReviewerData');
      }
    }

    // Load Study Guides
    const savedGuides = localStorage.getItem('babisStudyGuideLibrary');
    if (savedGuides) {
      studyGuideLibrary = JSON.parse(savedGuides);
    }

    // Load History
    const savedHistory = localStorage.getItem('babisStudyHistory');
    if (savedHistory) {
      studyHistory = JSON.parse(savedHistory);
    }

    // Load Weak Points
    const savedWeakPoints = localStorage.getItem('babisWeakPoints');
    if (savedWeakPoints) {
      weakPointsTracker = JSON.parse(savedWeakPoints);
    }
  } catch (e) {
    console.warn("Storage Error, resetting libraries.");
    quizLibrary = [];
    studyGuideLibrary = [];
    studyHistory = [];
    weakPointsTracker = {};
  }
  renderLibrary();
  renderStudyGuides();
  updateBentoInsights();
  checkResumeButton();
}

function saveActiveSession() {
  if (!questions || questions.length === 0) return;
  const session = {
    quizId: currentQuizId,
    title: currentQuizTitle,
    questions: questions,
    currentIndex: currentIndex,
    userAnswers: userAnswers,
    questionsAnswered: questionsAnswered,
    score: score,
    timeLeft: timeLeft
  };
  localStorage.setItem('babisLastSession', JSON.stringify(session));
}

function clearSavedSession() {
  localStorage.removeItem('babisLastSession');
  checkResumeButton();
}

function checkResumeButton() {
  const saved = localStorage.getItem('babisLastSession');
  const container = document.getElementById('resume-session-container');
  const titleEl = document.getElementById('saved-quiz-title');
  if (saved) {
    const session = JSON.parse(saved);
    if (titleEl) titleEl.textContent = session.title;
    if (container) container.style.display = 'block';
  } else {
    if (container) container.style.display = 'none';
  }
}

function resumeLastQuiz() {
  const saved = localStorage.getItem('babisLastSession');
  if (!saved) return;
  const session = JSON.parse(saved);

  currentQuizId = session.quizId;
  currentQuizTitle = session.title;
  questions = session.questions;
  currentIndex = session.currentIndex || 0;
  userAnswers = session.userAnswers || [];
  questionsAnswered = session.questionsAnswered || [];
  score = session.score || 0;
  timeLeft = session.timeLeft || 30;

  document.getElementById('start-screen').style.display = 'none';
  document.getElementById('quiz-screen').style.display = 'block';
  document.getElementById('total-count').textContent = questions.length;
  document.getElementById('max-score').textContent = questions.length;

  loadQuestion();
  startTimer();
}

/**
 * New: Updates the Bento Dashboard Insight tile
 */
function updateBentoInsights() {
  const statusVal = document.querySelector('.insights-header h3') || { textContent: "" };
  const listCont = document.getElementById('stats-list-container');
  if (!listCont) return;

  if (studyHistory.length === 0) {
    listCont.innerHTML = '<div style="opacity:0.5; font-size:0.8rem; text-align:center; padding:1rem;">Finish a quiz to see your insights.</div>';
    return;
  }
  
  updateChartData(); // NEW: Refresh the trends chart

  // Render Recent Scores (Last 3)
  const recent = [...studyHistory].slice(-3).reverse();
  listCont.innerHTML = recent.map(record => `
      <div class="score-row animate-fade" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.8rem;">
        <div style="flex:1; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; padding-right:1rem;">
          <div style="font-size:0.85rem; font-weight:600;">${record.title}</div>
          <div style="font-size:0.7rem; color:var(--text-dim);">${record.date}</div>
        </div>
        <div class="score-pill" style="color: ${record.score / record.total >= 0.7 ? 'var(--accent-blue)' : 'var(--accent-orange)'};">
          ${record.score}/${record.total}
        </div>
      </div>
    `).join('');

  // Render Weak Areas (Top 3)
  const weakCont = document.getElementById('weak-areas-container');
  if (weakCont) {
    const sortedWeak = Object.entries(weakPointsTracker)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    if (sortedWeak.length === 0) {
      weakCont.innerHTML = '<div style="opacity:0.4; font-size:0.7rem; text-align:center; padding:0.5rem;">Study more to reveal weak points!</div>';
    } else {
      weakCont.innerHTML = sortedWeak.map(([cat, count]) => `
                <div class="weak-point-badge animate-fade">
                    <span class="weak-point-label">${cat}</span>
                    <span class="weak-point-count">${count} missed</span>
                </div>
            `).join('');
    }
  }
}

/**
 * Library Tab Management
 */
function switchLibraryTab(tab) {
  const qBtn = document.getElementById('tab-quizzes');
  const gBtn = document.getElementById('tab-guides');
  const qCont = document.getElementById('library-container');
  const gCont = document.getElementById('guides-container');

  if (tab === 'quizzes') {
    qBtn.classList.add('active');
    gBtn.classList.remove('active');
    qCont.style.display = 'grid';
    gCont.style.display = 'none';
  } else {
    qBtn.classList.remove('active');
    gBtn.classList.add('active');
    qCont.style.display = 'none';
    gCont.style.display = 'grid';
  }
  updateFlashcardCTA();
}

function renderLibrary() {
  const container = document.getElementById('library-container');
  if (!container) return;

  container.innerHTML = '';

  if (quizLibrary.length === 0) {
    container.innerHTML = '<p style="opacity:0.5; font-size:0.9rem; text-align:center; width:100%; margin: 1rem 0;">No quizzes saved yet. Generate one below!</p>';
    return;
  }

  // Sort so newest is at the top
  const sortedLibrary = [...quizLibrary].sort((a, b) => b.id - a.id);

  sortedLibrary.forEach(quiz => {
    const card = document.createElement('div');
    card.className = 'library-card animate-fade';

    const icons = [
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-primary-main"><path d="M4 19.5h16"/><path d="M4 4.5h16V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4.5z"/></svg>',
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-primary-main"><path d="M21 15V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4"/><line x1="3" x2="21" y1="15" y2="15"/><line x1="3" x2="21" y1="10" y2="10"/></svg>',
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-primary-main"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/></svg>'
    ];
    const icon = icons[quiz.id % icons.length];

    card.innerHTML = `
        <div onclick="startLibraryQuiz(${quiz.id})" style="flex:1; cursor:pointer;">
          <div style="display:flex; gap:1rem; align-items:center; margin-bottom:1rem;">
            ${icon}
            <h3 style="margin:0; font-size:1rem; font-weight:600;">${quiz.title}</h3>
          </div>
          <p style="font-size:0.8rem; color:var(--text-muted); opacity:0.7;">${quiz.questions.length} Questions</p>
        </div>
        <div style="display:flex; justify-content:flex-end; margin-top:1rem; border-top:1px solid rgba(0,0,0,0.05); padding-top:0.8rem;">
          <button class="delete-btn" onclick="event.stopPropagation(); deleteQuiz(${quiz.id})" style="padding:0.4rem 0.8rem; display:flex; align-items:center; gap:0.4rem;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            Remove
          </button>
        </div>
      `;
    container.appendChild(card);
  });
}

function deleteQuiz(id) {
  if (confirm("Permanently delete this quiz from your library?")) {
    quizLibrary = quizLibrary.filter(q => q.id !== id);
    localStorage.setItem('babisQuizLibrary', JSON.stringify(quizLibrary));
    renderLibrary();
    updateBentoInsights();
  }
}

function renderStudyGuides() {
  const container = document.getElementById('guides-container');
  if (!container) return;

  container.innerHTML = '';

  if (studyGuideLibrary.length === 0) {
    container.innerHTML = '<p style="opacity:0.5; font-size:0.9rem; text-align:center; width:100%; margin: 1rem 0;">No study guides saved yet. Simplify some text to begin!</p>';
    updateFlashcardCTA();
    return;
  }

  const sortedGuides = [...studyGuideLibrary].sort((a, b) => b.id - a.id);

  sortedGuides.forEach(guide => {
    const card = document.createElement('div');
    card.className = 'library-card guide-card animate-fade';

    card.innerHTML = `
        <div onclick="viewSavedNote(${guide.id})" style="flex:1; cursor:pointer;">
          <div style="display:flex; gap:1rem; align-items:center; margin-bottom:1rem;">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-accent"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
            <h3 style="margin:0; font-size:1rem; font-weight:600;">${guide.title}</h3>
          </div>
          <p style="font-size:0.8rem; color:var(--text-muted); opacity:0.7;">Saved Note</p>
        </div>
        <div style="display:flex; justify-content:flex-end; margin-top:1rem; border-top:1px solid rgba(0,0,0,0.05); padding-top:0.8rem;">
          <button class="delete-btn" onclick="event.stopPropagation(); deleteNote(${guide.id})" style="padding:0.4rem 0.8rem; display:flex; align-items:center; gap:0.4rem;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6+v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a1 2 0 0 1 2 2v2"/></svg>
            Remove
          </button>
        </div>
      `;
    container.appendChild(card);
  });
  updateFlashcardCTA();
}

function deleteNote(id) {
  if (confirm("Permanently delete this study guide?")) {
    studyGuideLibrary = studyGuideLibrary.filter(g => g.id !== id);
    localStorage.setItem('babisStudyGuideLibrary', JSON.stringify(studyGuideLibrary));
    renderStudyGuides();
  }
}

function updateFlashcardCTA() {
  const cta = document.getElementById('flashcard-study-cta');
  if (!cta) return;
  const tabGuides = document.getElementById('tab-guides');
  if (tabGuides && tabGuides.classList.contains('active') && studyGuideLibrary.length > 0) {
    cta.style.display = 'block';
  } else {
    cta.style.display = 'none';
  }
}

/**
 * Celebration: Perfect Score Party Poppers
 */
function triggerPerfectScoreEffects() {
  const end = Date.now() + (3 * 1000); // 3 seconds of celebration
  const colors = ['#ff007f', '#7b2cbf', '#00b4d8', '#ff9e00', '#ffffff'];

  (function frame() {
    // Side Cannon - Left
    confetti({
      particleCount: 3,
      angle: 60,
      spread: 55,
      origin: { x: 0 },
      colors: colors
    });
    // Side Cannon - Right
    confetti({
      particleCount: 3,
      angle: 120,
      spread: 55,
      origin: { x: 1 },
      colors: colors
    });

    if (Date.now() < end) {
      requestAnimationFrame(frame);
    }
  }());

  // Center Burst after small delay
  setTimeout(() => {
    confetti({
      particleCount: 150,
      spread: 70,
      origin: { y: 0.6 },
      colors: ['#ff9e00', '#ffffff'],
      scalar: 1.2
    });
  }, 500);
}
window.addEventListener('DOMContentLoaded', () => {
  checkSavedData();
  checkApiKeyStatus();
});

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

/**
 * Load current question data into UI
 */
function loadQuestion() {
  saveActiveSession();
  const q = questions[currentIndex];
  selectedOption = userAnswers[currentIndex];

  // Resume previous state if it exists
  if (!questionsAnswered[currentIndex]) {
    timeLeft = 30;
    isPaused = false;
    document.getElementById('submit-btn').textContent = "Submit Answer";
  } else {
    isPaused = true;
    document.getElementById('submit-btn').textContent = "View Rationale";
  }

  updateTimerDisplay();
  document.getElementById('submit-btn').disabled = (selectedOption === null && !questionsAnswered[currentIndex]);
  document.getElementById('feedback-modal').style.display = 'none';

  // Navigation Buttons Logic
  document.getElementById('prev-btn').disabled = (currentIndex === 0 || isNCLEXMode); // NCLEX doesn't allow going back
  document.getElementById('next-quiz-btn').textContent = (currentIndex === questions.length - 1) ? "Finish Quiz" : "Skip / Next";

  // Update count and progress
  document.getElementById('current-count').textContent = currentIndex + 1;
  const progressPercent = ((currentIndex) / questions.length) * 100;
  document.getElementById('progress').style.width = progressPercent + '%';

  // Set Text
  document.getElementById('question').textContent = q.question;
  const optionsContainer = document.getElementById('options');
  optionsContainer.innerHTML = '';

  // Create Options
  q.options.forEach((opt, idx) => {
    const btn = document.createElement('button');
    btn.className = 'option-btn animate-fade';
    btn.style.animationDelay = (idx * 0.1) + 's';

    if (questionsAnswered[currentIndex]) {
      btn.onclick = () => { };
      if (selectedOption === idx) btn.classList.add('selected');
      btn.style.cursor = 'default';
    } else {
      btn.onclick = () => selectOption(idx, btn);
      if (selectedOption === idx) btn.classList.add('selected');
    }

    const letter = String.fromCharCode(65 + idx);
    btn.innerHTML = `
        <div style="display:flex; align-items:center; gap:1.2rem; text-align:left;">
          <div style="background: rgba(123, 44, 191, 0.1); color: var(--primary-main); min-width: 36px; height: 36px; display: flex; justify-content: center; align-items: center; border-radius: 10px; font-weight: 700; font-size: 0.9rem;">${letter}</div>
          <span style="font-weight: 500;">${opt}</span>
        </div>
      `;
    optionsContainer.appendChild(btn);
  });
}

/**
 * Highlight selected option
 */
function selectOption(index, element) {
  if (questionsAnswered[currentIndex]) return;

  selectedOption = index;
  userAnswers[currentIndex] = index;

  const allBtns = document.querySelectorAll('.option-btn');
  allBtns.forEach(b => b.classList.remove('selected'));
  element.classList.add('selected');
  document.getElementById('submit-btn').disabled = false;
}

/**
 * Check answer and show feedback
 */
function handleSubmit() {
  isPaused = true; // Pause timer
  const q = questions[currentIndex];
  const isCorrect = selectedOption === q.answer;

  if (!questionsAnswered[currentIndex]) {
    questionsAnswered[currentIndex] = true;
    userAnswers[currentIndex] = selectedOption;
    if (isCorrect) score++;
  }

  saveActiveSession();
  
  // NCLEX Logic: Hide rationale until end if mode is active
  if (isNCLEXMode) {
    advanceQuestion(); // Auto-advance in NCLEX mode
  } else {
    showModal(isCorrect, q.options[q.answer], q.rationale);
  }
}

function speakRationale() {
  const text = document.getElementById('rationale-text').textContent;
  speakText(text);
}

function showModal(isCorrect, correctAnswerText, rationale) {
  const status = document.getElementById('feedback-status');
  const msg = document.getElementById('feedback-msg');
  const iconContainer = document.getElementById('feedback-icon-container');
  const answerBox = document.getElementById('correct-answer-box');
  const answerText = document.getElementById('correct-answer-text');
  const rationaleText = document.getElementById('rationale-text');

  // Reset classes
  status.className = isCorrect ? 'success' : 'error';
  iconContainer.className = 'feedback-icon ' + (isCorrect ? 'success' : 'error');

  if (isCorrect) {
    status.textContent = "Correct!";
    msg.textContent = "Great job, you nailed it!";
    iconContainer.innerHTML = '<div style="background: rgba(16, 185, 129, 0.1); color: var(--success); width: 80px; height: 80px; border-radius: 50%; display: flex; justify-content: center; align-items: center; border: 2px solid var(--success); margin: 0 auto 1.5rem;"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></div>';
    answerBox.style.display = 'none';
  } else {
    status.textContent = "Incorrect";
    msg.textContent = "Don't worry, keep learning!";
    iconContainer.innerHTML = '<div style="background: rgba(239, 68, 68, 0.1); color: var(--error); width: 80px; height: 80px; border-radius: 50%; display: flex; justify-content: center; align-items: center; border: 2px solid var(--error); margin: 0 auto 1.5rem;"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></div>';
    answerBox.style.display = 'block';
    answerText.textContent = correctAnswerText;
  }

  // Populate Rationale
  rationaleText.textContent = rationale || "No rationale available for this question.";

  const nextBtn = document.getElementById('next-btn');
  if (nextBtn) {
    if (currentIndex === questions.length - 1) {
      nextBtn.textContent = "Finish Quiz";
    } else {
      nextBtn.textContent = "Next Question";
    }
  }

  document.getElementById('feedback-modal').style.display = 'flex';
}

function advanceQuestion() {
  goNext();
}

function goNext() {
  if (currentIndex < questions.length - 1) {
    currentIndex++;
    loadQuestion();
  } else {
    finishQuiz();
  }
}

function goPrevious() {
  if (currentIndex > 0) {
    currentIndex--;
    loadQuestion();
  }
}

/**
 * Timer that pauses during feedback
 */
function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (isPaused) return;

    timeLeft--;
    updateTimerDisplay();

    if (timeLeft <= 0) {
      handleSubmit(); // Auto-submit when time runs out
    }
  }, 1000);
}

function updateTimerDisplay() {
  const timerEl = document.getElementById('timer');
  if (questionsAnswered[currentIndex]) {
    timerEl.textContent = "Done";
    timerEl.style.color = 'var(--text-muted)';
  } else {
    const m = Math.floor(timeLeft / 60);
    const s = timeLeft % 60;
    timerEl.textContent = m + ':' + (s < 10 ? '0' : '') + s;
    timerEl.style.color = timeLeft <= 5 ? 'var(--error)' : 'var(--primary)';
  }
}

function quitQuiz() {
  if (confirm("Would you like to save your progress to resume later?\n\nPress OK to Save & Quit.\nPress Cancel to Discard & Quit.")) {
    saveActiveSession();
    clearInterval(timerInterval);
    document.getElementById('quiz-screen').style.display = 'none';
    document.getElementById('start-screen').style.display = 'block';
    updateBentoInsights();
    checkResumeButton();
  } else {
    if (confirm("Are you sure you want to DISCARD your progress?")) {
      clearSavedSession();
      clearInterval(timerInterval);
      document.getElementById('quiz-screen').style.display = 'none';
      document.getElementById('start-screen').style.display = 'block';
      updateBentoInsights();
    }
  }
}

/**
 * Final Screen
 */
function finishQuiz() {
  clearInterval(timerInterval);
  clearSavedSession();

  // Hide the feedback modal before transitioning to the results screen
  document.getElementById('feedback-modal').style.display = 'none';

  document.getElementById('quiz-screen').style.display = 'none';
  document.getElementById('result-screen').style.display = 'block';

  document.getElementById('final-score').textContent = score;
  document.getElementById('max-score').textContent = questions.length;

  const msg = document.getElementById('performance-msg');
  const percent = (score / questions.length) * 100;

  if (percent === 100) {
    msg.innerHTML = "<strong style='color: var(--accent-orange);'>PERFECT SCORE!</strong><br>I Love You Babi, Congratulations! You did great!<br>You've achieved total mastery!";
    triggerPerfectScoreEffects();
  } else if (percent >= 90) msg.innerHTML = "<strong>Elite Status!</strong><br>You're absolutely ready for the boards!";
  else if (percent >= 70) msg.innerHTML = "<strong>Great Job!</strong><br>A very solid performance.";
  else if (percent >= 50) msg.innerHTML = "<strong>Good effort!</strong><br>A bit more reviewing will make you unstoppable.";
  else msg.innerHTML = "<strong>Keep going!</strong><br>Review the materials and try again—you've got this.";

  // Track category misses
  questions.forEach((q, idx) => {
    if (userAnswers[idx] !== q.answer) {
      const cat = q.category || "General";
      weakPointsTracker[cat] = (weakPointsTracker[cat] || 0) + 1;
    }
  });
  localStorage.setItem('babisWeakPoints', JSON.stringify(weakPointsTracker));

  // Save result to History
  studyHistory.push({
    title: currentQuizTitle,
    score: score,
    total: questions.length,
    date: new Date().toLocaleDateString()
  });
  localStorage.setItem('babisStudyHistory', JSON.stringify(studyHistory));
  updateBentoInsights();
}

function restartQuiz() {
  userAnswers = new Array(questions.length).fill(null);
  questionsAnswered = new Array(questions.length).fill(false);
  currentIndex = 0;
  score = 0;
  document.getElementById('result-screen').style.display = 'none';
  document.getElementById('quiz-screen').style.display = 'block';
  shuffleArray(questions);
  loadQuestion();
  startTimer();
}

/**
 * NEW: Content Simplification Feature
 */
function explainContent() {
  const contextText = document.getElementById('ai-context').value;
  if (!contextText || contextText.trim().length < 50) {
    alert("Please paste some text first (at least 50 characters).");
    return;
  }

  const modelSelect = document.getElementById('model-select');
  const selectedModel = modelSelect ? modelSelect.value : null;

  showLoading("Babi is simplifying the content for you...");

  if (isWeb) {
    callBackend('explainContent', { contextText, selectedModel }).then(res => {
      hideLoading();
      showExplanationModal("Study Guide", res.explanation);
    }).catch(err => {
      hideLoading();
      const originalMsg = err.message || "Unknown error";
      let msg = "Simplification failed: " + originalMsg;

      if (originalMsg.includes("503")) {
        msg = "Babi's AI brain is currently very busy (Peak Demand)! Please wait a few seconds and try again, or try switching to a 'Flash' model in Settings.";
      } else if (originalMsg.includes("429") || originalMsg.includes("quota")) {
        msg = "You've reached your free AI limit! Google only allows 15-20 requests per minute. Please wait about a minute, or try a different 'Flash' model in Settings.";
      }
      alert(msg);
    });
  } else {
    google.script.run
      .withSuccessHandler(explanation => {
        hideLoading();
        showExplanationModal("Study Guide", explanation);
      })
      .withFailureHandler(err => {
        hideLoading();
        const originalMsg = err.message || "Unknown error";
        const msg = originalMsg.includes("503")
          ? "Babi's AI brain is currently very busy (Peak Demand)! Please wait a few seconds and try again, or try switching to a 'Flash' model in Settings for a faster response."
          : (originalMsg.includes("429") || originalMsg.includes("quota"))
            ? "Free Limit Reached! Please wait about 60 seconds or try switching to a different 'Flash' model in Settings."
            : "Simplification failed: " + originalMsg;
        alert(msg);
      })
      .explainReviewerContent(contextText, selectedModel);
  }
}

/**
 * NEW: Word Explainer Feature
 */
function explainWord() {
  const word = document.getElementById('word-input').value.trim();
  const contextText = document.getElementById('ai-context').value;

  if (!word) {
    alert("Please enter a word to explain.");
    return;
  }

  const modelSelect = document.getElementById('model-select');
  const selectedModel = modelSelect ? modelSelect.value : null;

  showLoading(`Babi is defining "${word}"...`);

  if (isWeb) {
    callBackend('defineWord', { word, contextText, selectedModel }).then(res => {
      hideLoading();
      showExplanationModal(`Defining: ${word}`, res.definition);
      document.getElementById('word-input').value = '';
    }).catch(err => {
      hideLoading();
      const msg = (err.message && err.message.includes("503"))
        ? "Babi's AI brain is currently overloaded! Please wait a moment and try again, or try switching to a 'Flash' model in Settings."
        : "Definition failed: " + err.message;
      alert(msg);
    });
  } else {
    google.script.run
      .withSuccessHandler(definition => {
        hideLoading();
        showExplanationModal(`Defining: ${word}`, definition);
        document.getElementById('word-input').value = '';
      })
      .withFailureHandler(err => {
        hideLoading();
        const originalMsg = err.message || "Unknown error";
        const msg = originalMsg.includes("503")
          ? "Babi's AI brain is currently overloaded! Please wait a moment and try again, or try switching to a 'Flash' model in Settings."
          : "Definition failed: " + originalMsg;
        alert(msg);
      })
      .defineWord(word, contextText, selectedModel);
  }
}

/**
 * Helper: Show Explanation Modal with formatted content
 */
function showExplanationModal(title, rawContent) {
  let mainContent = rawContent;
  currentFlashcardContent = ""; // Reset

  if (rawContent.includes("---FLASHCARD---")) {
    const parts = rawContent.split("---FLASHCARD---");
    mainContent = parts[0].trim();
    currentFlashcardContent = parts[1].trim();
  }

  document.getElementById('explanation-title').textContent = title;
  const body = document.getElementById('explanation-body');

  // Advanced Markdown to HTML Conversion
  let html = mainContent
    // 1. Convert headers
    .replace(/^### (.*$)/gim, '<h3 style="margin-top: 1rem; margin-bottom: 0.5rem; color: var(--accent-purple);">$1</h3>')
    .replace(/^## (.*$)/gim, '<h3 style="margin-top: 1rem; margin-bottom: 0.5rem; color: var(--accent-purple);">$1</h3>')

    // 2. Convert standard bold **text**
    .replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>')

    // 3. VAPORIZE all remaining unmatched double asterisks
    .replace(/\*\*/g, '')

    // 4. Convert bullets (* or - with space at the beginning of line)
    .replace(/^\s*[\*\-]\s+(.*$)/gim, '<ul><li style="margin-left: 1.5rem; margin-bottom: 0.6rem; list-style-type: disc; line-height: 1.5;">$1</li></ul>')

    // 5. Convert standard italic *text* 
    .replace(/\*(?!\s)([^\*]+)(?<!\s)\*/g, '<em>$1</em>')

    // 6. VAPORIZE all remaining single asterisks
    .replace(/\*/g, '')

    // 7. Handle line breaks
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>')

    // 8. Merge consecutive list items
    .replace(/<\/ul><br><ul>/g, '')
    .replace(/<\/ul>\s*<ul>/g, '');

  body.innerHTML = html;
  document.getElementById('explanation-modal').style.display = 'flex';
}

function closeExplanation() {
  document.getElementById('explanation-modal').style.display = 'none';
  const saveBtn = document.querySelector('.btn-save-note');
  saveBtn.classList.remove('saved');
  saveBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg><span>Save</span>';

  // Reset copy button
  const copyBtn = document.getElementById('copy-explanation-btn');
  if (copyBtn) {
    copyBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg><span>Copy</span>';
  }
}

/**
 * Copy Explanation text to clipboard
 */
function copyExplanationText() {
  const text = document.getElementById('explanation-body').innerText;
  const btn = document.getElementById('copy-explanation-btn');

  navigator.clipboard.writeText(text).then(() => {
    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"></path></svg><span>Copied!</span>';

    setTimeout(() => {
      btn.innerHTML = originalHtml;
    }, 2000);
  }).catch(err => {
    console.error('Failed to copy: ', err);
    alert("Failed to copy text. Please select and copy manually.");
  });
}

/**
 * Save Note Logic
 */
function saveCurrentExplanation() {
  const title = document.getElementById('explanation-title').textContent;
  const content = document.getElementById('explanation-body').innerHTML;
  const saveBtn = document.querySelector('.btn-save-note');

  if (studyGuideLibrary.some(g => g.title === title && g.content === content)) {
    return alert("This note is already in your study guide!");
  }

  const newNote = {
    id: Date.now(),
    title: title,
    content: content,
    flashcard: currentFlashcardContent
  };

  studyGuideLibrary.push(newNote);
  localStorage.setItem('babisStudyGuideLibrary', JSON.stringify(studyGuideLibrary));
  renderStudyGuides();
  switchLibraryTab('guides'); // Ensure they see the new guide

  // UI Feedback
  saveBtn.classList.add('saved');
  saveBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"></path></svg><span>Saved</span>';
}

function viewSavedNote(id) {
  const note = studyGuideLibrary.find(g => g.id === id);
  if (!note) return;

  document.getElementById('explanation-title').textContent = note.title;
  document.getElementById('explanation-body').innerHTML = note.content;
  document.getElementById('explanation-modal').style.display = 'flex';

  // Set saved state
  const saveBtn = document.querySelector('.btn-save-note');
  saveBtn.classList.add('saved');
  saveBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"></path></svg><span>In Library</span>';
}
/**
 * Flashcard System Logic
 */
function startFlashcards() {
  if (studyGuideLibrary.length === 0) return;
  currentFlashcardIndex = 0;
  const modal = document.getElementById('flashcard-modal');
  modal.style.display = 'flex';
  renderCurrentFlashcard();
}

function closeFlashcards() {
  document.getElementById('flashcard-modal').style.display = 'none';
}

function renderCurrentFlashcard() {
  const card = studyGuideLibrary[currentFlashcardIndex];
  const container = document.querySelector('.flashcard-container');

  // Reset flip state
  container.classList.remove('flipped');

  document.getElementById('card-counter').textContent = `Card ${currentFlashcardIndex + 1} of ${studyGuideLibrary.length}`;

  // Strip HTML to plain text for a clean single-paragraph view
  const rawHtml = card.flashcard || card.content || '';
  const tmp = document.createElement('div');
  tmp.innerHTML = rawHtml;
  const plainText = (tmp.innerText || tmp.textContent || '').trim()
    .replace(/\n{2,}/g, ' ') // collapse multiple newlines into a space
    .replace(/\n/g, ' ')     // collapse single newlines
    .trim();

  document.getElementById('card-front-text').textContent = plainText;
  
  // Populate Back (Term + Full Answer)
  const backTitle = document.getElementById('card-back-text');
  const existingDetail = backTitle.parentElement.querySelector('.flashcard-answer-detail');
  if (existingDetail) existingDetail.remove();

  backTitle.textContent = card.title;
  
  const backAnswer = document.createElement('div');
  backAnswer.className = 'flashcard-answer-detail';
  backAnswer.innerHTML = card.content;
  backAnswer.style.fontSize = '0.9rem';
  backAnswer.style.marginTop = '1rem';
  backAnswer.style.opacity = '0.9';
  backAnswer.style.textAlign = 'left';
  backAnswer.style.borderTop = '1px solid rgba(255,255,255,0.1)';
  backAnswer.style.paddingTop = '1rem';
  backAnswer.style.maxHeight = '200px';
  backAnswer.style.overflowY = 'auto';

  backTitle.parentElement.appendChild(backAnswer);
}

function nextCard() {
  if (currentFlashcardIndex < studyGuideLibrary.length - 1) {
    currentFlashcardIndex++;
    renderCurrentFlashcard();
  } else {
    // Loop back to start or show finish?
    currentFlashcardIndex = 0;
    renderCurrentFlashcard();
  }
}

function prevCard() {
  if (currentFlashcardIndex > 0) {
    currentFlashcardIndex--;
    renderCurrentFlashcard();
  }
}

/**
 * NEW: AI Chat Logic
 */
function openChat() {
  document.getElementById('chat-modal').style.display = 'flex';
}

function closeChat() {
  document.getElementById('chat-modal').style.display = 'none';
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;

  const messagesCont = document.getElementById('chat-messages');
  
  // User Message
  const userMsg = document.createElement('div');
  userMsg.style = "background: var(--accent-pink); color: white; padding: 0.8rem 1rem; border-radius: 15px 15px 0 15px; align-self: flex-end; max-width: 80%; font-size: 0.9rem;";
  userMsg.textContent = text;
  messagesCont.appendChild(userMsg);
  
  input.value = '';
  messagesCont.scrollTop = messagesCont.scrollHeight;

  // AI Typing...
  const typingMsg = document.createElement('div');
  typingMsg.style = "background: rgba(255,255,255,0.05); padding: 0.8rem 1rem; border-radius: 15px 15px 15px 0; align-self: flex-start; max-width: 80%; font-size: 0.9rem; opacity: 0.6;";
  typingMsg.textContent = "Babi is thinking...";
  messagesCont.appendChild(typingMsg);

  try {
    const context = document.getElementById('ai-context').value;
    const activeModel = document.getElementById('model-select').value;
    const response = await callBackend('testAiConnection', { 
      selectedModel: activeModel,
      prompt: `User says: ${text}\n\nContext from notes: ${context}\n\nReply as a helpful nursing tutor.`
    });
    
    typingMsg.remove();
    const aiMsg = document.createElement('div');
    aiMsg.style = "background: rgba(255,255,255,0.05); padding: 0.8rem 1rem; border-radius: 15px 15px 15px 0; align-self: flex-start; max-width: 80%; font-size: 0.9rem;";
    aiMsg.textContent = response.replace(/^Success: /, '');
    messagesCont.appendChild(aiMsg);
  } catch (err) {
    typingMsg.textContent = "Error: " + err.message;
  }
  
  messagesCont.scrollTop = messagesCont.scrollHeight;
}

/**
 * NEW: Performance Charting
 */
function initPerformanceChart() {
  const ctx = document.getElementById('performanceChart');
  if (!ctx || performanceChart) return;

  performanceChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Score %',
        data: [],
        borderColor: '#ff9e00',
        backgroundColor: 'rgba(255, 158, 0, 0.1)',
        tension: 0.4,
        fill: true,
        pointRadius: 4,
        pointBackgroundColor: '#fff'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: { 
          beginAtZero: true, 
          max: 100,
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: 'rgba(255,255,255,0.3)', font: { size: 10 } }
        }
      }
    }
  });
}

function updateChartData() {
  if (!performanceChart) initPerformanceChart();
  if (!performanceChart) return;

  const history = JSON.parse(localStorage.getItem('studyHistory') || '[]');
  const scores = history.slice(-10).map(h => (h.score / h.total) * 100);
  const labels = history.slice(-10).map(h => h.date);

  performanceChart.data.labels = labels;
  performanceChart.data.datasets[0].data = scores;
  performanceChart.update();
}

/**
 * MASTER: PDF Text Extraction
 */
async function handlePDFUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  showLoading("Reading PDF content...");
  
  try {
    const reader = new FileReader();
    reader.onload = async function() {
      const typedarray = new Uint8Array(this.result);
      const pdf = await pdfjsLib.getDocument(typedarray).promise;
      let fullText = "";

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        fullText += textContent.items.map(item => item.str).join(" ") + "\n";
      }

      document.getElementById('ai-context').value = fullText.trim();
      document.getElementById('ai-title').value = file.name.replace('.pdf', '');
      hideLoading();
    };
    reader.readAsArrayBuffer(file);
  } catch (err) {
    console.error(err);
    alert("Error reading PDF. Make sure it's not password protected.");
    hideLoading();
  }
}

/**
 * MASTER: Spaced Repetition (SRS)
 */
function updateSRS() {
  const container = document.getElementById('srs-container');
  if (!container) return;

  const history = JSON.parse(localStorage.getItem('babisStudyHistory') || '[]');
  const now = Date.now();
  const threeDays = 3 * 24 * 60 * 60 * 1000;
  
  // Find quizzes where score < 80% and last taken > 3 days ago
  const due = history.filter(record => {
    const isDue = (now - record.timestamp) > threeDays;
    const isLow = (record.score / record.total) < 0.8;
    return isDue && isLow;
  }).slice(0, 3); // Top 3 suggestions

  if (due.length === 0) {
    container.innerHTML = '<div style="opacity:0.4; font-size:0.8rem; text-align:center; padding:1rem;">Your memory is fresh! Nothing due.</div>';
    return;
  }

  container.innerHTML = due.map(record => `
    <div class="score-row animate-fade" style="background: rgba(255,255,255,0.03); padding: 0.8rem; border-radius: 12px; display: flex; justify-content: space-between; align-items: center; border: 1px solid rgba(255,255,255,0.05);">
      <div style="flex: 1;">
        <div style="font-size: 0.85rem; font-weight: 600;">${record.title}</div>
        <div style="font-size: 0.7rem; color: var(--accent-pink);">Score: ${Math.round((record.score / record.total) * 100)}%</div>
      </div>
      <button class="btn-secondary" style="font-size: 0.7rem; padding: 0.3rem 0.6rem;" onclick="switchView('library')">Review</button>
    </div>
  `).join('');
}

// Initial Call to load SRS
window.addEventListener('DOMContentLoaded', () => {
  switchView('dashboard');
  checkSavedData();
  updateSRS(); // Initial SRS check
  setTimeout(updateChartData, 1000);
});

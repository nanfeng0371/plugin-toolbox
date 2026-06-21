(() => {
  var __defProp = Object.defineProperty;
  var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

  // web/assets/js/router.js
  var routes = {};
  var currentPath = "";
  function registerRoute(path, renderFn) {
    routes[path] = renderFn;
  }
  __name(registerRoute, "registerRoute");
  function initRouter() {
    window.addEventListener("hashchange", handleRoute);
    handleRoute();
  }
  __name(initRouter, "initRouter");
  function navigate(path) {
    window.location.hash = "#" + path;
  }
  __name(navigate, "navigate");
  function handleRoute() {
    const hash = window.location.hash || "#/login";
    const path = hash.replace("#", "");
    currentPath = path;
    const renderFn = routes[path];
    if (renderFn) {
      renderFn();
    } else {
      navigate("/login");
    }
  }
  __name(handleRoute, "handleRoute");

  // web/assets/js/config.js
  var API_BASE = "https://renewal-calendar-7ff2rtj4f876144-1259283480.ap-shanghai.app.tcloudbase.com/tk-api";
  var AI_GENESIS_URL = "https://ai-genesis.yuaiweiwu.com";
  var EF_TOKEN_KEY = "tk_ef_token";
  var EF_USER_KEY = "tk_ef_user";
  var JWT_PATTERN = /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

  // web/assets/js/api.js
  async function post(action, data = {}) {
    const token = localStorage.getItem(EF_TOKEN_KEY);
    let userId = "";
    try {
      const userStr = localStorage.getItem(EF_USER_KEY);
      if (userStr) {
        const user = JSON.parse(userStr);
        userId = user._id || user.userId || user.sub || "";
      }
    } catch (e) {
    }
    const body = {
      action,
      data: {
        ...data,
        ...token ? { _token: token } : {},
        ...userId ? { _userId: userId } : {}
      }
    };
    try {
      const res = await fetch(API_BASE, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      const result = await res.json();
      if (result.code === 401) {
        localStorage.removeItem(EF_TOKEN_KEY);
        localStorage.removeItem(EF_USER_KEY);
        window.dispatchEvent(new CustomEvent("tk:unauthorized"));
      }
      return result;
    } catch (err) {
      return {
        code: 500,
        message: "\u7F51\u7EDC\u9519\u8BEF\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u8FDE\u63A5",
        data: null
      };
    }
  }
  __name(post, "post");

  // web/assets/js/auth.js
  async function saveTiaokeToken(token) {
    if (!token || !JWT_PATTERN.test(token)) {
      return { success: false, message: "Token \u683C\u5F0F\u4E0D\u6B63\u786E" };
    }
    const result = await post("tiaokeToken.save", { token });
    if (result.code === 0 && result.data) {
      localStorage.setItem(EF_TOKEN_KEY, "tiaoke_active");
      if (result.data.user) {
        localStorage.setItem(EF_USER_KEY, JSON.stringify(result.data.user));
      } else {
        const payload = decodeJwtPayload(token);
        const userInfo = {
          _id: (payload == null ? void 0 : payload.sub) || (payload == null ? void 0 : payload.user_id) || (payload == null ? void 0 : payload.uid) || "unknown",
          userId: (payload == null ? void 0 : payload.sub) || (payload == null ? void 0 : payload.user_id) || (payload == null ? void 0 : payload.uid) || "unknown",
          name: (payload == null ? void 0 : payload.name) || (payload == null ? void 0 : payload.preferred_username) || (payload == null ? void 0 : payload.sub) || "\u8F85\u5BFC\u5458",
          role: "counselor"
        };
        localStorage.setItem(EF_USER_KEY, JSON.stringify(userInfo));
      }
      return { success: true, user: JSON.parse(localStorage.getItem(EF_USER_KEY)) };
    }
    return { success: false, message: result.message || "Token \u9A8C\u8BC1\u5931\u8D25" };
  }
  __name(saveTiaokeToken, "saveTiaokeToken");
  function logout() {
    localStorage.removeItem(EF_TOKEN_KEY);
    localStorage.removeItem(EF_USER_KEY);
  }
  __name(logout, "logout");
  function getCurrentUser() {
    try {
      const userStr = localStorage.getItem(EF_USER_KEY);
      return userStr ? JSON.parse(userStr) : null;
    } catch {
      return null;
    }
  }
  __name(getCurrentUser, "getCurrentUser");
  function isLoggedIn() {
    return !!localStorage.getItem(EF_TOKEN_KEY);
  }
  __name(isLoggedIn, "isLoggedIn");
  function decodeJwtPayload(token) {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      let payload = parts[1];
      payload = payload.replace(/-/g, "+").replace(/_/g, "/");
      while (payload.length % 4) payload += "=";
      return JSON.parse(atob(payload));
    } catch (e) {
      return null;
    }
  }
  __name(decodeJwtPayload, "decodeJwtPayload");

  // web/assets/js/pages/login.js
  registerRoute("/login", renderLogin);
  function renderLogin() {
    const root = document.getElementById("app-root");
    if (!root) return;
    root.innerHTML = `
    <div class="login-page">
      <div class="login-card">
        <div class="login-header">
          <div class="login-icon">\u{1F3AF}</div>
          <h1 class="login-title">\u8C03\u8BFE\u52A9\u624B</h1>
          <p class="login-subtitle">\u7C98\u8D34 Token \u5373\u53EF\u4F7F\u7528</p>
        </div>
        <form id="loginForm" class="login-form">
          <div class="form-group">
            <label class="form-label">\u7C98\u8D34\u8C03\u8BFE Token</label>
            <textarea id="tokenInput" class="form-input form-textarea"
              placeholder="eyJhbGciOi..."
              rows="3"
              autocomplete="off"></textarea>
            <div class="form-hint">\u4ECE\u7535\u8111\u7AEF\u8C03\u8BFE\u52A9\u624B\u6269\u5C55\u590D\u5236 Token\uFF0C\u7C98\u8D34\u5230\u8FD9\u91CC</div>
          </div>
          <div id="loginError" class="form-error" style="display:none"></div>
          <button type="submit" id="loginBtn" class="btn btn-primary btn-block">\u9A8C\u8BC1\u5E76\u767B\u5F55</button>
        </form>

        <div class="login-help">
          <p><b>\u83B7\u53D6 Token \u6B65\u9AA4\uFF1A</b></p>
          <ol>
            <li>\u5728<b>\u7535\u8111</b>\u4E0A\u767B\u5F55\u8C03\u8BFE\u540E\u53F0\uFF08ai-genesis\uFF09</li>
            <li>\u6253\u5F00\u8C03\u8BFE\u52A9\u624B\u6269\u5C55\uFF0C\u70B9\u51FB\u300C\u590D\u5236 Token\u300D</li>
            <li>\u901A\u8FC7\u4F01\u5FAE/\u5FAE\u4FE1\u628A Token \u53D1\u7ED9\u81EA\u5DF1</li>
            <li>\u5728\u624B\u673A\u4E0A\u590D\u5236 Token\uFF0C\u7C98\u8D34\u5230\u4E0A\u65B9\u8F93\u5165\u6846</li>
          </ol>
          <p class="login-help-note">Token \u6709\u6548\u671F 24 \u5C0F\u65F6\uFF0C\u6BCF\u5929\u64CD\u4F5C\u4E00\u6B21\u5373\u53EF</p>
        </div>
      </div>
    </div>
  `;
    const form = document.getElementById("loginForm");
    form.addEventListener("submit", handleLogin);
    const tokenInput = document.getElementById("tokenInput");
    tokenInput.addEventListener("input", () => {
      const val = tokenInput.value.trim();
      if (JWT_PATTERN.test(val)) {
        tokenInput.classList.add("input-valid");
      } else {
        tokenInput.classList.remove("input-valid");
      }
    });
    tokenInput.addEventListener("paste", () => {
      setTimeout(() => {
        const val = tokenInput.value.trim();
        if (JWT_PATTERN.test(val)) {
          handleLogin(new Event("submit", { cancelable: true }));
        }
      }, 100);
    });
    tryAutoFillFromClipboard();
  }
  __name(renderLogin, "renderLogin");
  async function tryAutoFillFromClipboard() {
    const tokenInput = document.getElementById("tokenInput");
    if (!tokenInput) return;
    try {
      const text = await navigator.clipboard.readText();
      const trimmed = text.trim();
      if (JWT_PATTERN.test(trimmed)) {
        tokenInput.value = trimmed;
        tokenInput.classList.add("input-valid");
        handleLogin(new Event("submit", { cancelable: true }));
      }
    } catch (e) {
    }
  }
  __name(tryAutoFillFromClipboard, "tryAutoFillFromClipboard");
  async function handleLogin(e) {
    e.preventDefault();
    const tokenInput = document.getElementById("tokenInput");
    const errorEl = document.getElementById("loginError");
    const btn = document.getElementById("loginBtn");
    if (!tokenInput) return;
    const token = tokenInput.value.trim();
    if (!token) {
      errorEl.textContent = "\u8BF7\u5148\u7C98\u8D34 Token";
      errorEl.style.display = "block";
      return;
    }
    if (!JWT_PATTERN.test(token)) {
      errorEl.textContent = "Token \u683C\u5F0F\u4E0D\u6B63\u786E\uFF0C\u5E94\u4EE5 eyJ \u5F00\u5934";
      errorEl.style.display = "block";
      return;
    }
    btn.disabled = true;
    btn.textContent = "\u9A8C\u8BC1\u4E2D...";
    errorEl.style.display = "none";
    const result = await saveTiaokeToken(token);
    if (result.success) {
      navigate("/main");
    } else {
      errorEl.textContent = result.message || "Token \u9A8C\u8BC1\u5931\u8D25";
      errorEl.style.display = "block";
      btn.disabled = false;
      btn.textContent = "\u9A8C\u8BC1\u5E76\u767B\u5F55";
    }
  }
  __name(handleLogin, "handleLogin");

  // web/assets/js/pages/tab-tiaoKe.js
  function renderTiaoKeTab(container, tokenStatus2) {
    const canOperate = tokenStatus2 && tokenStatus2.status === "valid";
    container.innerHTML = `
    <div class="tiaoKe-tab">
      ${!canOperate ? renderTokenGuide() : ""}

      <div class="section">
        <label class="section-label">\u8F93\u5165\u8C03\u8BFE\u6307\u4EE4</label>
        <textarea id="tiaoKeInput" class="form-textarea" rows="6"
          placeholder="\u652F\u6301\u4EE5\u4E0B\u683C\u5F0F\uFF1A&#10;&#10;\u683C\u5F0F1\uFF08\u6BCF\u884C\u4E00\u6761\uFF09\uFF1A&#10;\u738B\u4E00  5  5\u67082\u65E5  10:00&#10;12345  3  5-3  14:00&#10;&#10;\u683C\u5F0F2\uFF08\u81EA\u7136\u8BED\u8A00\uFF09\uFF1A&#10;\u738B\u4E00\uFF0C\u7B2C5\u8BB2\uFF0C\u8C03\u52305\u67082\u65E510\u70B9&#10;\u628A\u674E\u4E8C\u7684\u7B2C3\u8BB2\u6539\u52305\u67083\u65E5\u4E0B\u53482\u70B9"
          ${!canOperate ? "disabled" : ""}></textarea>
        <div class="btn-row">
          <button id="parseBtn" class="btn btn-secondary" ${!canOperate ? "disabled" : ""}>\u{1F4CB} \u89E3\u6790\u9884\u89C8</button>
          <button id="executeBtn" class="btn btn-primary" ${!canOperate ? "disabled" : ""}>\u25B6 \u6267\u884C\u8C03\u8BFE</button>
        </div>
      </div>

      <div id="parseResult" class="section" style="display:none">
        <label class="section-label">\u89E3\u6790\u7ED3\u679C</label>
        <div id="parseResultContent"></div>
      </div>

      <div id="executeProgress" class="section" style="display:none">
        <label class="section-label">\u6267\u884C\u8FDB\u5EA6</label>
        <div id="executeProgressContent"></div>
      </div>
    </div>
  `;
    const parseBtn = document.getElementById("parseBtn");
    const executeBtn = document.getElementById("executeBtn");
    if (parseBtn) parseBtn.addEventListener("click", handleParse);
    if (executeBtn) executeBtn.addEventListener("click", handleExecute);
  }
  __name(renderTiaoKeTab, "renderTiaoKeTab");
  function renderTokenGuide() {
    return `
    <div class="token-guide">
      <p class="guide-title">\u26A0\uFE0F \u8C03\u8BFE Token \u672A\u8BBE\u7F6E\uFF0C\u65E0\u6CD5\u6267\u884C\u8C03\u8BFE\u64CD\u4F5C</p>
      <p class="guide-steps">
        \u8BF7\u6309\u4EE5\u4E0B\u6B65\u9AA4\u64CD\u4F5C\uFF1A<br>
        1. \u70B9\u51FB\u300C\u8BBE\u7F6E\u300D\u6807\u7B7E\u9875<br>
        2. \u70B9\u51FB\u300C\u83B7\u53D6 Token\u300D\u6309\u94AE<br>
        3. \u5728\u65B0\u9875\u9762\u4E2D\u767B\u5F55\u8C03\u8BFE\u540E\u53F0\uFF08\u4F01\u5FAE\u4F1A\u81EA\u52A8\u767B\u5F55\uFF09<br>
        4. \u590D\u5236\u9875\u9762\u4E2D\u7684 Token<br>
        5. \u5207\u56DE\u672C\u9875\u9762\uFF0CToken \u4F1A\u81EA\u52A8\u586B\u5165<br>
        6. \u70B9\u51FB\u300C\u786E\u8BA4\u4FDD\u5B58\u300D\u5373\u53EF
      </p>
    </div>
  `;
  }
  __name(renderTokenGuide, "renderTokenGuide");
  async function handleParse() {
    const input = document.getElementById("tiaoKeInput").value.trim();
    if (!input) return;
    const parseBtn = document.getElementById("parseBtn");
    parseBtn.disabled = true;
    parseBtn.textContent = "\u89E3\u6790\u4E2D...";
    const result = await post("reschedule.parse", { input });
    parseBtn.disabled = false;
    parseBtn.textContent = "\u{1F4CB} \u89E3\u6790\u9884\u89C8";
    const resultSection = document.getElementById("parseResult");
    const resultContent = document.getElementById("parseResultContent");
    resultSection.style.display = "block";
    if (result.code !== 0) {
      resultContent.innerHTML = `<div class="result-error">${result.message}</div>`;
      return;
    }
    const data = result.data;
    let html = `<div class="parse-summary">\u5171 ${data.total} \u6761\uFF1A\u2705 ${data.success} \u6761\u6210\u529F\uFF0C\u274C ${data.failed} \u6761\u5931\u8D25</div>`;
    html += '<div class="parse-list">';
    for (const task of data.tasks) {
      const cls = task.status === "ok" ? "parse-item-ok" : "parse-item-err";
      const icon = task.status === "ok" ? "\u2705" : "\u274C";
      html += `<div class="parse-item ${cls}">
      ${icon} ${task.studentIdentifier || task.studentId || "?"} \u2192 \u7B2C${task.lesson || "?"}\u8BB2 \u2192 ${task.newDate || "?"} ${task.newTime || "?"}
      ${task.error ? `<span class="parse-error">${task.error}</span>` : ""}
    </div>`;
    }
    html += "</div>";
    resultContent.innerHTML = html;
    window._tkParsedTasks = data.tasks.filter((t) => t.status === "ok");
  }
  __name(handleParse, "handleParse");
  async function handleExecute() {
    const tasks = window._tkParsedTasks;
    if (!tasks || tasks.length === 0) {
      alert("\u8BF7\u5148\u89E3\u6790\u8C03\u8BFE\u6307\u4EE4");
      return;
    }
    const executeBtn = document.getElementById("executeBtn");
    executeBtn.disabled = true;
    executeBtn.textContent = "\u6267\u884C\u4E2D...";
    const progressSection = document.getElementById("executeProgress");
    const progressContent = document.getElementById("executeProgressContent");
    progressSection.style.display = "block";
    progressContent.innerHTML = '<div class="progress-loading">\u6B63\u5728\u6267\u884C\u8C03\u8BFE\uFF0C\u8BF7\u7A0D\u5019...</div>';
    const result = await post("reschedule.batch", { tasks });
    executeBtn.disabled = false;
    executeBtn.textContent = "\u25B6 \u6267\u884C\u8C03\u8BFE";
    if (result.code !== 0) {
      progressContent.innerHTML = `<div class="result-error">${result.message}</div>`;
      return;
    }
    const data = result.data;
    let html = `<div class="execute-summary">
    \u5171 ${data.total} \u6761\uFF1A\u2705 ${data.success} \u6761\u6210\u529F\uFF0C\u274C ${data.failed} \u6761\u5931\u8D25
  </div>`;
    html += '<div class="execute-list">';
    for (const r of data.results) {
      const cls = r.success ? "execute-item-ok" : "execute-item-err";
      const icon = r.success ? "\u2705" : "\u274C";
      html += `<div class="execute-item ${cls}">
      ${icon} ${r.studentName || r.studentId} \u7B2C${r.lesson}\u8BB2 \u2192 ${r.newDate} ${r.newTime}
      ${!r.success ? `<span class="execute-error">${r.message}</span>` : ""}
    </div>`;
    }
    html += "</div>";
    progressContent.innerHTML = html;
  }
  __name(handleExecute, "handleExecute");

  // web/assets/js/pages/tab-history.js
  function renderHistoryTab(container) {
    container.innerHTML = `
    <div class="history-tab">
      <div class="section">
        <div class="search-row">
          <input type="text" id="historySearch" class="form-input" placeholder="\u641C\u7D22\u5B66\u5458\u59D3\u540D/ID">
          <button id="historySearchBtn" class="btn btn-secondary">\u641C\u7D22</button>
        </div>
      </div>
      <div id="historyList" class="section">
        <div class="loading">\u52A0\u8F7D\u4E2D...</div>
      </div>
    </div>
  `;
    loadHistory();
    document.getElementById("historySearchBtn").addEventListener("click", handleSearch);
    document.getElementById("historySearch").addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleSearch();
    });
  }
  __name(renderHistoryTab, "renderHistoryTab");
  async function loadHistory(page = 1) {
    const listEl = document.getElementById("historyList");
    if (!listEl) return;
    const result = await post("log.list", { page, pageSize: 50 });
    if (result.code !== 0 || !result.data) {
      listEl.innerHTML = `<div class="empty">\u6682\u65E0\u8C03\u8BFE\u8BB0\u5F55</div>`;
      return;
    }
    const { grouped, total } = result.data;
    if (!grouped || Object.keys(grouped).length === 0) {
      listEl.innerHTML = `<div class="empty">\u6682\u65E0\u8C03\u8BFE\u8BB0\u5F55</div>`;
      return;
    }
    let html = `<div class="history-total">\u5171 ${total} \u6761\u8BB0\u5F55</div>`;
    for (const [date, logs] of Object.entries(grouped)) {
      html += `<div class="history-group">
      <div class="history-date">${date}</div>`;
      for (const log of logs) {
        const icon = log.success ? "\u2705" : "\u274C";
        html += `<div class="history-item">
        ${icon} ${log.studentName || log.studentId} \u7B2C${log.lesson}\u8BB2 \u2192 ${log.newDate} ${log.newTime}
        <span class="history-time">${log.message || ""}</span>
      </div>`;
      }
      html += "</div>";
    }
    listEl.innerHTML = html;
  }
  __name(loadHistory, "loadHistory");
  async function handleSearch() {
    const keyword = document.getElementById("historySearch").value.trim();
    if (!keyword) {
      loadHistory();
      return;
    }
    const listEl = document.getElementById("historyList");
    listEl.innerHTML = '<div class="loading">\u641C\u7D22\u4E2D...</div>';
    const result = await post("log.search", { keyword });
    if (result.code !== 0 || !result.data) {
      listEl.innerHTML = `<div class="empty">\u672A\u627E\u5230\u76F8\u5173\u8BB0\u5F55</div>`;
      return;
    }
    const { list, total } = result.data;
    if (!list || list.length === 0) {
      listEl.innerHTML = `<div class="empty">\u672A\u627E\u5230"${keyword}"\u7684\u8C03\u8BFE\u8BB0\u5F55</div>`;
      return;
    }
    let html = `<div class="history-total">\u627E\u5230 ${total} \u6761\u8BB0\u5F55</div>`;
    html += '<div class="history-group">';
    for (const log of list) {
      const icon = log.success ? "\u2705" : "\u274C";
      html += `<div class="history-item">
      ${icon} ${log.studentName || log.studentId} \u7B2C${log.lesson}\u8BB2 \u2192 ${log.newDate} ${log.newTime}
      <span class="history-time">${log.message || ""}</span>
    </div>`;
    }
    html += "</div>";
    listEl.innerHTML = html;
  }
  __name(handleSearch, "handleSearch");

  // web/assets/js/pages/tab-settings.js
  function renderSettingsTab(container, tokenStatus2) {
    const isValid = tokenStatus2 && tokenStatus2.status === "valid";
    container.innerHTML = `
    <div class="settings-tab">
      <!-- Token \u533A\u57DF -->
      <div class="section">
        <label class="section-label">\u{1F511} \u8C03\u8BFE Token</label>
        <div class="token-status-card ${isValid ? "card-valid" : "card-invalid"}">
          <div class="token-status-text">
            ${renderTokenStatusText(tokenStatus2)}
          </div>
        </div>

        ${!isValid ? renderTokenGuide2() : ""}

        <div class="token-actions">
          <a href="${AI_GENESIS_URL}" target="_blank" class="btn btn-secondary btn-block">
            \u{1F4F1} \u6253\u5F00\u8C03\u8BFE\u540E\u53F0\uFF08\u5982\u9700\u91CD\u65B0\u767B\u5F55\uFF09
          </a>
        </div>

        <div class="token-paste-section">
          <label class="form-label">\u7C98\u8D34 Token</label>
          <div class="paste-row">
            <input type="text" id="tokenInput" class="form-input"
              placeholder="eyJ..."
              autocomplete="off">
            <button id="pasteTokenBtn" class="btn btn-secondary">\u{1F4CB} \u7C98\u8D34</button>
          </div>
          <button id="saveTokenBtn" class="btn btn-primary btn-block" style="margin-top:8px">
            \u2705 \u9A8C\u8BC1\u5E76\u4FDD\u5B58
          </button>
          <div id="tokenError" class="form-error" style="display:none"></div>
        </div>
      </div>

      <!-- \u5B66\u60C5\u8868\u533A\u57DF -->
      <div class="section">
        <label class="section-label">\u{1F4CB} \u5B66\u60C5\u8868\uFF08\u5B66\u5458\u4FE1\u606F\u7C3F\uFF09</label>
        <div id="rosterStatus" class="roster-status">\u672A\u52A0\u8F7D</div>
        <div class="roster-actions">
          <button id="importRosterBtn" class="btn btn-secondary btn-block">\u{1F4E5} \u5BFC\u5165 Excel \u5B66\u60C5\u8868</button>
          <input type="file" id="rosterFile" accept=".xlsx,.xls,.csv" style="display:none">
          <button id="clearRosterBtn" class="btn btn-text btn-block" style="display:none">\u{1F5D1}\uFE0F \u6E05\u9664\u5B66\u60C5\u8868</button>
        </div>
        <div id="rosterDetail" class="roster-detail" style="display:none"></div>
      </div>

      <!-- \u64CD\u4F5C\u63D0\u793A -->
      <div class="section">
        <label class="section-label">\u{1F4A1} \u64CD\u4F5C\u8BF4\u660E</label>
        <div class="help-content">
          <p><b>Token \u83B7\u53D6\u6B65\u9AA4\uFF1A</b></p>
          <ol>
            <li>\u5728<b>\u7535\u8111</b>\u4E0A\u767B\u5F55\u8C03\u8BFE\u540E\u53F0\uFF08ai-genesis\uFF09</li>
            <li>\u6253\u5F00\u8C03\u8BFE\u52A9\u624B\u6269\u5C55\uFF0C\u70B9\u51FB\u300C\u590D\u5236 Token\u300D</li>
            <li>\u901A\u8FC7\u4F01\u5FAE/\u5FAE\u4FE1\u628A Token \u53D1\u7ED9\u81EA\u5DF1</li>
            <li>\u5728\u624B\u673A\u4E0A\u590D\u5236 Token\uFF0C\u7C98\u8D34\u5230\u4E0A\u65B9\u8F93\u5165\u6846</li>
            <li>\u70B9\u51FB\u300C\u9A8C\u8BC1\u5E76\u4FDD\u5B58\u300D\u5373\u53EF</li>
          </ol>
          <p>Token \u6709\u6548\u671F 24 \u5C0F\u65F6\uFF0C\u6BCF\u5929\u64CD\u4F5C\u4E00\u6B21\u5373\u53EF\u3002</p>
        </div>
      </div>
    </div>
  `;
    bindTokenEvents();
    bindRosterEvents();
    startClipboardWatch();
  }
  __name(renderSettingsTab, "renderSettingsTab");
  function renderTokenStatusText(status) {
    if (!status || status.status === "not_set") {
      return "\u274C \u672A\u8BBE\u7F6E";
    }
    switch (status.status) {
      case "valid":
        return `\u2705 ${status.message || "Token \u6709\u6548"}`;
      case "expiring":
        return `\u26A0\uFE0F ${status.message || "Token \u5373\u5C06\u8FC7\u671F"}`;
      case "expired":
        return "\u274C Token \u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u83B7\u53D6";
      default:
        return "\u2753 \u672A\u77E5\u72B6\u6001";
    }
  }
  __name(renderTokenStatusText, "renderTokenStatusText");
  function renderTokenGuide2() {
    return `
    <div class="token-guide-inline">
      <p>\u26A0\uFE0F Token \u672A\u8BBE\u7F6E\uFF0C\u65E0\u6CD5\u6267\u884C\u8C03\u8BFE\u64CD\u4F5C\u3002\u8BF7\u6309\u4E0A\u65B9\u6B65\u9AA4\u83B7\u53D6\u5E76\u7C98\u8D34 Token\u3002</p>
    </div>
  `;
  }
  __name(renderTokenGuide2, "renderTokenGuide");
  function bindTokenEvents() {
    const pasteBtn = document.getElementById("pasteTokenBtn");
    if (pasteBtn) {
      pasteBtn.addEventListener("click", async () => {
        try {
          const text = await navigator.clipboard.readText();
          const tokenInput2 = document.getElementById("tokenInput");
          if (tokenInput2 && text) {
            tokenInput2.value = text.trim();
            tryAutoSave(text.trim());
          }
        } catch (e) {
          const tokenInput2 = document.getElementById("tokenInput");
          if (tokenInput2) tokenInput2.focus();
        }
      });
    }
    const saveBtn = document.getElementById("saveTokenBtn");
    if (saveBtn) {
      saveBtn.addEventListener("click", handleSaveToken);
    }
    const tokenInput = document.getElementById("tokenInput");
    if (tokenInput) {
      tokenInput.addEventListener("input", () => {
        const val = tokenInput.value.trim();
        if (JWT_PATTERN.test(val)) {
          tokenInput.classList.add("input-valid");
        } else {
          tokenInput.classList.remove("input-valid");
        }
      });
    }
  }
  __name(bindTokenEvents, "bindTokenEvents");
  async function handleSaveToken() {
    const tokenInput = document.getElementById("tokenInput");
    const errorEl = document.getElementById("tokenError");
    const saveBtn = document.getElementById("saveTokenBtn");
    if (!tokenInput) return;
    const token = tokenInput.value.trim();
    if (!token) {
      showError(errorEl, "\u8BF7\u5148\u7C98\u8D34 Token");
      return;
    }
    if (!JWT_PATTERN.test(token)) {
      showError(errorEl, "Token \u683C\u5F0F\u4E0D\u6B63\u786E\uFF0C\u5E94\u4EE5 eyJ \u5F00\u5934\uFF0C\u4E09\u6BB5\u5F0F\u683C\u5F0F");
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "\u9A8C\u8BC1\u4E2D...";
    hideError(errorEl);
    const result = await post("tiaokeToken.save", { token });
    saveBtn.disabled = false;
    saveBtn.textContent = "\u2705 \u9A8C\u8BC1\u5E76\u4FDD\u5B58";
    if (result.code === 0) {
      tokenInput.value = "";
      tokenInput.classList.remove("input-valid");
      const newStatus = await refreshTokenStatus();
      const content = document.getElementById("tabContent");
      if (content) {
        renderSettingsTab(content, newStatus);
      }
    } else {
      showError(errorEl, result.message || "Token \u9A8C\u8BC1\u5931\u8D25");
    }
  }
  __name(handleSaveToken, "handleSaveToken");
  function tryAutoSave(text) {
    if (JWT_PATTERN.test(text)) {
      handleSaveToken();
    }
  }
  __name(tryAutoSave, "tryAutoSave");
  function startClipboardWatch() {
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState === "visible") {
        const tokenInput = document.getElementById("tokenInput");
        if (!tokenInput) return;
        if (!tokenInput.value.trim()) {
          try {
            const text = await navigator.clipboard.readText();
            const trimmed = text.trim();
            if (JWT_PATTERN.test(trimmed)) {
              tokenInput.value = trimmed;
              tokenInput.classList.add("input-valid");
              handleSaveToken();
            }
          } catch (e) {
          }
        }
      }
    });
  }
  __name(startClipboardWatch, "startClipboardWatch");
  function bindRosterEvents() {
    const importBtn = document.getElementById("importRosterBtn");
    const rosterFile = document.getElementById("rosterFile");
    const clearBtn = document.getElementById("clearRosterBtn");
    if (importBtn && rosterFile) {
      importBtn.addEventListener("click", () => rosterFile.click());
      rosterFile.addEventListener("change", handleRosterFile);
    }
    if (clearBtn) {
      clearBtn.addEventListener("click", handleClearRoster);
    }
    loadRosterStatus();
  }
  __name(bindRosterEvents, "bindRosterEvents");
  async function loadRosterStatus() {
    const result = await post("student.getRoster");
    const statusEl = document.getElementById("rosterStatus");
    const detailEl = document.getElementById("rosterDetail");
    const clearBtn = document.getElementById("clearRosterBtn");
    if (result.code === 0 && result.data && result.data.count > 0) {
      if (statusEl) {
        statusEl.textContent = `\u5DF2\u52A0\u8F7D: ${result.data.count} \u540D\u5B66\u5458`;
        statusEl.className = "roster-status roster-loaded";
      }
      if (detailEl) {
        detailEl.style.display = "block";
        detailEl.textContent = `\u4E0A\u6B21\u5BFC\u5165: ${result.data.updatedAt || "\u672A\u77E5"}`;
      }
      if (clearBtn) clearBtn.style.display = "block";
    }
  }
  __name(loadRosterStatus, "loadRosterStatus");
  async function handleRosterFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";
    const statusEl = document.getElementById("rosterStatus");
    if (statusEl) {
      statusEl.textContent = "\u6B63\u5728\u89E3\u6790...";
      statusEl.className = "roster-status roster-loading";
    }
    try {
      const students = await parseExcelFile(file);
      if (students.length === 0) {
        if (statusEl) {
          statusEl.textContent = "Excel \u4E3A\u7A7A\u6216\u683C\u5F0F\u4E0D\u6B63\u786E";
          statusEl.className = "roster-status roster-empty";
        }
        return;
      }
      const result = await post("student.importRoster", { students });
      if (result.code === 0) {
        if (statusEl) {
          statusEl.textContent = `\u5DF2\u52A0\u8F7D: ${students.length} \u540D\u5B66\u5458`;
          statusEl.className = "roster-status roster-loaded";
        }
        const clearBtn = document.getElementById("clearRosterBtn");
        if (clearBtn) clearBtn.style.display = "block";
      } else {
        if (statusEl) {
          statusEl.textContent = "\u5BFC\u5165\u5931\u8D25: " + (result.message || "\u672A\u77E5\u9519\u8BEF");
          statusEl.className = "roster-status roster-empty";
        }
      }
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = "Excel \u89E3\u6790\u5931\u8D25: " + err.message;
        statusEl.className = "roster-status roster-empty";
      }
    }
  }
  __name(handleRosterFile, "handleRosterFile");
  async function parseExcelFile(file) {
    if (typeof XLSX === "undefined") {
      await loadScript("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js");
    }
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data, { type: "array" });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
    if (rows.length === 0) return [];
    const sample = rows[0];
    const keys = Object.keys(sample);
    const nameKey = keys.find((k) => /^(name|姓名|学生姓名|学员姓名)$/i.test(k.trim())) || keys[0];
    const phoneKey = keys.find((k) => /^(phone|手机|手机号|联系电话|电话)$/i.test(k.trim())) || keys[1];
    const idKey = keys.find((k) => /^(studentId|学员ID|学员id|student_id|id)$/i.test(k.trim())) || keys[2];
    const students = [];
    for (const row of rows) {
      const name = String(row[nameKey] || "").trim();
      const phone = String(row[phoneKey] || "").trim();
      const studentId = String(row[idKey] || "").trim();
      if (!studentId || !/^\d+$/.test(studentId)) continue;
      students.push({ name, phone, studentId });
    }
    return students;
  }
  __name(parseExcelFile, "parseExcelFile");
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }
  __name(loadScript, "loadScript");
  async function handleClearRoster() {
    if (!confirm("\u786E\u5B9A\u6E05\u9664\u5B66\u60C5\u8868\uFF1F")) return;
    const result = await post("student.clearRoster");
    const statusEl = document.getElementById("rosterStatus");
    const detailEl = document.getElementById("rosterDetail");
    const clearBtn = document.getElementById("clearRosterBtn");
    if (result.code === 0) {
      if (statusEl) {
        statusEl.textContent = "\u672A\u52A0\u8F7D";
        statusEl.className = "roster-status roster-empty";
      }
      if (detailEl) detailEl.style.display = "none";
      if (clearBtn) clearBtn.style.display = "none";
    }
  }
  __name(handleClearRoster, "handleClearRoster");
  function showError(el, msg) {
    if (el) {
      el.textContent = msg;
      el.style.display = "block";
    }
  }
  __name(showError, "showError");
  function hideError(el) {
    if (el) el.style.display = "none";
  }
  __name(hideError, "hideError");

  // web/assets/js/pages/main.js
  registerRoute("/main", renderMain);
  var activeTab = "tiaoKe";
  var tokenStatus = null;
  async function renderMain() {
    const root = document.getElementById("app-root");
    if (!root) return;
    const user = getCurrentUser();
    if (!user) {
      navigate("/login");
      return;
    }
    const statusResult = await post("tiaokeToken.get");
    tokenStatus = statusResult.code === 0 ? statusResult.data : { status: "not_set" };
    root.innerHTML = `
    <div class="main-page">
      <header class="main-header">
        <div class="header-left">
          <span class="header-title">\u{1F3AF} \u8C03\u8BFE\u52A9\u624B</span>
        </div>
        <div class="header-right">
          <button id="logoutBtn" class="btn btn-text">\u9000\u51FA</button>
        </div>
      </header>

      <div class="token-bar" id="tokenBar">
        ${renderTokenBar(tokenStatus)}
      </div>

      <nav class="tab-nav">
        <button class="tab-btn ${activeTab === "tiaoKe" ? "active" : ""}" data-tab="tiaoKe">\u8C03\u8BFE</button>
        <button class="tab-btn ${activeTab === "history" ? "active" : ""}" data-tab="history">\u5386\u53F2</button>
        <button class="tab-btn ${activeTab === "settings" ? "active" : ""}" data-tab="settings">\u8BBE\u7F6E</button>
      </nav>

      <main class="tab-content" id="tabContent">
      </main>
    </div>
  `;
    document.getElementById("logoutBtn").addEventListener("click", () => {
      logout();
      navigate("/login");
    });
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeTab = btn.dataset.tab;
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        renderActiveTab();
      });
    });
    renderActiveTab();
  }
  __name(renderMain, "renderMain");
  function renderTokenBar(status) {
    if (!status) return '<span class="token-status token-unknown">\u{1F511} Token\uFF1A\u68C0\u67E5\u4E2D...</span>';
    switch (status.status) {
      case "valid":
        return `<span class="token-status token-valid">\u{1F511} Token\uFF1A\u2705 ${status.message}</span>`;
      case "expiring":
        return `<span class="token-status token-expiring">\u{1F511} Token\uFF1A\u26A0\uFE0F ${status.message}</span>`;
      case "expired":
        return `<span class="token-status token-expired">\u{1F511} Token\uFF1A\u274C \u5DF2\u8FC7\u671F</span>`;
      default:
        return `<span class="token-status token-notset">\u{1F511} Token\uFF1A\u672A\u8BBE\u7F6E</span>`;
    }
  }
  __name(renderTokenBar, "renderTokenBar");
  function renderActiveTab() {
    const content = document.getElementById("tabContent");
    if (!content) return;
    switch (activeTab) {
      case "tiaoKe":
        renderTiaoKeTab(content, tokenStatus);
        break;
      case "history":
        renderHistoryTab(content);
        break;
      case "settings":
        renderSettingsTab(content, tokenStatus);
        break;
    }
  }
  __name(renderActiveTab, "renderActiveTab");
  async function refreshTokenStatus() {
    const statusResult = await post("tiaokeToken.get");
    tokenStatus = statusResult.code === 0 ? statusResult.data : { status: "not_set" };
    const bar = document.getElementById("tokenBar");
    if (bar) bar.innerHTML = renderTokenBar(tokenStatus);
    return tokenStatus;
  }
  __name(refreshTokenStatus, "refreshTokenStatus");

  // web/assets/js/app.js
  function initApp() {
    buildAppShell();
    initRouter();
    checkAuth();
    bindGlobalEvents();
    console.log("[\u8C03\u8BFE\u52A9\u624B] App initialized");
  }
  __name(initApp, "initApp");
  function buildAppShell() {
    const app = document.getElementById("app");
    if (!app) return;
    app.innerHTML = '<div id="app-root"></div>';
  }
  __name(buildAppShell, "buildAppShell");
  function checkAuth() {
    if (isLoggedIn()) {
      navigate("/main");
    } else {
      navigate("/login");
    }
  }
  __name(checkAuth, "checkAuth");
  function bindGlobalEvents() {
    window.addEventListener("tk:unauthorized", () => {
      logout();
      navigate("/login");
    });
  }
  __name(bindGlobalEvents, "bindGlobalEvents");
  document.addEventListener("DOMContentLoaded", initApp);
})();

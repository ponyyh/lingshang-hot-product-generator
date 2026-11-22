// ========== 深冬跨境 - 登录页交互逻辑（对接 LingShangAPI 认证接口） ==========

const API = window.LingShangAPI;

const dom = {
  toastContainer: document.getElementById("toastContainer"),
  tabAccount: document.getElementById("tabAccount"),
  tabPhone: document.getElementById("tabPhone"),
  accountForm: document.getElementById("accountForm"),
  phoneForm: document.getElementById("phoneForm"),
  usernameInput: document.getElementById("usernameInput"),
  passwordInput: document.getElementById("passwordInput"),
  togglePwdBtn: document.getElementById("togglePwdBtn"),
  accountSubmitBtn: document.getElementById("accountSubmitBtn"),
  goRegisterLink: document.getElementById("goRegisterLink"),
  forgotPwdLink: document.getElementById("forgotPwdLink"),
  phoneInput: document.getElementById("phoneInput"),
  smsCodeInput: document.getElementById("smsCodeInput"),
  sendCodeBtn: document.getElementById("sendCodeBtn"),
  phoneSubmitBtn: document.getElementById("phoneSubmitBtn"),
  noCodeLink: document.getElementById("noCodeLink")
};

let countdownTimer = null;
let countdownLeft = 0;

// ========== 点击「立即登录」向四周 360° 爆开 12~24 个明亮小彩带，约 1.6s 平滑淡出 ==========
function burstLoginRibbons(buttonEl) {
  if (!buttonEl) return;
  const rect = buttonEl.getBoundingClientRect();
  const originX = rect.left + rect.width / 2;
  const originY = rect.top + rect.height / 2;

  const canvas = document.createElement("canvas");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2500;";
  document.body.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  // 明亮六色：蓝、紫、青、绿、红、黄
  const colors = ["#2962FF", "#9B51FF", "#00D9FF", "#14E88A", "#FF476F", "#FFD600"];
  const count = 12 + Math.floor(Math.random() * 13); // 12~24 个小彩带
  const duration = 1600;
  const startTime = performance.now();
  let lastTime = startTime;
  const ribbons = [];

  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.28;
    const speed = 220 + Math.random() * 210; // px/s（与刷新率无关，60Hz/120Hz 一致）
    const spreadX = (Math.random() - 0.5) * rect.width * 0.45;
    const spreadY = (Math.random() - 0.5) * rect.height * 0.3;
    ribbons.push({
      x: originX + spreadX,
      y: originY + spreadY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 45,
      w: 10 + Math.random() * 4.5,
      h: 4.2 + Math.random() * 1.8,
      color: colors[i % colors.length],
      rotation: angle,
      spin: (Math.random() - 0.5) * 7.5,
      flip: Math.random() * Math.PI,
      flipSpeed: 7.5 + Math.random() * 5.0,
      fadeStart: 0.45 + Math.random() * 0.15
    });
  }

  function frame(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;

    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    for (const r of ribbons) {
      const drag = Math.pow(0.24, dt);
      r.x += r.vx * dt;
      r.y += r.vy * dt;
      r.vx *= drag;
      r.vy = r.vy * drag + 110 * dt;
      r.rotation += r.spin * dt;
      r.flip += r.flipSpeed * dt;

      const alpha = progress < r.fadeStart ? 1 : Math.max(0, 1 - (progress - r.fadeStart) / (1 - r.fadeStart));
      if (alpha <= 0.01) continue;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = r.color;
      ctx.translate(r.x, r.y);
      ctx.rotate(r.rotation);
      ctx.scale(1, Math.max(0.2, Math.abs(Math.cos(r.flip))));
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(-r.w / 2, -r.h / 2, r.w, r.h, 2);
      } else {
        ctx.rect(-r.w / 2, -r.h / 2, r.w, r.h);
      }
      ctx.fill();
      ctx.restore();
    }

    if (progress < 1) {
      requestAnimationFrame(frame);
    } else {
      canvas.remove();
    }
  }

  requestAnimationFrame(frame);
}

function showToast(message, type = "info", duration = 2600) {
  const el = document.createElement("div");
  el.className = `toast-item toast-${type}`;
  const iconChar = type === "error" ? "!" : type === "success" ? "✓" : "i";
  el.innerHTML = `<span class="toast-icon">${iconChar}</span><span>${message}</span>`;
  dom.toastContainer.innerHTML = "";
  dom.toastContainer.appendChild(el);

  setTimeout(() => {
    el.classList.add("toast-out");
    setTimeout(() => el.remove(), 220);
  }, duration);
}

// ========== Tab 切换（账号登录 ⇄ 手机号登录） ==========
function switchTab(tab) {
  const isAccount = tab === "account";
  dom.tabAccount.classList.toggle("active", isAccount);
  dom.tabAccount.setAttribute("aria-selected", String(isAccount));
  dom.tabPhone.classList.toggle("active", !isAccount);
  dom.tabPhone.setAttribute("aria-selected", String(!isAccount));

  dom.accountForm.classList.toggle("hidden", !isAccount);
  dom.phoneForm.classList.toggle("hidden", isAccount);
}

dom.tabAccount.addEventListener("click", () => switchTab("account"));
dom.tabPhone.addEventListener("click", () => switchTab("phone"));

// ========== 密码显示/隐藏切换（容器 106 闭眼 ⇄ 容器 117 睁眼明文） ==========
dom.togglePwdBtn.addEventListener("click", () => {
  const isHidden = dom.passwordInput.type === "password";
  dom.passwordInput.type = isHidden ? "text" : "password";
  dom.togglePwdBtn.querySelector(".eye-closed-icon").classList.toggle("hidden", isHidden);
  dom.togglePwdBtn.querySelector(".eye-open-icon").classList.toggle("hidden", !isHidden);
  dom.togglePwdBtn.title = isHidden ? "隐藏密码" : "显示密码";
});

// ========== 手机号输入联动「获取验证码」按钮激活态 ==========
dom.phoneInput.addEventListener("input", () => {
  dom.phoneInput.value = dom.phoneInput.value.replace(/\D/g, "").slice(0, 11);
  if (countdownLeft === 0) {
    dom.sendCodeBtn.classList.toggle("ready", /^1\d{10}$/.test(dom.phoneInput.value));
  }
});

// ========== 获取短信验证码 ==========
dom.sendCodeBtn.addEventListener("click", async () => {
  const phone = dom.phoneInput.value.trim();
  if (!/^1\d{10}$/.test(phone)) {
    showToast("请输入正确的 11 位手机号", "error");
    dom.phoneInput.focus();
    return;
  }

  dom.sendCodeBtn.disabled = true;
  try {
    const res = await API.sendSmsCode({ phone });
    const mockHint = res && res.mockCode ? `（测试验证码：${res.mockCode}）` : "";
    showToast(`验证码已发送${mockHint}`, "success", 3500);

    countdownLeft = 60;
    dom.sendCodeBtn.classList.remove("ready");
    dom.sendCodeBtn.textContent = `${countdownLeft}s 后重发`;
    countdownTimer = setInterval(() => {
      countdownLeft -= 1;
      if (countdownLeft <= 0) {
        clearInterval(countdownTimer);
        dom.sendCodeBtn.disabled = false;
        dom.sendCodeBtn.textContent = "获取验证码";
        dom.sendCodeBtn.classList.toggle("ready", /^1\d{10}$/.test(dom.phoneInput.value));
      } else {
        dom.sendCodeBtn.textContent = `${countdownLeft}s 后重发`;
      }
    }, 1000);
  } catch (err) {
    dom.sendCodeBtn.disabled = false;
    showToast(err.message || "验证码发送失败，请稍后重试", "error");
  }
});

// ========== 登录成功统一跳转工作台 ==========
function handleLoginSuccess(res) {
  if (window.localStorage) {
    if (res.token) window.localStorage.setItem("lingshang_token", res.token);
    if (res.user && res.user.name) {
      window.localStorage.setItem("lingshang_user", res.user.name);
    }
  }
  showToast("登录成功，正在进入深冬跨境工作台...", "success", 1600);
  setTimeout(() => {
    window.location.href = "./index.html";
  }, 1600);
}

// ========== 提交：账号登录 ==========
dom.accountForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  burstLoginRibbons(dom.accountSubmitBtn);
  const username = dom.usernameInput.value.trim();
  const password = dom.passwordInput.value.trim();

  if (!username) {
    showToast("请输入用户名", "error");
    dom.usernameInput.focus();
    return;
  }
  if (!password) {
    showToast("请输入登录密码", "error");
    dom.passwordInput.focus();
    return;
  }

  dom.accountSubmitBtn.disabled = true;
  dom.accountSubmitBtn.textContent = "登录中...";
  try {
    const res = await API.loginByAccount({ username, password });
    handleLoginSuccess(res);
  } catch (err) {
    showToast(err.message || "账号或密码错误，请重试", "error");
    dom.accountSubmitBtn.disabled = false;
    dom.accountSubmitBtn.textContent = "立即登录";
  }
});

// ========== 提交：手机号登录 ==========
dom.phoneForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  burstLoginRibbons(dom.phoneSubmitBtn);
  const phone = dom.phoneInput.value.trim();
  const code = dom.smsCodeInput.value.trim();

  if (!/^1\d{10}$/.test(phone)) {
    showToast("请输入正确的 11 位手机号", "error");
    dom.phoneInput.focus();
    return;
  }
  if (!code) {
    showToast("请输入验证码", "error");
    dom.smsCodeInput.focus();
    return;
  }

  dom.phoneSubmitBtn.disabled = true;
  dom.phoneSubmitBtn.textContent = "登录中...";
  try {
    const res = await API.loginByPhone({ phone, code });
    handleLoginSuccess(res);
  } catch (err) {
    showToast(err.message || "验证码错误或已过期", "error");
    dom.phoneSubmitBtn.disabled = false;
    dom.phoneSubmitBtn.textContent = "立即登录";
  }
});

// ========== 辅助链接提示 ==========
dom.goRegisterLink.addEventListener("click", () => {
  showToast("当前为内部商家系统，请联系管理员开通账号", "info");
});

dom.forgotPwdLink.addEventListener("click", () => {
  switchTab("phone");
  showToast("请使用手机号验证码快捷登录或联系管理员重置密码", "info");
});

dom.noCodeLink.addEventListener("click", () => {
  showToast("请检查手机是否拦截短信，或 60 秒后点击重新获取", "info");
});

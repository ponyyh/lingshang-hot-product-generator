// ========== 领商 - 爆品生成 页面交互逻辑（已解耦至 LingShangAPI 接口层） ==========

const MAX_SELECT_LIMIT = 100;
const API = window.LingShangAPI;

// ========== 应用状态 ==========
const state = {
  catalog: [],              // 当前商品库缓存（来自后端接口 /api/products）
  modalFilteredList: [],    // 弹窗当前搜索结果
  hotLink: "",
  currentTaskId: null,      // Agent 识别任务 ID（联调链路追踪）
  recognized: false,
  selectedIds: [],          // 已关联的商品 ID 列表
  selectedProductMap: new Map(), // id -> 商品对象缓存（支持后端分页搜索场景）
  checkedRowIds: new Set(),
  currentPage: 1,
  pageSize: 3,
  isTitleDirty: false,
  hasTitleError: false,
  tempModalSelectedIds: new Set(),
  searchTimer: null,
  autoRecognizeTimer: null,
  isRecognizing: false,
  lastRecognizedLink: "",
  lastRecognizedProducts: ""
};

// ========== DOM 引用 ==========
const dom = {
  toastContainer: document.getElementById("toastContainer"),
  sidebar: document.getElementById("sidebar"),
  sidebarToggle: document.getElementById("sidebarToggle"),
  hotLinkInput: document.getElementById("hotLinkInput"),
  selectProductsBtn: document.getElementById("selectProductsBtn"),
  selectedCountText: document.getElementById("selectedCountText"),
  productTableSection: document.getElementById("productTableSection"),
  productTableBody: document.getElementById("productTableBody"),
  tableSelectAll: document.getElementById("tableSelectAll"),
  tableTotalCount: document.getElementById("tableTotalCount"),
  pageSizeSelect: document.getElementById("pageSizeSelect"),
  prevPageBtn: document.getElementById("prevPageBtn"),
  nextPageBtn: document.getElementById("nextPageBtn"),
  pageNumbers: document.getElementById("pageNumbers"),
  titleTextareaWrapper: document.getElementById("titleTextareaWrapper"),
  titlePreviewInput: document.getElementById("titlePreviewInput"),
  charCounter: document.getElementById("charCounter"),
  titleErrorMsg: document.getElementById("titleErrorMsg"),
  aiRegenerateBar: document.getElementById("aiRegenerateBar"),
  regenerateBtn: document.getElementById("regenerateBtn"),
  submitDownloadBtn: document.getElementById("submitDownloadBtn"),
  cancelBtn: document.getElementById("cancelBtn"),
  // 弹窗相关
  productModal: document.getElementById("productModal"),
  closeModalBtn: document.getElementById("closeModalBtn"),
  modalCancelBtn: document.getElementById("modalCancelBtn"),
  modalConfirmBtn: document.getElementById("modalConfirmBtn"),
  modalSearchInput: document.getElementById("modalSearchInput"),
  modalHeaderCheck: document.getElementById("modalHeaderCheck"),
  modalProductList: document.getElementById("modalProductList"),
  modalSelectedCount: document.getElementById("modalSelectedCount")
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// ========== Toast 提示工具 ==========
function showToast(message, type = "info", duration = 2600) {
  const el = document.createElement("div");
  el.className = `toast-item toast-${type}`;
  const iconChar = type === "error" ? "!" : type === "success" ? "✓" : "i";
  el.innerHTML = `<span class="toast-icon">${iconChar}</span><span>${escapeHtml(message)}</span>`;
  dom.toastContainer.innerHTML = "";
  dom.toastContainer.appendChild(el);

  setTimeout(() => {
    el.classList.add("toast-out");
    setTimeout(() => el.remove(), 220);
  }, duration);
}

// ========== 自动识别：粘贴或输入有效爆款链接后自动调用 Agent 生成标题预览 ==========
async function tryAutoRecognize(fromUserPasteOrInput = false) {
  const val = dom.hotLinkInput.value.trim();
  if (!val || !/https?:\/\/[^\s]+/i.test(val)) return;

  if (state.selectedIds.length === 0) {
    if (fromUserPasteOrInput) {
      showToast("请先关联商品", "error");
    }
    return;
  }

  if (state.isRecognizing || (state.recognized && state.lastRecognizedLink === val && state.lastRecognizedProducts === state.selectedIds.join(","))) return;

  const requestProducts = state.selectedIds.join(",");
  state.isRecognizing = true;
  showToast("正在识别爆款链接...", "info", 1500);
  try {
    const res = await API.recognizeHotProduct({
      productIds: state.selectedIds,
      hotLink: val
    });
    if (dom.hotLinkInput.value.trim() !== val || state.selectedIds.join(",") !== requestProducts) return;
    state.currentTaskId = res.taskId || null;
    state.recognized = true;
    state.lastRecognizedLink = val;
    state.lastRecognizedProducts = state.selectedIds.join(",");
    state.isTitleDirty = true;
    state.hasTitleError = false;
    if (res.title) {
      dom.titlePreviewInput.value = res.title;
    }
    renderTitleState();
    showToast("已自动识别并生成标题预览", "success");
  } catch (err) {
    state.hasTitleError = true;
    dom.titleErrorMsg.textContent = err.message || "爆款链接识别失败，请点击重试生成";
    renderTitleState();
    showToast(dom.titleErrorMsg.textContent, "error");
  } finally {
    state.isRecognizing = false;
    if (dom.hotLinkInput.value.trim() !== val || state.selectedIds.join(",") !== requestProducts) tryAutoRecognize(false);
  }
}

// ========== 渲染：标题预览、字数统计与校验提示 ==========
function renderTitleState() {
  const text = dom.titlePreviewInput.value;
  dom.charCounter.textContent = `${text.length}/150`;

  dom.titleTextareaWrapper.classList.toggle("has-error", state.hasTitleError);
  dom.titleErrorMsg.classList.toggle("hidden", !state.hasTitleError);

  // AI 重新生成提示条：点击「识别」生成标题后显示
  dom.aiRegenerateBar.classList.toggle("hidden", !state.recognized && !state.hasTitleError);
  if (!dom.regenerateBtn.classList.contains("spinning")) dom.regenerateBtn.querySelector(".regen-text").textContent = state.hasTitleError ? "重试生成" : "重新生成";
}

// ========== 获取已选商品对象列表 ==========
function getSelectedProducts() {
  return state.selectedIds
    .map((id) => state.selectedProductMap.get(id))
    .filter(Boolean);
}

// ========== 渲染：关联商品表格与分页器 ==========
function renderProductTable() {
  const selectedItems = getSelectedProducts();
  const total = selectedItems.length;

  dom.selectedCountText.textContent = total;
  dom.tableTotalCount.textContent = total;

  if (total === 0) {
    dom.productTableSection.classList.add("hidden");
    return;
  }

  dom.productTableSection.classList.remove("hidden");

  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
  if (state.currentPage > totalPages) state.currentPage = totalPages;

  const start = (state.currentPage - 1) * state.pageSize;
  const pageItems = selectedItems.slice(start, start + state.pageSize);

  dom.productTableBody.innerHTML = pageItems
    .map(
      (item) => `
      <tr>
        <td class="col-check">
          <input type="checkbox" class="row-checkbox" data-id="${item.id}" ${
            state.checkedRowIds.has(item.id) ? "checked" : ""
          }>
        </td>
        <td>${escapeHtml(item.name)}</td>
        <td>${escapeHtml(item.color)}</td>
        <td>${escapeHtml(item.weight)}</td>
        <td>${escapeHtml(item.price)}</td>
        <td>${escapeHtml(item.packaging)}</td>
      </tr>
    `
    )
    .join("");

  // 表头复选框三态：全选 / 未全选（半选） / 未选
  const checkedCountOnPage = pageItems.filter((item) => state.checkedRowIds.has(item.id)).length;
  dom.tableSelectAll.checked = pageItems.length > 0 && checkedCountOnPage === pageItems.length;
  dom.tableSelectAll.indeterminate = checkedCountOnPage > 0 && checkedCountOnPage < pageItems.length;

  // 分页按钮渲染（超过 7 页自动折叠省略号）
  dom.prevPageBtn.disabled = state.currentPage <= 1;
  dom.nextPageBtn.disabled = state.currentPage >= totalPages;

  const pageList = [];
  if (totalPages <= 7) {
    for (let p = 1; p <= totalPages; p++) pageList.push(p);
  } else if (state.currentPage <= 4) {
    pageList.push(1, 2, 3, 4, 5, "...", totalPages);
  } else if (state.currentPage >= totalPages - 3) {
    pageList.push(1, "...", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages);
  } else {
    pageList.push(1, "...", state.currentPage - 1, state.currentPage, state.currentPage + 1, "...", totalPages);
  }

  dom.pageNumbers.innerHTML = pageList
    .map((p) =>
      p === "..."
        ? `<span class="page-ellipsis">···</span>`
        : `<button type="button" class="page-btn ${p === state.currentPage ? "active" : ""}" data-page="${p}">${p}</button>`
    )
    .join("");
}

// ========== 弹窗商品数据拉取与渲染 ==========
async function loadModalProducts(keyword = "") {
  try {
    const res = await API.fetchProducts({ keyword, page: 1, pageSize: 200 });
    const list = Array.isArray(res.list) ? res.list : [];
    state.modalFilteredList = list;
    list.forEach((item) => state.selectedProductMap.set(item.id, item));
    renderModalList();
  } catch (err) {
    showToast(err.message || "商品列表加载失败，请稍后重试", "error");
  }
}

function renderModalList() {
  const filtered = state.modalFilteredList;
  const reachedLimit = state.tempModalSelectedIds.size >= MAX_SELECT_LIMIT;

  dom.modalProductList.innerHTML = filtered
    .map((item) => {
      const isChecked = state.tempModalSelectedIds.has(item.id);
      const isDisabled = reachedLimit && !isChecked;
      return `
      <tr class="${isDisabled ? "modal-row-disabled" : ""}" ${isDisabled ? 'title="已达上限（最多可选 100 件），不可再选"' : ""}>
        <td class="col-check">
          <input type="checkbox" class="modal-row-check" data-id="${item.id}" ${isChecked ? "checked" : ""} ${isDisabled ? "disabled" : ""} ${isDisabled ? 'title="最多只能选择 100 件商品"' : ""}>
        </td>
        <td>${escapeHtml(item.name)}</td>
        <td>${escapeHtml(item.color)}</td>
        <td>${escapeHtml(item.weight)}</td>
        <td>${escapeHtml(item.price)}</td>
        <td>${escapeHtml(item.packaging)}</td>
      </tr>
    `;
    })
    .join("");

  dom.modalSelectedCount.textContent = state.tempModalSelectedIds.size;
  const modalCheckedCount = filtered.filter((item) => state.tempModalSelectedIds.has(item.id)).length;
  const maxSelectableInView = Math.min(filtered.length, MAX_SELECT_LIMIT);
  dom.modalHeaderCheck.checked = maxSelectableInView > 0 && modalCheckedCount >= maxSelectableInView;
  dom.modalHeaderCheck.indeterminate = modalCheckedCount > 0 && modalCheckedCount < maxSelectableInView;
}

async function openProductModal() {
  state.tempModalSelectedIds = new Set(state.selectedIds);
  dom.modalSearchInput.value = "";
  dom.productModal.classList.remove("hidden");
  await loadModalProducts("");
}

function closeProductModal() {
  dom.productModal.classList.add("hidden");
}

// ========== 事件绑定 ==========
function bindEvents() {
  // 1. 爆款链接输入 / 粘贴监听：粘贴或输入有效链接后自动识别并生成标题预览
  dom.hotLinkInput.addEventListener("input", () => {
    state.hotLink = dom.hotLinkInput.value.trim();
    if (state.hotLink !== state.lastRecognizedLink) {
      state.recognized = false;
      state.currentTaskId = null;
      dom.titlePreviewInput.value = "";
      renderTitleState();
    }
    if (!state.hotLink) {
      state.recognized = false;
      state.lastRecognizedLink = "";
      renderTitleState();
      return;
    }
    clearTimeout(state.autoRecognizeTimer);
    state.autoRecognizeTimer = setTimeout(() => {
      tryAutoRecognize(true);
    }, 260);
  });

  dom.hotLinkInput.addEventListener("paste", () => {
    clearTimeout(state.autoRecognizeTimer);
    state.autoRecognizeTimer = setTimeout(() => {
      state.hotLink = dom.hotLinkInput.value.trim();
      tryAutoRecognize(true);
    }, 60);
  });

  // 3. 选择商品弹窗交互（调用后端商品列表接口：GET /api/products）
  dom.selectProductsBtn.addEventListener("click", openProductModal);
  dom.closeModalBtn.addEventListener("click", closeProductModal);
  dom.modalCancelBtn.addEventListener("click", closeProductModal);
  dom.productModal.addEventListener("click", (e) => {
    if (e.target === dom.productModal) closeProductModal();
  });

  dom.modalSearchInput.addEventListener("input", () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      loadModalProducts(dom.modalSearchInput.value.trim());
    }, 180);
  });

  dom.modalHeaderCheck.addEventListener("change", () => {
    const checkboxes = Array.from(dom.modalProductList.querySelectorAll(".modal-row-check"));
    const visibleIds = checkboxes.map((cb) => Number(cb.dataset.id));
    const checkedInView = visibleIds.filter((id) => state.tempModalSelectedIds.has(id)).length;
    const maxSelectableInView = Math.min(visibleIds.length, MAX_SELECT_LIMIT);

    if (maxSelectableInView > 0 && checkedInView >= maxSelectableInView) {
      visibleIds.forEach((id) => state.tempModalSelectedIds.delete(id));
    } else {
      for (const id of visibleIds) {
        if (state.tempModalSelectedIds.size >= MAX_SELECT_LIMIT) break;
        state.tempModalSelectedIds.add(id);
      }
    }
    renderModalList();
  });

  dom.modalProductList.addEventListener("change", (e) => {
    if (!e.target.classList.contains("modal-row-check")) return;
    const id = Number(e.target.dataset.id);
    if (e.target.checked) {
      if (state.tempModalSelectedIds.size >= MAX_SELECT_LIMIT) {
        e.target.checked = false;
        return;
      }
      state.tempModalSelectedIds.add(id);
    } else {
      state.tempModalSelectedIds.delete(id);
    }
    renderModalList();
  });

  dom.modalConfirmBtn.addEventListener("click", () => {
    const nextIds = Array.from(state.tempModalSelectedIds).sort((a, b) => a - b);
    if (state.selectedIds.join(",") !== nextIds.join(",")) {
      state.recognized = false;
      state.currentTaskId = null;
      dom.titlePreviewInput.value = "";
    }
    state.selectedIds = nextIds;
    state.currentPage = 1;
    closeProductModal();
    renderProductTable();
    renderTitleState();
    tryAutoRecognize(false);
  });

  // 4. 主表格勾选与分页
  dom.tableSelectAll.addEventListener("change", (e) => {
    dom.tableSelectAll.indeterminate = false;
    const checkboxes = dom.productTableBody.querySelectorAll(".row-checkbox");
    checkboxes.forEach((cb) => {
      const id = Number(cb.dataset.id);
      cb.checked = e.target.checked;
      if (e.target.checked) state.checkedRowIds.add(id);
      else state.checkedRowIds.delete(id);
    });
  });

  dom.productTableBody.addEventListener("change", (e) => {
    if (!e.target.classList.contains("row-checkbox")) return;
    const id = Number(e.target.dataset.id);
    if (e.target.checked) state.checkedRowIds.add(id);
    else state.checkedRowIds.delete(id);
    renderProductTable();
  });

  dom.pageSizeSelect.addEventListener("change", (e) => {
    state.pageSize = Number(e.target.value);
    state.currentPage = 1;
    renderProductTable();
  });

  dom.prevPageBtn.addEventListener("click", () => {
    if (state.currentPage > 1) {
      state.currentPage -= 1;
      renderProductTable();
    }
  });

  dom.nextPageBtn.addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil(state.selectedIds.length / state.pageSize));
    if (state.currentPage < totalPages) {
      state.currentPage += 1;
      renderProductTable();
    }
  });

  dom.pageNumbers.addEventListener("click", (e) => {
    const btn = e.target.closest(".page-btn");
    if (!btn) return;
    state.currentPage = Number(btn.dataset.page);
    renderProductTable();
  });

  // 5. 标题预览输入监听
  dom.titlePreviewInput.addEventListener("focus", () => {
    if (!state.isTitleDirty) {
      state.isTitleDirty = true;
      renderTitleState();
    }
  });

  dom.titlePreviewInput.addEventListener("input", () => {
    state.isTitleDirty = true;
    if (state.hasTitleError) {
      state.hasTitleError = false;
    }
    renderTitleState();
  });

  // 6. AI「重新生成」标题（调用 AI Agent 接口：POST /api/agent/hot-product/regenerate-title）
  dom.regenerateBtn.addEventListener("click", async () => {
    if (state.isRecognizing || dom.regenerateBtn.classList.contains("spinning")) return;
    if (!state.recognized) return tryAutoRecognize(true);
    dom.regenerateBtn.classList.add("spinning");
    dom.regenerateBtn.querySelector(".regen-text").textContent = "生成中...";

    try {
      const res = await API.regenerateHotTitle({
        taskId: state.currentTaskId,
        productIds: state.selectedIds,
        hotLink: dom.hotLinkInput.value.trim(),
        previousTitle: dom.titlePreviewInput.value.trim()
      });
      if (res.taskId) state.currentTaskId = res.taskId;
      dom.titlePreviewInput.value = res.title || "";
      state.isTitleDirty = true;
      state.hasTitleError = false;

      renderTitleState();
      showToast("已重新生成符合平台规范的爆款标题", "success");
    } catch (err) {
      state.hasTitleError = true;
      dom.titleErrorMsg.textContent = err.message || "标题重新生成失败，请重试";
      renderTitleState();
      showToast(dom.titleErrorMsg.textContent, "error");
    } finally {
      dom.regenerateBtn.classList.remove("spinning");
      renderTitleState();
    }
  });

  // 7. 底部「导出」（已移除标题合规校验逻辑，三项必填后直接调用后端导出接口下载）
  dom.submitDownloadBtn.addEventListener("click", async () => {
    if (state.isRecognizing) { showToast("标题生成中，请稍候", "info"); return; }
    const link = dom.hotLinkInput.value.trim();
    const title = dom.titlePreviewInput.value.trim();

    if (state.selectedIds.length === 0) {
      showToast("请关联商品", "error");
      return;
    }

    if (!link) {
      showToast("请输入爆款链接", "error");
      dom.hotLinkInput.focus();
      return;
    }

    if (!title) {
      showToast("请填写标题预览", "error");
      dom.titlePreviewInput.focus();
      return;
    }

    dom.submitDownloadBtn.disabled = true;
    try {
      state.hasTitleError = false;
      renderTitleState();
      showToast("正在导出爆品方案...", "success");

      await API.exportHotProduct({
        taskId: state.currentTaskId,
        productIds: state.selectedIds,
        products: getSelectedProducts(),
        hotLink: link,
        title
      });
    } catch (err) {
      showToast(err.message || "导出失败，请稍后重试", "error");
    } finally {
      dom.submitDownloadBtn.disabled = false;
    }
  });

  // 8. 底部「取消」按钮：重置回初始空白态
  dom.cancelBtn.addEventListener("click", () => {
    state.hotLink = "";
    state.currentTaskId = null;
    state.recognized = false;
    state.lastRecognizedLink = "";
    state.selectedIds = [];
    state.checkedRowIds.clear();
    state.currentPage = 1;
    state.isTitleDirty = false;
    state.hasTitleError = false;

    dom.hotLinkInput.value = "";
    dom.titlePreviewInput.value = "";

    renderProductTable();
    renderTitleState();
    showToast("已重置表单内容", "info", 1800);
  });

  // 9. 左侧菜单展开收起 & 侧边栏折叠
  dom.sidebarToggle.addEventListener("click", () => {
    const isCollapsed = dom.sidebar.classList.toggle("collapsed");
    document.body.classList.toggle("sidebar-collapsed", isCollapsed);
  });

  document.querySelectorAll(".nav-item").forEach((btn) => {
    const labelEl = btn.querySelector(".nav-label");
    if (labelEl) btn.title = labelEl.textContent.trim();

    btn.addEventListener("click", () => {
      const group = btn.closest(".nav-group");
      if (group.querySelector(".nav-submenu")) {
        group.classList.toggle("expanded");
      } else {
        showToast("当前演示模块为「商品 > 爆品运营 > 爆品生成」", "info", 2000);
      }
    });
  });

  document.querySelectorAll(".sub-item").forEach((item) => {
    item.addEventListener("click", () => {
      if (item.dataset.page !== "爆品运营") {
        showToast(`「${item.dataset.page}」模块暂未开启，当前停留在爆品生成页`, "info", 2000);
      }
    });
  });

  // 10. 顶部工具栏轻提示 & 点击「运营小二」返回登录页切换账号
  document.querySelectorAll(".header-right .icon-btn[data-tip]").forEach((btn) => {
    btn.addEventListener("click", () => {
      showToast(btn.dataset.tip, "info", 2200);
    });
  });

  const userMenuBtn = document.getElementById("userMenuBtn");
  if (userMenuBtn) {
    userMenuBtn.title = "点击返回登录页";
    userMenuBtn.addEventListener("click", () => {
      window.location.href = "./login.html";
    });
  }
}

// ========== 初始化 ==========
function init() {
  bindEvents();
  renderProductTable();
  renderTitleState();
}

init();

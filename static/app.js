"use strict";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const money = (cents) => (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const filterForm = $("#filter-form");
const recordForm = $("#record-form");
const palette = ["#789363", "#bccd9b", "#d9bc8e", "#9bb9ac", "#c9977f", "#c5c69b", "#a4a7bb", "#d9dcca"];
const symbols = { "餐饮": "食", "交通": "行", "购物": "购", "居住": "居", "娱乐": "乐", "医疗": "医", "学习": "学", "工资": "薪", "奖金": "奖", "兼职": "兼", "理财": "财", "红包": "礼" };
const state = { data: null, page: 1, pageSize: 8, editId: null, deleteId: null, filters: {}, requestId: 0, saving: false, exporting: false };
let toastTimer;

function notify(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 3500);
}

function setError(selector, message = "") {
  const element = $(selector);
  element.textContent = message;
  element.hidden = !message;
}

async function api(path, method = "GET", body) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error("无法连接本地服务，请确认 Python 程序仍在运行。");
  }
  let data;
  try { data = await response.json(); } catch { throw new Error("服务返回异常，请刷新页面后重试。"); }
  if (!response.ok) throw new Error(data.error || "操作失败，请稍后重试。");
  return data;
}

function formFilters() {
  return Object.fromEntries([...new FormData(filterForm)].filter(([, value]) => value !== ""));
}

function fillCategories(select, kind = "", withAll = false) {
  const previous = select.value;
  select.replaceChildren();
  if (withAll) select.add(new Option("全部类别", ""));
  const categories = state.data?.categories || {};
  const names = kind ? (categories[kind] || []) : Object.values(categories).flat();
  names.forEach((name) => select.add(new Option(name, name)));
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

async function refresh(filters = state.filters, resetPage = false) {
  const requestId = ++state.requestId;
  const data = await api(`/api/records?${new URLSearchParams(filters)}`);
  if (requestId !== state.requestId) return;
  state.data = data;
  state.filters = { ...filters };
  if (resetPage) state.page = 1;
  $("#load-error").hidden = true;
  setError("#filter-error");
  $$(".add-record").forEach((button) => { button.disabled = false; });
  fillCategories(filterForm.elements.category, filterForm.elements.kind.value, true);
  render();
}

function render() {
  const { summary, expense_categories: categories } = state.data;
  $("#income-total").textContent = money(summary.income_cents);
  $("#expense-total").textContent = money(summary.expense_cents);
  $("#balance-total").textContent = money(summary.balance_cents);
  $("#summary-count").textContent = `${summary.count} 笔记录`;
  $("#record-count").textContent = summary.count;
  $("#scope-label").textContent = Object.keys(state.filters).length ? `当前筛选 · ${summary.count} 笔` : "全部记录";
  $("#chart-total").textContent = `¥${money(summary.expense_cents)}`;
  $("#chart-category-count").textContent = `${categories.length} 个类别`;
  $("#chart-empty").hidden = categories.length > 0;
  $("#chart-legend").replaceChildren();
  let angle = 0;
  const stops = categories.map((item, index) => {
    const percentage = item.amount_cents / summary.expense_cents * 100;
    const color = palette[index % palette.length];
    const start = angle;
    angle += percentage;
    const row = document.createElement("div");
    row.className = "legend-row";
    const dot = document.createElement("span");
    dot.className = "legend-dot";
    dot.style.background = color;
    row.append(dot, textElement("span", "legend-name", item.category), textElement("span", "legend-value", `¥${money(item.amount_cents)}`), textElement("span", "legend-percent", `${percentage.toFixed(1)}%`));
    $("#chart-legend").append(row);
    return `${color} ${start}% ${angle}%`;
  });
  $("#donut").style.background = stops.length ? `conic-gradient(${stops.join(",")})` : "#edf1e5";
  $("#donut").setAttribute("aria-label", categories.length ? `支出构成：${categories.map((item) => `${item.category} ${money(item.amount_cents)} 元`).join("，")}` : "暂无支出数据");
  renderTable();
}

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  // 备注等用户输入仅通过 textContent 渲染，避免作为 HTML 执行。
  element.textContent = text;
  return element;
}

function actionButton(action, record) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-button ${action}-action`;
  button.setAttribute("aria-label", `${action === "edit" ? "编辑" : "删除"} ${record.date} ${record.category} ${money(record.amount_cents)} 元`);
  button.title = action === "edit" ? "编辑记录" : "删除记录";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", action === "edit" ? "#i-edit" : "#i-trash");
  svg.append(use);
  button.append(svg);
  button.addEventListener("click", () => action === "edit" ? openRecord(record) : openDelete(record));
  return button;
}

function renderTable() {
  const records = state.data.records;
  const pages = Math.max(1, Math.ceil(records.length / state.pageSize));
  state.page = Math.min(state.page, pages);
  const offset = (state.page - 1) * state.pageSize;
  const body = $("#records-body");
  body.replaceChildren();
  records.slice(offset, offset + state.pageSize).forEach((record) => {
    const row = document.createElement("tr");
    const categoryCell = document.createElement("td");
    const category = document.createElement("div");
    category.className = "category-cell";
    const categoryLabel = document.createElement("span");
    categoryLabel.append(textElement("strong", "", record.category), textElement("small", "", record.kind === "income" ? "收入" : "支出"));
    category.append(textElement("span", `category-symbol ${record.kind}`, symbols[record.category] || "记"), categoryLabel);
    categoryCell.append(category);
    const note = document.createElement("td");
    const noteText = textElement("div", "record-note", record.note || "—");
    noteText.title = record.note;
    note.append(noteText);
    const actions = document.createElement("td");
    const actionGroup = document.createElement("div");
    actionGroup.className = "row-actions";
    actionGroup.append(actionButton("edit", record), actionButton("delete", record));
    actions.append(actionGroup);
    row.append(categoryCell, note, textElement("td", "record-date", record.date.replaceAll("-", "/")), textElement("td", `record-amount ${record.kind}`, `${record.kind === "income" ? "+" : "−"}${money(record.amount_cents)}`), actions);
    body.append(row);
  });
  const empty = records.length === 0;
  const initial = state.data.total_count === 0;
  $("#empty-state").hidden = !empty;
  $("#empty-title").textContent = initial ? "从第一笔开始，让生活有数" : "没有找到符合条件的记录";
  $("#empty-description").textContent = initial ? "一顿午餐、一杯咖啡，或一份收入，都值得记下来。" : "试试调整日期、类别或金额，或者重置筛选。";
  $("#empty-add").hidden = !initial;
  $("#page-info").textContent = empty ? "共 0 笔记录" : `第 ${offset + 1}–${Math.min(offset + state.pageSize, records.length)} 笔，共 ${records.length} 笔`;
  $("#page-number").textContent = `${state.page} / ${pages}`;
  $("#previous-page").disabled = state.page <= 1;
  $("#next-page").disabled = state.page >= pages;
  $("#export-csv").disabled = state.exporting;
}

function setKind(kind) {
  recordForm.elements.kind.value = kind;
  $$("[data-kind]").forEach((button) => {
    const selected = button.dataset.kind === kind;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", selected);
  });
  fillCategories(recordForm.elements.category, kind);
}

function openRecord(record = null) {
  if (!state.data) return;
  recordForm.reset();
  state.editId = record?.id || null;
  setError("#record-error");
  $("#record-dialog-title").textContent = record ? "编辑记录" : "记一笔";
  setKind(record?.kind || "expense");
  recordForm.elements.date.value = record?.date || localDate();
  if (record) {
    recordForm.elements.amount.value = (record.amount_cents / 100).toFixed(2);
    recordForm.elements.category.value = record.category;
    recordForm.elements.note.value = record.note;
  }
  $("#record-dialog").showModal();
  recordForm.elements.amount.focus();
}

function openDelete(record) {
  state.deleteId = record.id;
  $("#delete-description").textContent = `${record.date} · ${record.category} · ${record.kind === "income" ? "收入" : "支出"} ¥${money(record.amount_cents)}${record.note ? ` · ${record.note}` : ""}`;
  setError("#delete-error");
  $("#delete-dialog").showModal();
}

function showLoadError(error) {
  $("#load-error span").textContent = error.message;
  $("#load-error").hidden = false;
  if (!state.data) {
    $("#empty-title").textContent = "暂时无法读取账本";
    $("#empty-description").textContent = "请检查本地服务是否启动，然后点击上方重试。";
  }
}

function exportFilename(response) {
  // 优先使用服务端给出的文件名，取不到时回退到接口约定的默认名。
  const disposition = response.headers.get("Content-Disposition") || "";
  const encoded = /filename\*=utf-8''([^;]+)/i.exec(disposition);
  if (encoded) {
    try { return decodeURIComponent(encoded[1].trim()); } catch { /* 回退到普通文件名 */ }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1].trim() : "account-book.csv";
}

function saveDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportCsv() {
  if (state.exporting || !state.data) return;
  const button = $("#export-csv");
  const label = button.querySelector(".export-label");
  state.exporting = true;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  label.textContent = "导出中…";
  try {
    // 使用已应用的筛选条件，保证导出结果与当前列表口径一致；导出全部匹配记录，不受分页影响。
    const query = new URLSearchParams(state.filters).toString();
    let response;
    try { response = await fetch(`/api/records.csv${query ? `?${query}` : ""}`); }
    catch { throw new Error("无法连接本地服务，导出失败，请确认 Python 程序仍在运行。"); }
    if (!response.ok) {
      let detail = "";
      try { detail = (await response.json()).error || ""; } catch { /* 非 JSON 错误响应 */ }
      throw new Error(detail ? `导出失败：${detail}` : "导出失败，请稍后重试。");
    }
    const blob = await response.blob();
    if (!blob.size) throw new Error("导出的文件为空，请稍后重试。");
    saveDownload(blob, exportFilename(response));
    const count = state.data.summary.count;
    notify(count ? `已导出 ${count} 笔记录` : "当前筛选没有记录，已导出空表头");
  } catch (error) {
    notify(error.message);
  } finally {
    state.exporting = false;
    button.disabled = !state.data;
    button.removeAttribute("aria-busy");
    label.textContent = "导出 CSV";
  }
}

async function submitFilters() {
  try { await refresh(formFilters(), true); }
  catch (error) { setError("#filter-error", error.message); }
}

$("#today-label").textContent = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
$$(".add-record").forEach((button) => button.addEventListener("click", () => openRecord()));
$$(".close-dialog").forEach((button) => button.addEventListener("click", () => { if (!state.saving) button.closest("dialog").close(); }));
$$("dialog").forEach((dialog) => dialog.addEventListener("cancel", (event) => { if (state.saving) event.preventDefault(); }));
$$("[data-kind]").forEach((button) => button.addEventListener("click", () => setKind(button.dataset.kind)));
$("#help-button").addEventListener("click", () => $("#help-dialog").showModal());
$("#previous-page").addEventListener("click", () => { state.page--; renderTable(); });
$("#next-page").addEventListener("click", () => { state.page++; renderTable(); });
$("#refresh-button").addEventListener("click", () => refresh().catch(showLoadError));
$("#export-csv").addEventListener("click", exportCsv);
$("#retry-button").addEventListener("click", () => refresh().catch(showLoadError));
filterForm.addEventListener("submit", (event) => { event.preventDefault(); submitFilters(); });
filterForm.elements.kind.addEventListener("change", () => { filterForm.elements.category.value = ""; fillCategories(filterForm.elements.category, filterForm.elements.kind.value, true); });
for (const name of ["start", "end"]) filterForm.elements[name].addEventListener("change", () => $$("[data-period]").forEach((button) => { button.classList.remove("selected"); button.setAttribute("aria-pressed", "false"); }));

$("#reset-filters").addEventListener("click", () => {
  filterForm.reset();
  fillCategories(filterForm.elements.category, "", true);
  $$("[data-period]").forEach((button) => { const selected = button.dataset.period === "all"; button.classList.toggle("selected", selected); button.setAttribute("aria-pressed", selected); });
  submitFilters();
});

$$("[data-period]").forEach((button) => button.addEventListener("click", () => {
  const now = new Date();
  let start = "";
  if (button.dataset.period === "month") start = localDate(new Date(now.getFullYear(), now.getMonth(), 1));
  if (button.dataset.period === "week") {
    const monday = new Date(now);
    monday.setDate(now.getDate() - (now.getDay() + 6) % 7);
    start = localDate(monday);
  }
  filterForm.elements.start.value = start;
  filterForm.elements.end.value = start ? localDate(now) : "";
  $$("[data-period]").forEach((item) => { const selected = item === button; item.classList.toggle("selected", selected); item.setAttribute("aria-pressed", selected); });
  if (filterForm.reportValidity()) submitFilters();
}));

recordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.saving) return;
  state.saving = true;
  const button = $("#save-record");
  button.disabled = true;
  button.textContent = "保存中…";
  setError("#record-error");
  try {
    const editing = Boolean(state.editId);
    await api(editing ? `/api/records/${state.editId}` : "/api/records", editing ? "PUT" : "POST", Object.fromEntries(new FormData(recordForm)));
    $("#record-dialog").close();
    try {
      await refresh(state.filters, true);
      notify(editing ? "记录已更新" : Object.keys(state.filters).length ? "记录已保存，列表仍按当前条件筛选" : "已记下这一笔");
    } catch (error) { showLoadError(error); notify("记录已保存，但列表刷新失败，请重试刷新"); }
  } catch (error) { setError("#record-error", error.message); }
  finally { state.saving = false; button.disabled = false; button.textContent = "保存记录"; }
});

$("#confirm-delete").addEventListener("click", async () => {
  if (state.saving) return;
  state.saving = true;
  $("#confirm-delete").disabled = true;
  setError("#delete-error");
  try {
    await api(`/api/records/${state.deleteId}`, "DELETE");
    $("#delete-dialog").close();
    try { await refresh(); notify("记录已删除"); }
    catch (error) { showLoadError(error); notify("记录已删除，但列表刷新失败，请重试刷新"); }
  } catch (error) { setError("#delete-error", error.message); }
  finally { state.saving = false; $("#confirm-delete").disabled = false; }
});

$$(".nav-link").forEach((link) => link.addEventListener("click", () => { $$(".nav-link").forEach((item) => item.classList.toggle("active", item === link)); }));
refresh().catch(showLoadError);
"use strict";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const money = (cents) => (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const filterForm = $("#filter-form");
const recordForm = $("#record-form");
const palette = ["#789363", "#bccd9b", "#d9bc8e", "#9bb9ac", "#c9977f", "#c5c69b", "#a4a7bb", "#d9dcca"];
const symbols = { "餐饮": "食", "交通": "行", "购物": "购", "居住": "居", "娱乐": "乐", "医疗": "医", "学习": "学", "工资": "薪", "奖金": "奖", "兼职": "兼", "理财": "财", "红包": "礼" };
const state = { data: null, page: 1, pageSize: 8, editId: null, deleteId: null, filters: {}, requestId: 0, saving: false };
const budgetState = { month: localDate().slice(0, 7), data: null, loading: false, saving: false, requestId: 0 };
let toastTimer;

function notify(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 3500);
}

function setError(selector, message = "") {
  const element = $(selector);
  element.textContent = message;
  element.hidden = !message;
}

async function api(path, method = "GET", body) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error("无法连接本地服务，请确认 Python 程序仍在运行。");
  }
  let data;
  try { data = await response.json(); } catch { throw new Error("服务返回异常，请刷新页面后重试。"); }
  if (!response.ok) throw new Error(data.error || "操作失败，请稍后重试。");
  return data;
}

function formFilters() {
  return Object.fromEntries([...new FormData(filterForm)].filter(([, value]) => value !== ""));
}

function fillCategories(select, kind = "", withAll = false) {
  const previous = select.value;
  select.replaceChildren();
  if (withAll) select.add(new Option("全部类别", ""));
  const categories = state.data?.categories || {};
  const names = kind ? (categories[kind] || []) : Object.values(categories).flat();
  names.forEach((name) => select.add(new Option(name, name)));
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

async function refresh(filters = state.filters, resetPage = false) {
  const requestId = ++state.requestId;
  const data = await api(`/api/records?${new URLSearchParams(filters)}`);
  if (requestId !== state.requestId) return;
  state.data = data;
  state.filters = { ...filters };
  if (resetPage) state.page = 1;
  $("#load-error").hidden = true;
  setError("#filter-error");
  $$(".add-record").forEach((button) => { button.disabled = false; });
  fillCategories(filterForm.elements.category, filterForm.elements.kind.value, true);
  render();
  // 账目变动后同步刷新预算卡片；内部自行处理错误，不阻断主流程。
  loadBudget(budgetState.month);
}

function render() {
  const { summary, expense_categories: categories } = state.data;
  $("#income-total").textContent = money(summary.income_cents);
  $("#expense-total").textContent = money(summary.expense_cents);
  $("#balance-total").textContent = money(summary.balance_cents);
  $("#summary-count").textContent = `${summary.count} 笔记录`;
  $("#record-count").textContent = summary.count;
  $("#scope-label").textContent = Object.keys(state.filters).length ? `当前筛选 · ${summary.count} 笔` : "全部记录";
  $("#chart-total").textContent = `¥${money(summary.expense_cents)}`;
  $("#chart-category-count").textContent = `${categories.length} 个类别`;
  $("#chart-empty").hidden = categories.length > 0;
  $("#chart-legend").replaceChildren();
  let angle = 0;
  const stops = categories.map((item, index) => {
    const percentage = item.amount_cents / summary.expense_cents * 100;
    const color = palette[index % palette.length];
    const start = angle;
    angle += percentage;
    const row = document.createElement("div");
    row.className = "legend-row";
    const dot = document.createElement("span");
    dot.className = "legend-dot";
    dot.style.background = color;
    row.append(dot, textElement("span", "legend-name", item.category), textElement("span", "legend-value", `¥${money(item.amount_cents)}`), textElement("span", "legend-percent", `${percentage.toFixed(1)}%`));
    $("#chart-legend").append(row);
    return `${color} ${start}% ${angle}%`;
  });
  $("#donut").style.background = stops.length ? `conic-gradient(${stops.join(",")})` : "#edf1e5";
  $("#donut").setAttribute("aria-label", categories.length ? `支出构成：${categories.map((item) => `${item.category} ${money(item.amount_cents)} 元`).join("，")}` : "暂无支出数据");
  renderTable();
}

function renderBudgetLoading() {
  $("#budget-loading").hidden = false;
  $("#budget-error").hidden = true;
  $("#budget-body").hidden = true;
}

function renderBudgetError(message) {
  $("#budget-loading").hidden = true;
  $("#budget-error").hidden = false;
  $("#budget-error span").textContent = message;
  $("#budget-body").hidden = true;
}

async function loadBudget(month) {
  const requestId = ++budgetState.requestId;
  budgetState.month = month;
  budgetState.loading = true;
  renderBudgetLoading();
  try {
    const data = await api(`/api/budgets/${month}`);
    if (requestId !== budgetState.requestId) return;
    budgetState.data = data;
    renderBudget();
  } catch (error) {
    if (requestId !== budgetState.requestId) return;
    renderBudgetError(error.message);
  } finally {
    if (requestId === budgetState.requestId) budgetState.loading = false;
  }
}

function renderBudget() {
  const data = budgetState.data;
  const panel = $("#budget-panel");
  $("#budget-loading").hidden = true;
  $("#budget-error").hidden = true;
  $("#budget-body").hidden = false;
  $("#budget-spent").textContent = `¥${money(data.spent_cents)}`;
  const fill = $("#budget-progress-fill");
  const progress = $("#budget-progress");
  panel.classList.remove("is-warning", "is-danger");
  if (!data.has_budget) {
    $("#budget-amount").textContent = "—";
    $("#budget-remaining-label").textContent = "剩余";
    $("#budget-remaining").textContent = "—";
    $("#budget-remaining-metric").classList.remove("overspent");
    $("#budget-status").textContent = "尚未设置预算，点击「设置预算」开始管理本月支出";
    $("#budget-percent").textContent = "";
    fill.style.width = "0%";
    fill.className = "budget-progress-fill";
    progress.setAttribute("aria-valuenow", "0");
    return;
  }
  const percent = data.usage_percent;
  $("#budget-amount").textContent = `¥${money(data.budget_cents)}`;
  $("#budget-percent").textContent = `${percent}%`;
  fill.style.width = `${Math.min(percent, 100)}%`;
  $("#budget-remaining-metric").classList.remove("overspent");
  if (percent > 100) {
    panel.classList.add("is-danger");
    fill.className = "budget-progress-fill danger";
    $("#budget-remaining-label").textContent = "超支";
    $("#budget-remaining").textContent = `¥${money(data.overspent_cents)}`;
    $("#budget-remaining-metric").classList.add("overspent");
    $("#budget-status").textContent = `已超支 ¥${money(data.overspent_cents)}，请留意本月支出`;
  } else if (percent === 100) {
    panel.classList.add("is-warning");
    fill.className = "budget-progress-fill warning";
    $("#budget-remaining-label").textContent = "剩余";
    $("#budget-remaining").textContent = "¥0.00";
    $("#budget-status").textContent = "预算已用尽，再花一笔就会超支";
  } else if (percent >= 80) {
    panel.classList.add("is-warning");
    fill.className = "budget-progress-fill warning";
    $("#budget-remaining-label").textContent = "剩余";
    $("#budget-remaining").textContent = `¥${money(data.remaining_cents)}`;
    $("#budget-status").textContent = "预算使用已超过 80%，注意控制节奏";
  } else {
    fill.className = "budget-progress-fill";
    $("#budget-remaining-label").textContent = "剩余";
    $("#budget-remaining").textContent = `¥${money(data.remaining_cents)}`;
    $("#budget-status").textContent = percent === 0 ? "本月还没有支出，预算已备好" : "支出节奏平稳，继续保持";
  }
  progress.setAttribute("aria-valuenow", String(Math.min(percent, 100)));
}

function openBudgetDialog() {
  if (!budgetState.data) return;
  $("#budget-form").reset();
  setError("#budget-dialog-error");
  $("#budget-dialog-month").textContent = `${budgetState.month} 月预算`;
  if (budgetState.data.has_budget) {
    $("#budget-amount-input").value = (budgetState.data.budget_cents / 100).toFixed(2);
  }
  $("#budget-dialog").showModal();
  $("#budget-amount-input").focus();
}

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  // 备注等用户输入仅通过 textContent 渲染，避免作为 HTML 执行。
  element.textContent = text;
  return element;
}

function actionButton(action, record) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-button ${action}-action`;
  button.setAttribute("aria-label", `${action === "edit" ? "编辑" : "删除"} ${record.date} ${record.category} ${money(record.amount_cents)} 元`);
  button.title = action === "edit" ? "编辑记录" : "删除记录";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", action === "edit" ? "#i-edit" : "#i-trash");
  svg.append(use);
  button.append(svg);
  button.addEventListener("click", () => action === "edit" ? openRecord(record) : openDelete(record));
  return button;
}

function renderTable() {
  const records = state.data.records;
  const pages = Math.max(1, Math.ceil(records.length / state.pageSize));
  state.page = Math.min(state.page, pages);
  const offset = (state.page - 1) * state.pageSize;
  const body = $("#records-body");
  body.replaceChildren();
  records.slice(offset, offset + state.pageSize).forEach((record) => {
    const row = document.createElement("tr");
    const categoryCell = document.createElement("td");
    const category = document.createElement("div");
    category.className = "category-cell";
    const categoryLabel = document.createElement("span");
    categoryLabel.append(textElement("strong", "", record.category), textElement("small", "", record.kind === "income" ? "收入" : "支出"));
    category.append(textElement("span", `category-symbol ${record.kind}`, symbols[record.category] || "记"), categoryLabel);
    categoryCell.append(category);
    const note = document.createElement("td");
    const noteText = textElement("div", "record-note", record.note || "—");
    noteText.title = record.note;
    note.append(noteText);
    const actions = document.createElement("td");
    const actionGroup = document.createElement("div");
    actionGroup.className = "row-actions";
    actionGroup.append(actionButton("edit", record), actionButton("delete", record));
    actions.append(actionGroup);
    row.append(categoryCell, note, textElement("td", "record-date", record.date.replaceAll("-", "/")), textElement("td", `record-amount ${record.kind}`, `${record.kind === "income" ? "+" : "−"}${money(record.amount_cents)}`), actions);
    body.append(row);
  });
  const empty = records.length === 0;
  const initial = state.data.total_count === 0;
  $("#empty-state").hidden = !empty;
  $("#empty-title").textContent = initial ? "从第一笔开始，让生活有数" : "没有找到符合条件的记录";
  $("#empty-description").textContent = initial ? "一顿午餐、一杯咖啡，或一份收入，都值得记下来。" : "试试调整日期、类别或金额，或者重置筛选。";
  $("#empty-add").hidden = !initial;
  $("#page-info").textContent = empty ? "共 0 笔记录" : `第 ${offset + 1}–${Math.min(offset + state.pageSize, records.length)} 笔，共 ${records.length} 笔`;
  $("#page-number").textContent = `${state.page} / ${pages}`;
  $("#previous-page").disabled = state.page <= 1;
  $("#next-page").disabled = state.page >= pages;
}

function setKind(kind) {
  recordForm.elements.kind.value = kind;
  $$("[data-kind]").forEach((button) => {
    const selected = button.dataset.kind === kind;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", selected);
  });
  fillCategories(recordForm.elements.category, kind);
}

function openRecord(record = null) {
  if (!state.data) return;
  recordForm.reset();
  state.editId = record?.id || null;
  setError("#record-error");
  $("#record-dialog-title").textContent = record ? "编辑记录" : "记一笔";
  setKind(record?.kind || "expense");
  recordForm.elements.date.value = record?.date || localDate();
  if (record) {
    recordForm.elements.amount.value = (record.amount_cents / 100).toFixed(2);
    recordForm.elements.category.value = record.category;
    recordForm.elements.note.value = record.note;
  }
  $("#record-dialog").showModal();
  recordForm.elements.amount.focus();
}

function openDelete(record) {
  state.deleteId = record.id;
  $("#delete-description").textContent = `${record.date} · ${record.category} · ${record.kind === "income" ? "收入" : "支出"} ¥${money(record.amount_cents)}${record.note ? ` · ${record.note}` : ""}`;
  setError("#delete-error");
  $("#delete-dialog").showModal();
}

function showLoadError(error) {
  $("#load-error span").textContent = error.message;
  $("#load-error").hidden = false;
  if (!state.data) {
    $("#empty-title").textContent = "暂时无法读取账本";
    $("#empty-description").textContent = "请检查本地服务是否启动，然后点击上方重试。";
  }
}

async function submitFilters() {
  try { await refresh(formFilters(), true); }
  catch (error) { setError("#filter-error", error.message); }
}

$("#today-label").textContent = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
$$(".add-record").forEach((button) => button.addEventListener("click", () => openRecord()));
$$(".close-dialog").forEach((button) => button.addEventListener("click", () => { if (!state.saving && !budgetState.saving) button.closest("dialog").close(); }));
$$("dialog").forEach((dialog) => dialog.addEventListener("cancel", (event) => { if (state.saving || budgetState.saving) event.preventDefault(); }));
$$("[data-kind]").forEach((button) => button.addEventListener("click", () => setKind(button.dataset.kind)));
$("#help-button").addEventListener("click", () => $("#help-dialog").showModal());
$("#previous-page").addEventListener("click", () => { state.page--; renderTable(); });
$("#next-page").addEventListener("click", () => { state.page++; renderTable(); });
$("#refresh-button").addEventListener("click", () => refresh().catch(showLoadError));
$("#retry-button").addEventListener("click", () => refresh().catch(showLoadError));

$("#budget-month").value = budgetState.month;
$("#budget-month").addEventListener("change", () => {
  if ($("#budget-month").value) loadBudget($("#budget-month").value);
});
$("#budget-edit").addEventListener("click", openBudgetDialog);
$("#budget-retry").addEventListener("click", () => loadBudget(budgetState.month));
$("#budget-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (budgetState.saving) return;
  budgetState.saving = true;
  const button = $("#budget-save");
  button.disabled = true;
  button.textContent = "保存中…";
  setError("#budget-dialog-error");
  try {
    const amount = $("#budget-amount-input").value;
    const data = await api(`/api/budgets/${budgetState.month}`, "PUT", { amount });
    budgetState.data = data;
    renderBudget();
    $("#budget-dialog").close();
    notify("预算已保存");
  } catch (error) {
    setError("#budget-dialog-error", error.message);
  } finally {
    budgetState.saving = false;
    button.disabled = false;
    button.textContent = "保存预算";
  }
});
filterForm.addEventListener("submit", (event) => { event.preventDefault(); submitFilters(); });
filterForm.elements.kind.addEventListener("change", () => { filterForm.elements.category.value = ""; fillCategories(filterForm.elements.category, filterForm.elements.kind.value, true); });
for (const name of ["start", "end"]) filterForm.elements[name].addEventListener("change", () => $$("[data-period]").forEach((button) => { button.classList.remove("selected"); button.setAttribute("aria-pressed", "false"); }));

$("#reset-filters").addEventListener("click", () => {
  filterForm.reset();
  fillCategories(filterForm.elements.category, "", true);
  $$("[data-period]").forEach((button) => { const selected = button.dataset.period === "all"; button.classList.toggle("selected", selected); button.setAttribute("aria-pressed", selected); });
  submitFilters();
});

$$("[data-period]").forEach((button) => button.addEventListener("click", () => {
  const now = new Date();
  let start = "";
  if (button.dataset.period === "month") start = localDate(new Date(now.getFullYear(), now.getMonth(), 1));
  if (button.dataset.period === "week") {
    const monday = new Date(now);
    monday.setDate(now.getDate() - (now.getDay() + 6) % 7);
    start = localDate(monday);
  }
  filterForm.elements.start.value = start;
  filterForm.elements.end.value = start ? localDate(now) : "";
  $$("[data-period]").forEach((item) => { const selected = item === button; item.classList.toggle("selected", selected); item.setAttribute("aria-pressed", selected); });
  if (filterForm.reportValidity()) submitFilters();
}));

recordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.saving) return;
  state.saving = true;
  const button = $("#save-record");
  button.disabled = true;
  button.textContent = "保存中…";
  setError("#record-error");
  try {
    const editing = Boolean(state.editId);
    await api(editing ? `/api/records/${state.editId}` : "/api/records", editing ? "PUT" : "POST", Object.fromEntries(new FormData(recordForm)));
    $("#record-dialog").close();
    try {
      await refresh(state.filters, true);
      notify(editing ? "记录已更新" : Object.keys(state.filters).length ? "记录已保存，列表仍按当前条件筛选" : "已记下这一笔");
    } catch (error) { showLoadError(error); notify("记录已保存，但列表刷新失败，请重试刷新"); }
  } catch (error) { setError("#record-error", error.message); }
  finally { state.saving = false; button.disabled = false; button.textContent = "保存记录"; }
});

$("#confirm-delete").addEventListener("click", async () => {
  if (state.saving) return;
  state.saving = true;
  $("#confirm-delete").disabled = true;
  setError("#delete-error");
  try {
    await api(`/api/records/${state.deleteId}`, "DELETE");
    $("#delete-dialog").close();
    try { await refresh(); notify("记录已删除"); }
    catch (error) { showLoadError(error); notify("记录已删除，但列表刷新失败，请重试刷新"); }
  } catch (error) { setError("#delete-error", error.message); }
  finally { state.saving = false; $("#confirm-delete").disabled = false; }
});

$$(".nav-link").forEach((link) => link.addEventListener("click", () => { $$(".nav-link").forEach((item) => item.classList.toggle("active", item === link)); }));
refresh().catch(showLoadError);

/* Interface language translations (L3) for DROPs renderer. */
'use strict';

const UI_STRINGS = {
  en: {
    sessions: 'Sessions',
    explorer: 'Explorer',
    scm: 'Source control',
    filterSessions: 'Filter sessions…',
    filterFiles: 'Filter files…',
    paletteHint: 'Search or run a command',
    askPlaceholder: 'Ask DROPs to build, fix or explain something',
    hint: 'Enter to send · Shift+Enter new line · messages sent while the agent works steer it live',
    tabPlan: 'Overview',
    tabTasks: 'Tasks',
    tabChanges: 'Changes',
    tabProcesses: 'Processes',
    tabBrowser: 'Browser',
    tabUsage: 'Usage',
    modePlan: 'Plan',
    modeAsk: 'Ask',
    modeAutoEdit: 'Auto-edit',
    modeYolo: 'Full auto',
  },
  bn: {
    sessions: 'সেশনসমূহ',
    explorer: 'ফাইল এক্সপ্লোরার',
    scm: 'সোর্স কন্ট্রোল',
    filterSessions: 'সেশন খুঁজুন…',
    filterFiles: 'ফাইল খুঁজুন…',
    paletteHint: 'কমান্ড খুঁজুন বা চালান',
    askPlaceholder: 'DROPs-কে কিছু তৈরি, ফিক্স বা ব্যাখ্যা করতে বলুন',
    hint: 'Enter দিয়ে পাঠান · Shift+Enter নতুন লাইন · এজেন্ট চলার সময় মেসেজ দিলে সাথে সাথে দিক নির্দেশনা নেয়',
    tabPlan: 'সারসংক্ষেপ',
    tabTasks: 'টাস্ক',
    tabChanges: 'পরিবর্তন',
    tabProcesses: 'প্রসেস',
    tabBrowser: 'ব্রাউজার',
    tabUsage: 'ব্যবহার',
    modePlan: 'প্ল্যান',
    modeAsk: 'জিজ্ঞাসা',
    modeAutoEdit: 'অটো-এডিট',
    modeYolo: 'ফুল অটো',
  },
};

function applyI18n(lang) {
  const dict = UI_STRINGS[lang] || UI_STRINGS.en;
  document.documentElement.lang = lang === 'bn' ? 'bn' : 'en';
  const setText = (sel, txt) => { const el = document.querySelector(sel); if (el && txt) el.textContent = txt; };
  const setAttr = (sel, attr, txt) => { const el = document.querySelector(sel); if (el && txt) el.setAttribute(attr, txt); };
  setText('[data-side="sessions"] .pane-head .grow', dict.sessions);
  setText('#explorerTitle', dict.explorer);
  setText('[data-side="scm"] .pane-head .grow', dict.scm);
  setAttr('#sessionSearch', 'placeholder', dict.filterSessions);
  setAttr('#treeSearch', 'placeholder', dict.filterFiles);
  setText('#paletteBtn .muted', dict.paletteHint);
  setAttr('#input', 'placeholder', dict.askPlaceholder);
  setText('#hint', dict.hint);
  // Each tab is an icon plus a label (built in boot.js): change only the label and the tooltip, so the
  // icon and the badge stay.
  const setTabLabel = (tab, label) => {
    const b = document.querySelector(`#inspTabs button[data-tab="${tab}"]`);
    if (!b || !label) return;
    const lbl = b.querySelector('.lbl');
    if (lbl) lbl.textContent = label;
    b.title = label; b.setAttribute('aria-label', label);
  };
  setTabLabel('plan', dict.tabPlan);
  setTabLabel('tasks', dict.tabTasks);
  setTabLabel('changes', dict.tabChanges);
  setTabLabel('terminal', dict.tabProcesses);
  setTabLabel('browser', dict.tabBrowser);
  setTabLabel('usage', dict.tabUsage);
  setText('#modeSeg button[data-mode="plan"]', dict.modePlan);
  setText('#modeSeg button[data-mode="ask"]', dict.modeAsk);
  setText('#modeSeg button[data-mode="auto-edit"]', dict.modeAutoEdit);
  setText('#modeSeg button[data-mode="yolo"]', dict.modeYolo);
}

window.UI_STRINGS = UI_STRINGS;
window.applyI18n = applyI18n;

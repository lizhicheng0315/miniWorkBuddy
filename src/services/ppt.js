'use strict';

/**
 * PPT 助理服务（借鉴 ppt-master 方法论）：
 *   阶段1 ppt_outline  → 生成大纲 → ⛔ 用户确认
 *   阶段2 ppt_design   → 设计规格（主题/版式）→ ⛔ 用户确认
 *   阶段3 ppt_generate → pptxgenjs 生成原生 .pptx → 下载
 *   任意阶段 ppt_edit_page / ppt_edit_outline 微调草稿
 *
 * 会话草稿存内存 Map（userId → draft），服务重启即清（可接受：PPT 是短会话任务）
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const logger = require('../logger');

const THEMES = {
  business_blue: {
    label: '商务蓝',
    bg: 'FFFFFF', title: '1F3864', text: '333333', accent: '2563EB',
    sub: '5B7BB4', light: 'EAF1FB',
  },
  minimal_white: {
    label: '极简白',
    bg: 'FFFFFF', title: '111111', text: '444444', accent: '666666',
    sub: '999999', light: 'F5F5F5',
  },
  tech_dark: {
    label: '科技黑',
    bg: '0F172A', title: 'F8FAFC', text: 'CBD5E1', accent: '38BDF8',
    sub: '64748B', light: '1E293B',
  },
  warm_orange: {
    label: '活力橙',
    bg: 'FFFDF7', title: '7C2D12', text: '44403C', accent: 'EA580C',
    sub: 'B45309', light: 'FEF3E7',
  },
};

/** userId → draft */
const drafts = new Map();
/** exportId → { filePath, fileName } 已导出文件登记（供下载路由取） */
const exportsMap = new Map();

function getDraft(userId) {
  return drafts.get(userId) || null;
}

function setStage(userId, stage) {
  const d = drafts.get(userId);
  if (d) d.stage = stage;
}

/**
 * 阶段1：由 LLM 结构化输出生成大纲草稿
 * @param {string} topic
 * @param {{pageCount?:number, audience?:string}} opts
 */
function createOutline(userId, topic, outlineJson) {
  // outlineJson 来自 LLM：{ title, subtitle, pages:[{title, bullets:[], note}] }
  const draft = {
    stage: 'outline_pending', // 待用户确认大纲
    topic,
    title: outlineJson.title || topic,
    subtitle: outlineJson.subtitle || '',
    pages: (outlineJson.pages || []).map((p, i) => ({
      no: i + 1,
      title: p.title || `第${i + 1}页`,
      bullets: Array.isArray(p.bullets) ? p.bullets : [],
      note: p.note || '',
    })),
    theme: 'business_blue',
    createdAt: new Date().toISOString(),
  };
  drafts.set(userId, draft);
  return draft;
}

/** 编辑某一页 */
function editPage(userId, pageNo, patch) {
  const d = getDraft(userId);
  if (!d) return null;
  const page = d.pages.find((p) => p.no === pageNo);
  if (!page) return null;
  if (patch.title != null) page.title = String(patch.title).slice(0, 100);
  if (Array.isArray(patch.bullets)) page.bullets = patch.bullets.map((b) => String(b).slice(0, 200));
  if (patch.note != null) page.note = String(patch.note).slice(0, 300);
  return page;
}

/** 追加一页 */
function addPage(userId, afterNo, pageData) {
  const d = getDraft(userId);
  if (!d) return null;
  const idx = d.pages.findIndex((p) => p.no === afterNo);
  const newPage = {
    no: 0,
    title: (pageData && pageData.title) || '新页面',
    bullets: (pageData && pageData.bullets) || [],
    note: (pageData && pageData.note) || '',
  };
  if (idx >= 0) d.pages.splice(idx + 1, 0, newPage);
  else d.pages.push(newPage);
  d.pages.forEach((p, i) => (p.no = i + 1));
  return newPage;
}

/** 删除一页 */
function removePage(userId, pageNo) {
  const d = getDraft(userId);
  if (!d) return false;
  const before = d.pages.length;
  d.pages = d.pages.filter((p) => p.no !== pageNo);
  d.pages.forEach((p, i) => (p.no = i + 1));
  return d.pages.length < before;
}

/** 设置主题（进入设计阶段） */
function setTheme(userId, themeKey) {
  const d = getDraft(userId);
  if (!d) return null;
  if (!THEMES[themeKey]) return null;
  d.theme = themeKey;
  return THEMES[themeKey];
}

/** 大纲的可读文本（给用户确认用） */
function outlineToText(draft) {
  const lines = [`📑 《${draft.title}》大纲（${draft.pages.length} 页）`];
  if (draft.subtitle) lines.push(`   ${draft.subtitle}`);
  lines.push('');
  for (const p of draft.pages) {
    lines.push(`${p.no}. ${p.title}`);
    for (const b of p.bullets.slice(0, 4)) lines.push(`   • ${b}`);
    if (p.bullets.length > 4) lines.push(`   • …共${p.bullets.length}条`);
  }
  return lines.join('\n');
}

/**
 * 阶段3：pptxgenjs 生成原生 PPTX
 * @returns {{ok:boolean, filePath?, fileName?, error?}}
 */
async function generatePptx(userId) {
  const d = getDraft(userId);
  if (!d) return { ok: false, error: '没有进行中的 PPT 草稿' };
  if (!d.pages.length) return { ok: false, error: '草稿没有任何页面' };
  const theme = THEMES[d.theme] || THEMES.business_blue;

  let PptxGenJS;
  try {
    PptxGenJS = require('pptxgenjs');
  } catch (e) {
    return { ok: false, error: '缺少依赖 pptxgenjs，请在项目目录执行 npm install pptxgenjs' };
  }

  try {
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: 'W16x9', width: 13.333, height: 7.5 });
    pptx.layout = 'W16x9';
    pptx.author = 'WorkBuddy';
    pptx.title = d.title;

    // ===== 封面页 =====
    const cover = pptx.addSlide();
    cover.background = { color: theme.bg };
    cover.addShape('rect', { x: 0, y: 4.9, w: 13.333, h: 2.6, fill: { color: theme.light } });
    cover.addText(d.title, {
      x: 0.8, y: 2.4, w: 11.7, h: 1.4, fontSize: 40, bold: true,
      color: theme.title, fontFace: '微软雅黑',
    });
    if (d.subtitle) {
      cover.addText(d.subtitle, {
        x: 0.85, y: 3.75, w: 11.6, h: 0.6, fontSize: 18, color: theme.sub, fontFace: '微软雅黑',
      });
    }
    cover.addText(new Date().toLocaleDateString('zh-CN'), {
      x: 0.85, y: 5.4, w: 5, h: 0.4, fontSize: 13, color: theme.accent, fontFace: '微软雅黑',
    });

    // ===== 内容页 =====
    for (let i = 0; i < d.pages.length; i++) {
      const p = d.pages[i];
      const slide = pptx.addSlide();
      slide.background = { color: theme.bg };
      // 标题条
      slide.addShape('rect', { x: 0, y: 0, w: 13.333, h: 1.05, fill: { color: theme.light } });
      slide.addShape('rect', { x: 0, y: 0, w: 0.14, h: 1.05, fill: { color: theme.accent } });
      slide.addText(p.title, {
        x: 0.45, y: 0.16, w: 11.5, h: 0.72, fontSize: 24, bold: true,
        color: theme.title, fontFace: '微软雅黑',
      });
      // 页码
      slide.addText(`${p.no} / ${d.pages.length}`, {
        x: 11.8, y: 7.02, w: 1.3, h: 0.35, fontSize: 10, color: theme.sub, align: 'right', fontFace: '微软雅黑',
      });
      // 要点列表
      const items = (p.bullets.length ? p.bullets : ['（待补充内容）']).slice(0, 8);
      const rows = items.map((b) => ({
        text: b,
        options: { bullet: { characterCode: '25AA' }, color: theme.text, fontSize: 17, breakLine: true, paraSpaceAfter: 10 },
      }));
      slide.addText(rows, {
        x: 0.9, y: 1.55, w: 11.5, h: 4.6, valign: 'top', fontFace: '微软雅黑',
      });
      // 底部强调线
      slide.addShape('rect', { x: 0.9, y: 6.55, w: 2.2, h: 0.06, fill: { color: theme.accent } });
    }

    // ===== 结尾页 =====
    const end = pptx.addSlide();
    end.background = { color: theme.bg };
    end.addText('谢谢观看', {
      x: 0, y: 2.9, w: 13.333, h: 1.2, fontSize: 44, bold: true,
      color: theme.title, align: 'center', fontFace: '微软雅黑',
    });
    end.addText(d.title, {
      x: 0, y: 4.15, w: 13.333, h: 0.5, fontSize: 15, color: theme.sub, align: 'center', fontFace: '微软雅黑',
    });

    // 输出
    const outDir = path.resolve(__dirname, '../../data/ppt');
    fs.mkdirSync(outDir, { recursive: true });
    const safeName = (d.title || 'presentation').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
    const fileName = `${safeName}_${Date.now()}.pptx`;
    const filePath = path.join(outDir, fileName);
    await pptx.writeFile({ fileName: filePath });

    const exportId = crypto.randomBytes(8).toString('hex');
    exportsMap.set(exportId, { filePath, fileName });
    d.stage = 'done';
    d.lastExportId = exportId;
    const downloadTicket = issueTicket(exportId, userId);
    logger.info(`ppt exported: ${fileName} (${d.pages.length} pages, theme=${d.theme})`);
    return { ok: true, exportId, fileName, pageCount: d.pages.length, downloadTicket };
  } catch (e) {
    logger.error('ppt generate failed:', e.message);
    return { ok: false, error: e.message };
  }
}

function getExport(exportId) {
  return exportsMap.get(String(exportId)) || null;
}

// ===== 下载票据（<a href> 无法带 Authorization 头，改用短时签名票据）=====
const downloadTickets = new Map(); // ticket → { exportId, userId, expires }

/** 签发 10 分钟有效的下载票据 */
function issueTicket(exportId, userId) {
  const ticket = crypto.randomBytes(16).toString('hex');
  downloadTickets.set(ticket, { exportId, userId, expires: Date.now() + 10 * 60 * 1000 });
  // 顺带清理过期票据
  for (const [k, v] of downloadTickets) if (v.expires < Date.now()) downloadTickets.delete(k);
  return ticket;
}

/** 校验票据：有效返回导出记录，否则 null */
function verifyTicket(ticket) {
  const rec = downloadTickets.get(String(ticket));
  if (!rec) return null;
  if (rec.expires < Date.now()) { downloadTickets.delete(ticket); return null; }
  return getExport(rec.exportId);
}

/** 用户确认大纲 → 进入设计阶段 */
function confirmOutline(userId) {
  const d = getDraft(userId);
  if (!d || !d.pages.length) return null;
  d.stage = 'design_pending';
  return d;
}

module.exports = {
  THEMES,
  getDraft, createOutline, editPage, addPage, removePage, setTheme,
  outlineToText, generatePptx, getExport, confirmOutline, setStage,
  issueTicket, verifyTicket,
};

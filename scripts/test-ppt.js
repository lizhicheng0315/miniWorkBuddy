// PPT 服务端到端测试：大纲 → 编辑 → 确认 → 真实生成 pptx
process.env.AUTH_ENABLED = 'false';
const fs = require('fs');
const path = require('path');
const ppt = require('../src/services/ppt');

(async () => {
  const uid = 999;
  // 1. 造大纲（模拟 LLM 输出）
  const draft = ppt.createOutline(uid, '2026 Q3 工作汇报', {
    title: '2026 Q3 工作汇报',
    subtitle: '第三季度成果与 Q4 展望',
    pages: [
      { title: '背景与目标', bullets: ['Q3 核心目标回顾', '关键指标定义'], note: '' },
      { title: '重点项目进展', bullets: ['项目A：已上线', '项目B：内测中', '项目C：设计中'], note: '强调 A 的数据' },
      { title: '数据亮点', bullets: ['用户增长 35%', '收入增长 28%', 'NPS 提升 12 分'], note: '' },
      { title: '问题与反思', bullets: ['跨部门协作效率', '需求变更频繁'], note: '' },
      { title: 'Q4 计划', bullets: ['三大战役', '资源需求'], note: '' },
    ],
  });
  console.log('✅ 大纲创建:', draft.title, '| 页数:', draft.pages.length, '| 阶段:', draft.stage);

  // 2. 大纲文本预览
  console.log('---');
  console.log(ppt.outlineToText(draft).split('\n').slice(0, 8).join('\n'), '...');

  // 3. 编辑一页
  ppt.editPage(uid, 2, { title: '重点项目进展（更新）', bullets: ['项目A：上线并达标', '项目B：公测'] });
  console.log('\n✅ 编辑第2页:', draft.pages[1].title);

  // 4. 确认大纲 + 选主题
  ppt.confirmOutline(uid);
  ppt.setTheme(uid, 'business_blue');
  console.log('✅ 阶段推进:', ppt.getDraft(uid).stage);

  // 5. 真实生成
  const r = await ppt.generatePptx(uid);
  if (!r.ok) { console.error('❌ 导出失败:', r.error); process.exit(1); }
  const fp = ppt.getExport(r.exportId).filePath;
  const size = fs.statSync(fp).size;
  console.log(`\n✅ PPTX 生成成功！`);
  console.log('   文件:', fp);
  console.log('   大小:', (size / 1024).toFixed(1), 'KB | 页数:', r.pageCount);

  // 验证是合法 zip（pptx = zip 包）
  const head = fs.readFileSync(fp).subarray(0, 2).toString();
  console.log('   ZIP 头校验:', head === 'PK' ? '✅ 合法 OOXML' : '❌ 异常');

  // 清理测试文件
  setTimeout(() => { try { fs.unlinkSync(fp); } catch (_) {} }, 3000);
})().catch((e) => { console.error('ERR', e); process.exit(1); });

// One-off QA: render v3's role prototypes + previously-broken long headings via
// the SAME renderer generation uses, to confirm titles no longer overflow.
const fs = require('fs');
const { loadProfile, loadTheme } = require('../src/descriptor');
const { renderTemplateSlide } = require('../src/template-renderer');

const id = 'u-38c84a37b55e8d0d';
const profile = loadProfile(id);
const theme = loadTheme(id);
const dir = theme._dir;
const R = (role, section, i) => ({ role, title: section.heading, svg: renderTemplateSlide({ profile, templateDir: dir, section, role, index: i, total: 6, imageData: null }) });
const slides = [
  R('cover', { heading: theme.name || '演示标题', body: '副标题示例，一句话点明主旨\n署名 · 日期' }, 0),
  R('section', { heading: '第一章 示例章节', body: '> 本章导语示例', sectionNo: '01' }, 1),
  R('content', { heading: '示例页面标题', body: '- 要点一：一句话说明\n- 要点二：一句话说明\n- 要点三：一句话说明\n> 一句话结论' }, 2),
  R('content', { heading: '经典传承与人生启迪', body: '- 古今传诵：写尽登高望远\n- 哲思之光：欲穷千里目\n- 精神共鸣：昂扬向上\n> 更上一层楼' }, 3),
  R('content', { heading: '王之涣：盛世诗坛的登高者', body: '- 生卒：约688—742\n- 交游：与王昌龄高适唱和\n- 代表作：《登鹳雀楼》' }, 4),
  R('closing', { heading: '谢谢观看', body: '> 谢谢观看' }, 5),
];
fs.writeFileSync('.tmp-v3-verify.json', JSON.stringify({ title: 'v3 verify', slides }));
console.log('rendered', slides.filter((s) => s.svg).length, '/', slides.length, 'slides');

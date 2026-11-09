// 매주 GitHub Actions가 실행하는 스크립트
// 1) 공개 데이터셋에서 새 회차를 받아 index.html 안의 데이터에 추가
// 2) index.html의 추천 엔진으로 다음 회차 5게임을 계산해 README.md와 picks-log.csv에 기록
// 3) 기록된 지난 추천에 실제 결과(일치 개수, 등수)를 채움
import { readFile, writeFile, appendFile, access } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const FEED = (process.env.LOTTO_FEED || 'https://smok95.github.io/lotto/results/').replace(/\/?$/, '/');
const OPEN = '<script id="lotto-data" type="application/json">';
const CLOSE = '</script>';
const ENGINE_MARK = '/* 로또 6/45 분석·추천 엔진';
const LETTERS = ['A', 'B', 'C', 'D', 'E'];
const LOG_HEAD = '대상회차,추첨일,기록시각(KST),게임,번호1,번호2,번호3,번호4,번호5,번호6,일치,결과';

const file = (name) => new URL(name, ROOT);
const exists = async (name) => access(file(name)).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { headers: { 'cache-control': 'no-cache' } });
      if (res.status === 404) return null;
      if (res.ok) return await res.json();
      console.log(`  ${url} → HTTP ${res.status} (재시도 ${attempt}/3)`);
    } catch (err) {
      console.log(`  ${url} → ${err.message} (재시도 ${attempt}/3)`);
    }
    await sleep(4000 * attempt);
  }
  throw new Error('데이터를 받지 못했습니다: ' + url);
}

function toRow(o) {
  const dv = Array.isArray(o.divisions) ? o.divisions : [];
  const winners = [0, 1, 2, 3, 4].map((k) => (dv[k] && dv[k].winners) || 0);
  const prizes = [0, 1, 2, 3, 4].map((k) => (dv[k] && dv[k].prize) || 0);
  const nums = Array.isArray(o.numbers) ? [...o.numbers].sort((a, b) => a - b) : [];
  return [o.draw_no, String(o.date || '').slice(0, 10), ...nums, o.bonus_no, o.total_sales_amount || 0, ...winners, ...prizes];
}

function isValid(row, expectNo) {
  const nums = row.slice(2, 8), bonus = row[8];
  return row.length === 20 && row[0] === expectNo && /^\d{4}-\d{2}-\d{2}$/.test(row[1]) &&
    nums.length === 6 && new Set(nums).size === 6 && nums.every((x) => Number.isInteger(x) && x >= 1 && x <= 45) &&
    Number.isInteger(bonus) && bonus >= 1 && bonus <= 45 && !nums.includes(bonus);
}

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function loadEngine(html) {
  const start = html.indexOf(ENGINE_MARK);
  const end = html.indexOf(CLOSE, start);
  if (start < 0 || end < 0) throw new Error('index.html에서 추천 엔진을 찾지 못했습니다.');
  const module = { exports: {} };
  new Function('module', 'exports', html.slice(start, end))(module, module.exports);
  return module.exports;
}

function siteUrl() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) return '';
  const [owner, name] = repo.split('/');
  return name.toLowerCase() === owner.toLowerCase() + '.github.io' ? `https://${name}/` : `https://${owner}.github.io/${name}/`;
}

// ---------- 1. 새 회차 반영 ----------
const html0 = await readFile(file('index.html'), 'utf8');
const i = html0.indexOf(OPEN), j = html0.indexOf(CLOSE, i + OPEN.length);
if (i < 0 || j < 0) throw new Error('index.html에서 데이터 블록을 찾지 못했습니다.');
const rows = JSON.parse(html0.slice(i + OPEN.length, j));
const before = rows[rows.length - 1][0];

const latest = await getJSON(FEED + 'latest.json');
if (!latest || !Number.isInteger(latest.draw_no)) throw new Error('latest.json 형식이 예상과 다릅니다.');
console.log(`파일 데이터: 1~${before}회 / 공개된 최신: ${latest.draw_no}회`);

for (let n = before + 1; n <= latest.draw_no; n++) {
  const obj = n === latest.draw_no ? latest : await getJSON(FEED + n + '.json');
  if (!obj) { console.log(`${n}회 데이터가 아직 없어 여기서 멈춥니다.`); break; }
  const row = toRow(obj);
  if (!isValid(row, n)) throw new Error(`${n}회 데이터가 올바르지 않습니다: ${JSON.stringify(obj)}`);
  rows.push(row);
  console.log(`  + ${n}회 ${row[1]}  ${row.slice(2, 8).join(' ')} + ${row[8]}`);
}
const last = rows[rows.length - 1][0];
let html = html0;
if (last > before) {
  html = html0.slice(0, i + OPEN.length) + JSON.stringify(rows) + html0.slice(j);
  await writeFile(file('index.html'), html);
}

// ---------- 2. 이번 주 추천 계산 ----------
const E = loadEngine(html);
const data = E.parseRows(rows);
const A = E.analyze(data);
const rec = E.recommend(A, 0);
const target = rec.target, drawDate = addDays(data[data.length - 1].date, 7);
const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);

// ---------- 3. 추천 기록(picks-log.csv) ----------
const logText = (await exists('picks-log.csv')) ? await readFile(file('picks-log.csv'), 'utf8') : '';
let log = logText.trim() ? logText.trim().split(/\r?\n/) : [LOG_HEAD];
if (log[0].replace(/^﻿/, '') !== LOG_HEAD) log.unshift(LOG_HEAD);
const byNo = new Map(data.map((r) => [r.no, r]));
log = log.map((line, idx) => { // 결과가 나온 지난 추천 채우기
  if (idx === 0) return line;
  const c = line.split(',');
  const r = byNo.get(Number(c[0]));
  if (!r || c[10]) return line;
  const nums = c.slice(4, 10).map(Number), rank = E.prizeRank(nums, r);
  c[10] = String(E.overlap(nums, r.nums));
  c[11] = rank ? rank + '등' : '낙첨';
  return c.join(',');
});
if (!log.some((line, idx) => idx > 0 && line.split(',')[0] === String(target))) {
  rec.sets.forEach((s, k) => log.push([target, drawDate, stamp, LETTERS[k], ...s.nums, '', ''].join(',')));
}
const newLog = '﻿' + log.map((l) => l.replace(/^﻿/, '')).join('\n') + '\n';

// ---------- 4. README 추천 칸 ----------
const P = A.pop;
const prevRows = log.slice(1).map((l) => l.split(',')).filter((c) => Number(c[0]) === last && c[10] !== '');
const lines = [
  `## ${target}회 추천 5게임`,
  '',
  `${drawDate} 추첨, 1~${last}회 데이터로 계산 (자동 업데이트: ${stamp} KST)` + (siteUrl() ? `  \n사이트: ${siteUrl()}` : ''),
  '',
  '| 게임 | 번호 | 합계 | 홀:짝 | 저:고 | 1등 시 함께 당첨 예상 |',
  '|---|---|---|---|---|---|',
  ...rec.sets.map((s, k) => `| ${LETTERS[k]} | ${s.nums.join(' ')} | ${s.f.sum} | ${s.f.odd}:${s.f.even} | ${s.f.low}:${s.f.high} | ${P ? (P.lambda * s.f.m).toFixed(1) + '명' : '-'} |`),
  '',
  P ? `평균적인 조합이면 1등 시 약 ${P.lambda.toFixed(1)}명이 함께 당첨됩니다. 모든 조합의 1등 확률은 1/8,145,060으로 같습니다.` : '모든 조합의 1등 확률은 1/8,145,060으로 같습니다.',
];
if (prevRows.length) {
  const r = byNo.get(last);
  lines.push('', `지난주(${last}회) 당첨번호 ${r.nums.join(' ')} + ${r.bonus}: ` + prevRows.map((c) => `${c[3]} ${c[10]}개(${c[11]})`).join(', '));
}
const block = '<!-- PICKS:START -->\n' + lines.join('\n') + '\n<!-- PICKS:END -->';
const readme = (await exists('README.md')) ? await readFile(file('README.md'), 'utf8') : '# 로또 6/45 주간 추천\n\n<!-- PICKS:START -->\n<!-- PICKS:END -->\n';
const newReadme = /<!-- PICKS:START -->[\s\S]*?<!-- PICKS:END -->/.test(readme)
  ? readme.replace(/<!-- PICKS:START -->[\s\S]*?<!-- PICKS:END -->/, block)
  : readme.trimEnd() + '\n\n' + block + '\n';

// 날짜·시각만 바뀐 경우는 저장하지 않음 (불필요한 커밋 방지)
const strip = (s) => s.replace(/\(자동 업데이트: [^)]*\)/, '');
const readmeChanged = strip(newReadme) !== strip(readme);
const logChanged = newLog.replace(/^﻿/, '') !== logText.replace(/^﻿/, '');
if (readmeChanged) await writeFile(file('README.md'), newReadme);
if (logChanged) await writeFile(file('picks-log.csv'), newLog);

const changed = last > before || readmeChanged || logChanged;
console.log(`${target}회 추천: ` + rec.sets.map((s, k) => LETTERS[k] + ' ' + s.nums.join(' ')).join(' / '));
console.log(changed ? `저장할 변경 있음 (데이터 ${last > before ? before + 1 + '~' + last + '회 추가' : '변화 없음'})` : '변경 없음');
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\nlast=${last}\ntarget=${target}\n`);

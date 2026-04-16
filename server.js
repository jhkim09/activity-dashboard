const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const TALLY_API_KEY = process.env.TALLY_API_KEY;
const FORM_ID = 'ob9Bkx';
const MAKE_ALERT_WEBHOOK_URL = process.env.MAKE_ALERT_WEBHOOK_URL;

// 칸반보드 비밀번호
const KANBAN_PASSWORD = process.env.KANBAN_PASSWORD || 'rkdska1';

// 칸반 데이터 저장소 (메모리 + 파일)
// Render Disk 사용 시 /data, 로컬 개발 시 현재 폴더
const KANBAN_FILE = process.env.NODE_ENV === 'production'
  ? '/data/kanban-data.json'
  : path.join(__dirname, 'kanban-data.json');
let kanbanData = {
  columns: [
    { id: 'general', title: '📢 공지사항', cards: [] }
  ]
};

// 파일에서 칸반 데이터 로드
function loadKanbanData() {
  try {
    if (fs.existsSync(KANBAN_FILE)) {
      const data = fs.readFileSync(KANBAN_FILE, 'utf8');
      const loadedData = JSON.parse(data);

      // 마이그레이션: 기존 3개 컬럼 → 1개 컬럼으로 변환
      if (loadedData.columns && loadedData.columns.length > 1) {
        const generalColumn = loadedData.columns.find(c => c.id === 'general');
        if (generalColumn) {
          kanbanData = {
            columns: [{ id: 'general', title: '📢 공지사항', cards: generalColumn.cards || [] }]
          };
        }
        saveKanbanData(); // 마이그레이션 후 저장
        console.log('Kanban data migrated to single column');
      } else {
        kanbanData = loadedData;
      }
      console.log('Kanban data loaded from file');
    }
  } catch (error) {
    console.error('Error loading kanban data:', error);
  }
}

// 파일에 칸반 데이터 저장
function saveKanbanData() {
  try {
    fs.writeFileSync(KANBAN_FILE, JSON.stringify(kanbanData, null, 2));
    console.log('Kanban data saved to file');
  } catch (error) {
    console.error('Error saving kanban data:', error);
  }
}

// 서버 시작시 데이터 로드
loadKanbanData();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 질문 ID를 라벨로 매핑
let questionMap = {};

// ============ 데이터 보정 설정 ============
// Tally에서 수정이 안 되는 잘못된 데이터를 여기서 보정
const DATA_CORRECTIONS = [
  {
    // 2025-12-06 21:01 경 제출된 데이터
    match: {
      submittedAt: '2025-12-06',  // 날짜 (YYYY-MM-DD), 생략하면 전체 적용
      wrongValue: 337693          // 잘못 입력된 사번
    },
    correct: {
      field: '본인 사번',
      value: 327693               // 올바른 사번
    }
  },
  {
    // 429592는 459595의 오타 (같은 사람)
    match: {
      wrongValue: 429592
    },
    correct: {
      field: '본인 사번',
      value: 459595
    }
  },
  {
    // 459592는 459595의 오타 (같은 사람)
    match: {
      wrongValue: 459592
    },
    correct: {
      field: '본인 사번',
      value: 459595
    }
  },
  {
    // 81730은 84730의 오타
    match: {
      wrongValue: 81730
    },
    correct: {
      field: '본인 사번',
      value: 84730
    }
  },
  {
    // 54730은 84730의 오타
    match: {
      wrongValue: 54730
    },
    correct: {
      field: '본인 사번',
      value: 84730
    }
  },
  {
    // 8206880은 206880의 오타
    match: {
      wrongValue: 8206880
    },
    correct: {
      field: '본인 사번',
      value: 206880
    }
  },
  {
    // 42589는 42591의 오타
    match: {
      wrongValue: 42589
    },
    correct: {
      field: '본인 사번',
      value: 42591
    }
  },
  {
    // 32219는 322915의 오타
    match: {
      wrongValue: 32219
    },
    correct: {
      field: '본인 사번',
      value: 322915
    }
  }
];

// 제외할 사번 목록 (정체불명 등)
const EXCLUDED_MEMBERS = [
  337693,   // 327693 오타
  429592,   // 459595 오타
  459592,   // 459595 오타
  81730,    // 84730 오타
  54730,    // 84730 오타
  88,       // 테스트 입력
  2,        // 테스트 입력
  112,      // 테스트 입력
  1234,     // 테스트 입력
  42589,    // 42591 오타
  32219     // 322915 오타
];

// ============ 유효 사번 + 이름 목록 ============
// 사번 → 이름 매핑. 여기 없는 사번이 제출되면 make.com으로 알람 발송
const MEMBER_NAMES = {
  42591:  '심종태',
  64089:  '김지훈',
  84730:  '김희경',
  206880: '지영미',
  209475: '강우현',
  251515: '전승범',
  295284: '조헌우',
  322915: '정성민',
  327693: '윤연주',
  342394: '김평안',
  377773: '강대훈',
  391035: '박성은',
  412798: '이은희',
  459595: '박상은'
};
const VALID_MEMBERS = Object.keys(MEMBER_NAMES).map(Number);

// ============ 지점별 그룹 ============
const BRANCHES = {
  nice:     { name: '나이스지점',   members: [42591] },
  alpha:    { name: '알파평택지점', members: [64089, 84730, 206880, 295284, 327693, 412798, 459595] },
  infinity: { name: '인피니티지점', members: [209475, 251515, 322915, 342394, 377773, 391035] }
};

// 사번 → 지점 키 역매핑
const MEMBER_BRANCH = {};
for (const [key, branch] of Object.entries(BRANCHES)) {
  for (const id of branch.members) {
    MEMBER_BRANCH[id] = key;
  }
}

function getMemberName(memberId) {
  return MEMBER_NAMES[memberId] || String(memberId);
}

// 미등록 사번 알람 중복 방지용 파일
const UNKNOWN_ALERT_FILE = process.env.NODE_ENV === 'production'
  ? '/data/unknown-alerts.json'
  : path.join(__dirname, 'unknown-alerts.json');

// 이미 알람 보낸 사번 목록 (메모리)
let alertedUnknownIds = new Set();

function loadAlertedIds() {
  try {
    if (fs.existsSync(UNKNOWN_ALERT_FILE)) {
      const ids = JSON.parse(fs.readFileSync(UNKNOWN_ALERT_FILE, 'utf8'));
      alertedUnknownIds = new Set(ids);
      console.log(`[사번 알람] 기존 알람 이력 ${alertedUnknownIds.size}건 로드`);
    }
  } catch (e) {
    console.error('[사번 알람] 이력 파일 로드 실패:', e.message);
  }
}

function saveAlertedIds() {
  try {
    fs.writeFileSync(UNKNOWN_ALERT_FILE, JSON.stringify([...alertedUnknownIds], null, 2));
  } catch (e) {
    console.error('[사번 알람] 이력 파일 저장 실패:', e.message);
  }
}

async function sendUnknownMemberAlert(memberId, submittedAt) {
  if (!MAKE_ALERT_WEBHOOK_URL) return;
  if (alertedUnknownIds.has(memberId)) return;

  try {
    await fetch(MAKE_ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'unknown_member',
        status: '미등록',
        memberId,
        memberName: getMemberName(memberId),
        submittedAt
      })
    });

    alertedUnknownIds.add(memberId);
    saveAlertedIds();
    console.log(`[사번 알람] 미등록 사번 ${memberId} 알람 발송 완료`);
  } catch (e) {
    console.error(`[사번 알람] 웹훅 전송 실패 (${memberId}):`, e.message);
  }
}

// 등록 사번 입력 알람
async function sendMemberSubmitAlert(memberId, submittedAt) {
  if (!MAKE_ALERT_WEBHOOK_URL) return;

  try {
    await fetch(MAKE_ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'member_submit',
        status: '등록',
        memberId,
        memberName: getMemberName(memberId),
        submittedAt
      })
    });
    console.log(`[사번 알람] 등록 사번 ${memberId} 입력 알람 발송`);
  } catch (e) {
    console.error(`[사번 알람] 등록 사번 웹훅 전송 실패 (${memberId}):`, e.message);
  }
}

loadAlertedIds();

// 데이터 보정 함수
function applyDataCorrections(submissions) {
  return submissions.map(sub => {
    const submittedDate = sub.submittedAt ? sub.submittedAt.substring(0, 10) : null;

    for (const correction of DATA_CORRECTIONS) {
      // 날짜 매칭 확인 (날짜가 지정된 경우에만)
      if (correction.match.submittedAt && submittedDate !== correction.match.submittedAt) continue;

      // 잘못된 값 찾기
      const questionId = Object.keys(questionMap).find(id =>
        questionMap[id] === correction.correct.field
      );
      if (!questionId) continue;

      const response = sub.responses?.find(r => r.questionId === questionId);
      if (response && response.answer === correction.match.wrongValue) {
        console.log(`[데이터 보정] ${submittedDate}: ${correction.match.wrongValue} → ${correction.correct.value}`);
        response.answer = correction.correct.value;
      }
    }

    return sub;
  });
}

// Tally API에서 모든 제출 데이터 가져오기
async function fetchAllSubmissions() {
  let allSubmissions = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const url = `https://api.tally.so/forms/${FORM_ID}/submissions?page=${page}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${TALLY_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Tally API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    // 첫 페이지에서 질문 매핑 저장
    if (page === 1 && data.questions) {
      questionMap = {};
      data.questions.forEach(q => {
        questionMap[q.id] = q.title;
      });
      console.log('Question map:', questionMap);
    }

    allSubmissions = allSubmissions.concat(data.submissions || []);
    hasMore = data.hasMore || false;
    page++;
  }

  console.log('Total submissions loaded:', allSubmissions.length);

  // 데이터 보정 적용
  allSubmissions = applyDataCorrections(allSubmissions);

  // 제외 사번 필터링
  if (EXCLUDED_MEMBERS.length > 0) {
    const before = allSubmissions.length;
    allSubmissions = allSubmissions.filter(sub => {
      const memberId = Number(getFieldValue(sub, '본인 사번'));
      return !EXCLUDED_MEMBERS.includes(memberId);
    });
    const removed = before - allSubmissions.length;
    if (removed > 0) console.log(`[제외 사번] ${removed}건 제외됨`);
  }

  // 사번 감지 및 알람 (VALID_MEMBERS 목록이 설정된 경우에만)
  if (VALID_MEMBERS.length > 0) {
    for (const sub of allSubmissions) {
      const memberId = Number(getFieldValue(sub, '본인 사번'));
      if (!memberId || memberId <= 0) continue;
      const submittedAt = sub.submittedAt ? sub.submittedAt.substring(0, 10) : '날짜불명';
      if (VALID_MEMBERS.includes(memberId)) {
        sendMemberSubmitAlert(memberId, submittedAt);
      } else if (!EXCLUDED_MEMBERS.includes(memberId)) {
        console.log(`[사번 알람] 미등록 사번 발견: ${memberId} (${submittedAt})`);
        sendUnknownMemberAlert(memberId, submittedAt);
      }
    }
  }

  return allSubmissions;
}

// 제출 데이터에서 필드 값 추출
function getFieldValue(submission, fieldName) {
  if (!submission.responses) return null;

  // questionMap에서 해당 fieldName의 questionId 찾기
  const questionId = Object.keys(questionMap).find(id => questionMap[id] === fieldName);
  if (!questionId) return null;

  const response = submission.responses.find(r => r.questionId === questionId);
  if (!response) return null;

  return response.answer;
}

// Tally 제출 시 사번 확인 엔드포인트 (Make.com에서 호출)
// Make.com에서 Tally 제출 데이터의 사번을 body.memberId로 전달
app.post('/api/check-new-submission', async (req, res) => {
  try {
    console.log(`[트리거] raw body:`, JSON.stringify(req.body));
    const memberId = Number(req.body.memberId);
    const submittedAt = req.body.submittedAt || new Date().toISOString().substring(0, 10);

    console.log(`[트리거] Tally 제출 감지 → 사번: ${memberId}, type: ${typeof req.body.memberId}`);

    if (!memberId || memberId <= 0) {
      return res.json({ success: true, memberId, status: '무효', submittedAt });
    }

    let status = '알수없음';
    if (VALID_MEMBERS.includes(memberId)) {
      status = '등록';
    } else if (EXCLUDED_MEMBERS.includes(memberId)) {
      status = '제외';
    } else {
      status = '미등록';
    }

    const memberName = getMemberName(memberId);
    console.log(`[트리거] 사번 ${memberId} (${memberName}), 상태: ${status}`);
    res.json({ success: true, memberId, memberName, status, submittedAt });
  } catch (error) {
    console.error('[트리거] 확인 실패:', error);
    res.status(500).json({ error: 'Failed to check submissions' });
  }
});

// 사번 목록 조회 API
app.get('/api/members', async (req, res) => {
  try {
    const submissions = await fetchAllSubmissions();

    // 중복 제거된 사번 목록
    const ids = [...new Set(
      submissions
        .map(sub => getFieldValue(sub, '본인 사번'))
        .filter(num => num !== null && num !== undefined && num > 0)
    )].sort((a, b) => a - b);

    // 사번 + 이름 + 지점 함께 반환
    const members = ids.map(id => ({
      id,
      name: getMemberName(id),
      branch: MEMBER_BRANCH[id] || null
    }));

    // 지점 목록도 반환
    const branches = Object.entries(BRANCHES).map(([key, b]) => ({
      key,
      name: b.name,
      memberCount: b.members.length
    }));

    res.json({ members, branches });
  } catch (error) {
    console.error('Error fetching members:', error);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

// Activity 데이터 조회 API
app.get('/api/activity', async (req, res) => {
  try {
    const { memberId, startDate, endDate, branch } = req.query;

    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const memberIdNum = parseInt(memberId);

    let allSubmissions = await fetchAllSubmissions();

    // 날짜 필터: branchStats 계산에도 동일하게 적용하기 위해 먼저 분리
    let dateFiltered = allSubmissions;
    if (startDate && DATE_RE.test(startDate)) {
      dateFiltered = dateFiltered.filter(sub => {
        const date = getFieldValue(sub, '날짜');
        return date && date >= startDate;
      });
    }
    if (endDate && DATE_RE.test(endDate)) {
      dateFiltered = dateFiltered.filter(sub => {
        const date = getFieldValue(sub, '날짜');
        return date && date <= endDate;
      });
    }

    // branchStats는 날짜 필터만 적용된 전체 데이터 기반 계산 (branch/memberId 필터 미적용)
    // 지점 탭 선택 시에도 지점 비교 카드가 정상 표시되도록 하기 위함
    const branchBaseSubmissions = dateFiltered;

    let submissions = dateFiltered;

    // 지점 필터 적용 (퍼널/랭킹에만 반영)
    if (branch && BRANCHES[branch]) {
      const branchMembers = BRANCHES[branch].members;
      submissions = submissions.filter(sub => {
        const id = Number(getFieldValue(sub, '본인 사번'));
        return branchMembers.includes(id);
      });
    }

    // 사번 필터 적용 (퍼널/랭킹에만 반영)
    if (memberId && !isNaN(memberIdNum) && memberIdNum > 0) {
      submissions = submissions.filter(sub =>
        Number(getFieldValue(sub, '본인 사번')) === memberIdNum
      );
    }

    // 데이터 집계
    const totals = {
      TA: 0,
      OT: 0,
      MCS: 0,
      소개: 0,
      count: submissions.length
    };

    submissions.forEach(sub => {
      totals.TA += getFieldValue(sub, 'TA') || 0;
      totals.OT += getFieldValue(sub, 'OT') || 0;
      totals.MCS += getFieldValue(sub, 'MCS') || 0;
      totals.소개 += getFieldValue(sub, '소개 (사람수)') || 0;
    });

    // 전환율 계산
    const funnel = [
      {
        stage: 'TA',
        value: totals.TA,
        rate: 100
      },
      {
        stage: 'OT',
        value: totals.OT,
        rate: totals.TA > 0 ? ((totals.OT / totals.TA) * 100).toFixed(1) : 0
      },
      {
        stage: 'MCS',
        value: totals.MCS,
        rate: totals.TA > 0 ? ((totals.MCS / totals.TA) * 100).toFixed(1) : 0
      },
      {
        stage: '소개',
        value: totals.소개,
        rate: totals.TA > 0 ? ((totals.소개 / totals.TA) * 100).toFixed(1) : 0
      }
    ];

    // ============ 랭킹 계산 ============
    // 사번별 OT, MCS 합계 계산
    const memberStats = {};
    submissions.forEach(sub => {
      const subMemberId = getFieldValue(sub, '본인 사번');
      if (!subMemberId) return;

      if (!memberStats[subMemberId]) {
        memberStats[subMemberId] = { OT: 0, MCS: 0 };
      }
      memberStats[subMemberId].OT += getFieldValue(sub, 'OT') || 0;
      memberStats[subMemberId].MCS += getFieldValue(sub, 'MCS') || 0;
    });

    // 랭킹 추출 함수 (동률 처리)
    function getRanking(stats, field) {
      const entries = Object.entries(stats)
        .map(([id, data]) => ({ memberId: parseInt(id), value: data[field] }))
        .filter(e => e.value > 0)
        .sort((a, b) => b.value - a.value);

      if (entries.length === 0) return { first: [], second: [] };

      const firstValue = entries[0].value;
      const first = entries.filter(e => e.value === firstValue);

      // 1등 다음으로 높은 값 찾기
      const secondEntries = entries.filter(e => e.value < firstValue);
      if (secondEntries.length === 0) return { first, second: [] };

      const secondValue = secondEntries[0].value;
      const second = secondEntries.filter(e => e.value === secondValue);

      return { first, second };
    }

    const otRanking = getRanking(memberStats, 'OT');
    const mcsRanking = getRanking(memberStats, 'MCS');

    // ============ 지점별 통계 ============
    // branchBaseSubmissions: 날짜 필터만 적용된 전체 데이터
    // branch/memberId 필터와 무관하게 지점 비교 카드를 항상 정상 표시하기 위함
    // O(submissions) 단일 순회로 모든 지점 집계 (이전: O(branches * submissions))
    const branchStats = {};
    for (const [key, branchInfo] of Object.entries(BRANCHES)) {
      branchStats[key] = {
        name: branchInfo.name,
        memberCount: branchInfo.members.length,
        totals: { TA: 0, OT: 0, MCS: 0, 소개: 0, count: 0 },
        funnel: []
      };
    }
    for (const sub of branchBaseSubmissions) {
      const id = Number(getFieldValue(sub, '본인 사번'));
      const branchKey = MEMBER_BRANCH[id];
      if (!branchKey || !branchStats[branchKey]) continue;
      const bt = branchStats[branchKey].totals;
      bt.TA    += getFieldValue(sub, 'TA') || 0;
      bt.OT    += getFieldValue(sub, 'OT') || 0;
      bt.MCS   += getFieldValue(sub, 'MCS') || 0;
      bt.소개  += getFieldValue(sub, '소개 (사람수)') || 0;
      bt.count += 1;
    }
    for (const key of Object.keys(branchStats)) {
      const bt = branchStats[key].totals;
      branchStats[key].funnel = [
        { stage: 'TA',   value: bt.TA,   rate: 100 },
        { stage: 'OT',   value: bt.OT,   rate: bt.TA > 0 ? ((bt.OT  / bt.TA) * 100).toFixed(1) : 0 },
        { stage: 'MCS',  value: bt.MCS,  rate: bt.TA > 0 ? ((bt.MCS / bt.TA) * 100).toFixed(1) : 0 },
        { stage: '소개', value: bt.소개, rate: bt.TA > 0 ? ((bt.소개 / bt.TA) * 100).toFixed(1) : 0 }
      ];
    }

    res.json({
      totals,
      funnel,
      recordCount: submissions.length,
      ranking: {
        OT: otRanking,
        MCS: mcsRanking
      },
      branchStats
    });
  } catch (error) {
    console.error('Error fetching activity:', error);
    res.status(500).json({ error: 'Failed to fetch activity data' });
  }
});

// ============ 칸반보드 API ============

// 칸반 데이터 조회 (누구나 가능)
app.get('/api/kanban', (req, res) => {
  res.json(kanbanData);
});

// 비밀번호 확인 미들웨어
function checkPassword(req, res, next) {
  const { password } = req.body;
  if (password !== KANBAN_PASSWORD) {
    return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
  }
  next();
}

// 카드 추가 (최대 3개 제한)
const MAX_CARDS = 3;

app.post('/api/kanban/card', checkPassword, (req, res) => {
  const { columnId, title, content } = req.body;

  const column = kanbanData.columns.find(c => c.id === columnId);
  if (!column) {
    return res.status(400).json({ error: '잘못된 컬럼입니다.' });
  }

  // 최대 카드 수 체크
  if (column.cards.length >= MAX_CARDS) {
    return res.status(400).json({ error: `공지는 최대 ${MAX_CARDS}개까지만 등록할 수 있습니다.` });
  }

  const newCard = {
    id: Date.now().toString(),
    title: title || '새 공지',
    content: content || '',
    createdAt: new Date().toISOString()
  };

  column.cards.push(newCard);
  saveKanbanData();

  res.json({ success: true, card: newCard });
});

// 카드 수정
app.put('/api/kanban/card/:cardId', checkPassword, (req, res) => {
  const { cardId } = req.params;
  const { title, content } = req.body;

  for (const column of kanbanData.columns) {
    const card = column.cards.find(c => c.id === cardId);
    if (card) {
      if (title !== undefined) card.title = title;
      if (content !== undefined) card.content = content;
      card.updatedAt = new Date().toISOString();
      saveKanbanData();
      return res.json({ success: true, card });
    }
  }

  res.status(404).json({ error: '카드를 찾을 수 없습니다.' });
});

// 카드 삭제
app.delete('/api/kanban/card/:cardId', (req, res) => {
  const { cardId } = req.params;
  const { password } = req.body;

  if (password !== KANBAN_PASSWORD) {
    return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
  }

  for (const column of kanbanData.columns) {
    const index = column.cards.findIndex(c => c.id === cardId);
    if (index !== -1) {
      column.cards.splice(index, 1);
      saveKanbanData();
      return res.json({ success: true });
    }
  }

  res.status(404).json({ error: '카드를 찾을 수 없습니다.' });
});

// 카드 이동 (컬럼 간 이동)
app.post('/api/kanban/move', checkPassword, (req, res) => {
  const { cardId, fromColumnId, toColumnId, newIndex } = req.body;

  const fromColumn = kanbanData.columns.find(c => c.id === fromColumnId);
  const toColumn = kanbanData.columns.find(c => c.id === toColumnId);

  if (!fromColumn || !toColumn) {
    return res.status(400).json({ error: '잘못된 컬럼입니다.' });
  }

  const cardIndex = fromColumn.cards.findIndex(c => c.id === cardId);
  if (cardIndex === -1) {
    return res.status(404).json({ error: '카드를 찾을 수 없습니다.' });
  }

  const [card] = fromColumn.cards.splice(cardIndex, 1);
  toColumn.cards.splice(newIndex !== undefined ? newIndex : toColumn.cards.length, 0, card);
  saveKanbanData();

  res.json({ success: true });
});

// 메인 페이지
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

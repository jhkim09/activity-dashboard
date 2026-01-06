const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const TALLY_API_KEY = process.env.TALLY_API_KEY;
const FORM_ID = 'ob9Bkx';

// 칸반보드 비밀번호
const KANBAN_PASSWORD = process.env.KANBAN_PASSWORD || 'rkdska1';

// 칸반 데이터 저장소 (메모리 + 파일)
const KANBAN_FILE = path.join(__dirname, 'kanban-data.json');
let kanbanData = {
  columns: [
    { id: 'important', title: '🔴 중요 공지', cards: [] },
    { id: 'general', title: '🟡 일반 공지', cards: [] },
    { id: 'done', title: '✅ 완료', cards: [] }
  ]
};

// 파일에서 칸반 데이터 로드
function loadKanbanData() {
  try {
    if (fs.existsSync(KANBAN_FILE)) {
      const data = fs.readFileSync(KANBAN_FILE, 'utf8');
      kanbanData = JSON.parse(data);
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
app.use(express.static('public'));

// 질문 ID를 라벨로 매핑
let questionMap = {};

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

// 사번 목록 조회 API
app.get('/api/members', async (req, res) => {
  try {
    const submissions = await fetchAllSubmissions();

    // 중복 제거된 사번 목록
    const members = [...new Set(
      submissions
        .map(sub => getFieldValue(sub, '본인 사번'))
        .filter(num => num !== null && num !== undefined && num > 0)
    )].sort((a, b) => a - b);

    res.json({ members });
  } catch (error) {
    console.error('Error fetching members:', error);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

// Activity 데이터 조회 API
app.get('/api/activity', async (req, res) => {
  try {
    const { memberId, startDate, endDate } = req.query;

    let submissions = await fetchAllSubmissions();

    // 필터 적용
    if (memberId) {
      submissions = submissions.filter(sub =>
        getFieldValue(sub, '본인 사번') === parseInt(memberId)
      );
    }

    if (startDate) {
      submissions = submissions.filter(sub => {
        const date = getFieldValue(sub, '날짜');
        return date && date >= startDate;
      });
    }

    if (endDate) {
      submissions = submissions.filter(sub => {
        const date = getFieldValue(sub, '날짜');
        return date && date <= endDate;
      });
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

    res.json({
      totals,
      funnel,
      recordCount: submissions.length
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

// 카드 추가
app.post('/api/kanban/card', checkPassword, (req, res) => {
  const { columnId, title, content } = req.body;

  const column = kanbanData.columns.find(c => c.id === columnId);
  if (!column) {
    return res.status(400).json({ error: '잘못된 컬럼입니다.' });
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

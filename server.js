const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const TALLY_API_KEY = process.env.TALLY_API_KEY;
const FORM_ID = 'ob9Bkx';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Tally API에서 모든 제출 데이터 가져오기
async function fetchAllSubmissions() {
  let allSubmissions = [];
  let page = 1;
  let hasMore = true;

  console.log('TALLY_API_KEY exists:', !!TALLY_API_KEY);
  console.log('TALLY_API_KEY prefix:', TALLY_API_KEY ? TALLY_API_KEY.substring(0, 8) : 'none');

  while (hasMore) {
    const url = `https://api.tally.so/forms/${FORM_ID}/submissions?page=${page}`;
    console.log('Fetching:', url);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${TALLY_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('Response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Error response:', errorText);
      throw new Error(`Tally API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('Data received, count:', data.submissions?.length || 0);
    if (page === 1 && data.submissions?.length > 0) {
      console.log('First submission keys:', Object.keys(data.submissions[0]));
      console.log('First submission sample:', JSON.stringify(data.submissions[0]).substring(0, 800));
    }
    allSubmissions = allSubmissions.concat(data.submissions || []);

    hasMore = data.hasMore || false;
    page++;
  }

  return allSubmissions;
}

// 제출 데이터에서 필드 값 추출
function getFieldValue(submission, fieldName) {
  const field = submission.fields.find(f => f.label === fieldName);
  if (!field) return null;

  if (field.type === 'INPUT_DATE') {
    return field.value; // YYYY-MM-DD 형식
  }
  if (field.type === 'INPUT_NUMBER') {
    return parseInt(field.value) || 0;
  }
  return field.value;
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

// 메인 페이지
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

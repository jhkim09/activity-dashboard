const express = require('express');
const { Client } = require('@notionhq/client');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Notion 클라이언트 초기화
const notion = new Client({
  auth: process.env.NOTION_API_KEY
});

const DATABASE_ID = process.env.NOTION_DATABASE_ID;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 사번 목록 조회 API
app.get('/api/members', async (req, res) => {
  try {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      page_size: 100
    });

    // 중복 제거된 사번 목록
    const members = [...new Set(
      response.results
        .map(page => page.properties['본인 사번']?.number)
        .filter(num => num !== null && num !== undefined)
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

    // 필터 조건 생성
    const filters = [];

    if (memberId) {
      filters.push({
        property: '본인 사번',
        number: { equals: parseInt(memberId) }
      });
    }

    if (startDate) {
      filters.push({
        property: '날짜',
        date: { on_or_after: startDate }
      });
    }

    if (endDate) {
      filters.push({
        property: '날짜',
        date: { on_or_before: endDate }
      });
    }

    const queryOptions = {
      database_id: DATABASE_ID,
      page_size: 100
    };

    if (filters.length > 0) {
      queryOptions.filter = filters.length === 1
        ? filters[0]
        : { and: filters };
    }

    // 페이지네이션 처리하여 모든 데이터 가져오기
    let allResults = [];
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
      const response = await notion.databases.query({
        ...queryOptions,
        start_cursor: startCursor
      });

      allResults = allResults.concat(response.results);
      hasMore = response.has_more;
      startCursor = response.next_cursor;
    }

    // 데이터 집계
    const totals = {
      TA: 0,
      OT: 0,
      MCS: 0,
      소개: 0,
      count: allResults.length
    };

    allResults.forEach(page => {
      const props = page.properties;
      totals.TA += props['TA']?.number || 0;
      totals.OT += props['OT']?.number || 0;
      totals.MCS += props['MCS']?.number || 0;
      totals.소개 += props['소개 (사람수)']?.number || 0;
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
      recordCount: allResults.length
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

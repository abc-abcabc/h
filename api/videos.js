// Vercel 서버리스 함수: 유튜브 경제·정치 인기 영상 조회
// 환경변수 YOUTUBE_API_KEY 가 필요합니다.

const API = 'https://www.googleapis.com/youtube/v3';

// 주제별 설정
// - news: 유튜브 공식 '뉴스/정치' 카테고리 인기 급상승 차트 (호출당 1단위, 저렴 → 10분 캐시)
// - economy / politics: 최근 48시간 내 업로드된 영상을 키워드로 검색해 조회수순 정렬
//   (검색은 호출당 100단위로 비싸므로 60분 캐시)
const TOPICS = {
  news: { mode: 'chart', categoryId: '25', cache: 600 },
  economy: {
    mode: 'search',
    // 유튜브 API의 OR 연산자는 공백이 포함된 ' | ' 형식을 권장합니다.
    // 제목에 '경제' 단어가 없어도 잡히도록 주요 경제/증시 채널 키워드도 포함합니다.
    q: '경제 | 주식 | 증시 | 부동산 | 금리 | 환율 | 코스피 | 재테크 | 삼프로 | 슈카월드 | 한국경제TV',
    cache: 3600,
  },
  politics: {
    mode: 'search',
    q: '정치 | 국회 | 대통령 | 여당 | 야당 | 선거 | 국정감사 | 뉴스속보',
    cache: 3600,
  },
};

const SHORTS_MAX_SEC = 180;

function parseDuration(iso) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
  if (!m) return 0;
  const [, d, h, mi, s] = m.map((v) => Number(v) || 0);
  return d * 86400 + h * 3600 + mi * 60 + s;
}

async function yt(path, params, key) {
  const url = new URL(`${API}/${path}`);
  Object.entries({ ...params, key }).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url);
  const data = await r.json();
  if (!r.ok) {
    const msg = data?.error?.message || `YouTube API 오류 (${r.status})`;
    const err = new Error(msg);
    err.status = r.status;
    err.reason = data?.error?.errors?.[0]?.reason;
    throw err;
  }
  return data;
}

async function getVideoIds(topic, key) {
  if (topic.mode === 'chart') return null; // 차트는 videos.list 한 번으로 끝
  const publishedAfter = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const data = await yt(
    'search',
    {
      part: 'id',
      type: 'video',
      q: topic.q,
      order: 'viewCount',
      regionCode: 'KR',
      relevanceLanguage: 'ko',
      publishedAfter,
      maxResults: '50',
    },
    key
  );
  const rawIds = data.items?.map((i) => i.id?.videoId).filter(Boolean) || [];
  return [...new Set(rawIds)];
}

async function getVideos(topic, key) {
  const common = { part: 'snippet,statistics,contentDetails', hl: 'ko' };
  let data;
  if (topic.mode === 'chart') {
    data = await yt(
      'videos',
      { ...common, chart: 'mostPopular', regionCode: 'KR', videoCategoryId: topic.categoryId, maxResults: '50' },
      key
    );
  } else {
    const ids = await getVideoIds(topic, key);
    if (!ids.length) return [];
    data = await yt('videos', { ...common, id: ids.join(',') }, key);
  }

  const now = Date.now();
  return (data.items || [])
    .filter((v) => v.snippet?.liveBroadcastContent !== 'upcoming') // 시작 전인 대기 라이브는 제외
    .map((v) => {
      const seconds = parseDuration(v.contentDetails?.duration);
      const views = Number(v.statistics?.viewCount || 0);
      const publishedAt = v.snippet?.publishedAt;
      // 시간당 조회수 계산 시 최소 1시간으로 완화하여 막 올라온 영상의 이상치 방지
      const hours = Math.max((now - new Date(publishedAt).getTime()) / 3600000, 1.0);
      const thumbs = v.snippet?.thumbnails || {};
      const title = v.snippet?.title || '';
      const desc = v.snippet?.description || '';
      const isLive = v.snippet?.liveBroadcastContent === 'live';

      // 쇼츠 판별 정밀화:
      // 1) 제목이나 설명에 #shorts, #short, #쇼츠가 포함된 경우 3분(180초) 이하이면 쇼츠
      // 2) 태그가 없는 경우 60초 이하인 초단편 영상만 쇼츠로 분류 (1~3분 가로 뉴스 리포트 오분류 방지)
      const hasShortsTag = /#shorts?|#쇼츠/i.test(`${title} ${desc}`);
      const isShort = !isLive && (hasShortsTag ? (seconds > 0 && seconds <= SHORTS_MAX_SEC) : (seconds > 0 && seconds <= 60));

      return {
        id: v.id,
        title,
        channel: v.snippet?.channelTitle,
        publishedAt,
        thumbnail: (thumbs.maxres || thumbs.high || thumbs.medium || thumbs.default || {}).url,
        seconds,
        isLive,
        isShort,
        views,
        likes: Number(v.statistics?.likeCount || 0),
        comments: Number(v.statistics?.commentCount || 0),
        viewsPerHour: Math.round(views / hours),
      };
    });
}

export default async function handler(req, res) {
  const key = process.env.YOUTUBE_API_KEY;
  const topicName = String(req.query?.topic || 'news');
  const topic = TOPICS[topicName];

  if (!topic) {
    return res.status(400).json({ error: `알 수 없는 주제: ${topicName}` });
  }
  if (!key) {
    return res.status(500).json({
      error: 'YOUTUBE_API_KEY 환경변수가 설정되지 않았어요. Vercel 프로젝트 설정에서 추가해 주세요.',
    });
  }

  try {
    const videos = await getVideos(topic, key);
    res.setHeader('Cache-Control', `s-maxage=${topic.cache}, stale-while-revalidate=${topic.cache * 2}`);
    return res.status(200).json({
      topic: topicName,
      fetchedAt: new Date().toISOString(),
      cacheSeconds: topic.cache,
      videos,
    });
  } catch (e) {
    const quota = e.reason === 'quotaExceeded' || e.reason === 'dailyLimitExceeded';
    return res.status(e.status || 500).json({
      error: quota ? '오늘 유튜브 API 사용량을 모두 썼어요. 한국시간 오후 4~5시경 초기화됩니다.' : e.message,
    });
  }
}

export { parseDuration, getVideos, TOPICS };

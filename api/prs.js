import axios from "axios";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO;
const TRIGGER_SECRET = process.env.TRIGGER_SECRET;

async function getPullRequests() {
  let allPRs = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const res = await axios.get(`https://api.github.com/repos/${REPO}/pulls`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` },
      params: { state: "open", per_page: perPage, page },
    });
    allPRs = allPRs.concat(res.data);
    if (res.data.length < perPage) break;
    page++;
  }

  return allPRs;
}

export default async function handler(req, res) {
  console.log(`[PRS] ${new Date().toISOString()} - prs.js 실행됨`);

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Secret 검증
  const incomingSecret =
    req.headers["x-trigger-secret"] || req.query?.secret || req.body?.secret;
  if (!TRIGGER_SECRET || incomingSecret !== TRIGGER_SECRET) {
    console.warn(`[PRS] Unauthorized request - invalid secret`);
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const prs = await getPullRequests();

    if (prs.length === 0) {
      return res
        .status(200)
        .json({ prs: [], message: "열려있는 PR이 없습니다." });
    }

    // PR 번호를 앞에 포함한 단순 문자열 배열로 반환
    // 형식: "123 | #123 PR제목 (head → base)"
    // deploy.js에서 | 앞의 숫자로 PR 번호 파싱
    const items = prs.map(
      (pr) =>
        `${pr.number} | #${pr.number} ${pr.title} (${pr.head.ref} → ${pr.base.ref})`,
    );

    console.log(`[PRS] Returning ${items.length} PRs`);
    return res.status(200).json(items);
  } catch (error) {
    console.error(`[PRS] Error:`, error.message);
    return res.status(500).json({ error: error.message });
  }
}
